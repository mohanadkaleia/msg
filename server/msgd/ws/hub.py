"""The process-global WebSocket hub: connection registry + permission-scoped fanout.

The :func:`msgd.events.fanout.publish_event` seam delegates here. On each newly
accepted event the hub resolves the recipient set **per-send against the live DB**
(the §3 central ruling) and pushes the wire frame to every eligible connected
socket, with per-socket error isolation and a per-send timeout (§4).

Why per-send DB resolution and no in-memory membership map (§3):

* It reuses the **one shared** ``readable_streams_predicate`` (permissions.py) that
  pull/search already use — a live ``EXISTS`` on ``stream_members`` — so fanout
  scoping cannot diverge from read scoping, and a removed member loses fanout on
  the **very next** event (instant revocation, zero cache-coherence code; §3.6,
  §12 invariant 4). The in-memory map is the documented post-M1 optimization.
* Delivery is a hint, not a guarantee (§3.3): a frame the predicate transiently
  mis-resolves during a membership race is simply a missed hint → the client
  re-pulls by cursor. That is what makes the simple live resolution safe.

Session acquisition (R1): the frozen seam carries no DB handle, so the hub owns an
**injectable** ``session_factory``. Production defaults to a fresh session from the
engine's process-wide sessionmaker (:func:`_production_session_scope`); the test
harness injects a factory yielding the bound, rolled-back per-test session so
fanout reads see the same transaction as the upload that triggered them.

Import-cycle note (R3): ``fanout.publish_event`` imports ``hub`` **function-locally**;
this module imports only ``events.permissions`` + ``core`` + ``db``, never
``events.fanout`` — a one-way edge, no cycle.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, cast

from sqlalchemy import literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.core.envelope import Envelope
from msgd.db.engine import get_session
from msgd.db.models import Stream
from msgd.events.permissions import readable_streams_predicate
from msgd.ws.frames import event_frame
from msgd.ws.registry import Connection, Registry

__all__ = ["Hub", "SessionFactory", "hub"]

#: Per-socket send timeout (§4): a wedged socket cannot stall the fan-out or the
#: post-commit tail of the accept request — its frame is dropped and it is
#: deregistered. ~3 s because a healthy in-loop ASGI send is sub-millisecond; sends
#: run concurrently under ``gather`` so the worst-case added tail is one timeout,
#: not N (security round 1, hardening note 1 — the documented single-worker fanout
#: ceiling, §4/§14). Promoting this to an operator-tunable ``Settings`` field is
#: deferred: the hub is intentionally settings-less (the frozen seam carries no app
#: handle), and the architectural fix is the post-M1 pub/sub layer.
_SEND_TIMEOUT_SECONDS: float = 3.0

#: A callable yielding a short-lived read session as an async context manager.
SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


@asynccontextmanager
async def _production_session_scope() -> AsyncIterator[AsyncSession]:
    """Yield a fresh session from the engine's process-wide sessionmaker (§3a).

    Reuses :func:`msgd.db.engine.get_session` (the exact sessionmaker the request
    dependency uses, installed by ``create_app``'s lifespan) so the post-commit
    fanout read runs in its own session and sees the just-committed event and the
    current membership. Read-only here — the hub never writes or commits.
    """
    # get_session is an async-generator function (annotated AsyncIterator); narrow
    # to AsyncGenerator so its GeneratorExit-driven cleanup (aclose) is reachable —
    # closing it exits the underlying ``async with sessionmaker()`` block.
    gen = cast(AsyncGenerator[AsyncSession, None], get_session())
    session = await anext(gen)
    try:
        yield session
    finally:
        await gen.aclose()


class Hub:
    """Registry owner + fanout engine. A single module-level instance (``hub``)."""

    def __init__(self, session_factory: SessionFactory | None = None) -> None:
        self._registry = Registry()
        self._session_factory: SessionFactory = session_factory or _production_session_scope

    # --- injectable session factory + test reset (R1/R2) ---------------------

    def set_session_factory(self, factory: SessionFactory) -> None:
        """Install the DB-session factory used for per-send resolution (R1)."""
        self._session_factory = factory

    def reset_for_tests(self) -> None:
        """Clear the registry and restore the production factory (R2, autouse).

        The hub is a process-global singleton with no app handle, so cross-test
        connection state must be cleared explicitly between tests.
        """
        self._registry.clear()
        self._session_factory = _production_session_scope

    # --- registry -------------------------------------------------------------

    def try_register(self, connection: Connection, *, max_connections: int) -> bool:
        """Register a connection unless the user is at the cap (§5)."""
        return self._registry.try_add(connection, max_connections=max_connections)

    def deregister(self, connection: Connection) -> None:
        """Remove a connection (the router's ``finally``; also the send-failure path)."""
        self._registry.remove(connection)

    def connection_count(self) -> int:
        """Total live connections — the thin metrics hook (§5, no Prometheus here)."""
        return self._registry.total()

    # --- fanout (§3 resolve + §4 send) ---------------------------------------

    async def publish(self, envelope: Envelope) -> None:
        """Resolve recipients per-send and push the event frame to each (the seam)."""
        recipients = await self._resolve(envelope)
        if not recipients:
            return
        frame = event_frame(envelope)
        await self._send_all(recipients, frame)

    async def _resolve(self, envelope: Envelope) -> list[Connection]:
        """Return every connected socket whose user may currently read the stream.

        One ``EXISTS`` per **distinct** connected user in the envelope's workspace;
        users in another workspace are skipped without a query (§3b).
        """
        stream_id = envelope.body.stream_id
        workspace_id = envelope.body.workspace_id
        by_user = self._registry.snapshot()
        if not by_user:
            return []

        recipients: list[Connection] = []
        async with self._session_factory() as session:
            for conns in by_user.values():
                # One representative carries the (identical) per-user identity.
                sample = next(iter(conns), None)
                if sample is None or sample.workspace_id != workspace_id:
                    continue
                if await self._user_can_read(session, identity=sample, stream_id=stream_id):
                    recipients.extend(conns)
        return recipients

    @staticmethod
    async def _user_can_read(
        session: AsyncSession, *, identity: Connection, stream_id: str
    ) -> bool:
        """True iff ``stream_id`` exists and is readable by ``identity`` right now.

        This is exactly ``permissions.can_read``'s body evaluated against the
        **same** shared ``readable_streams_predicate`` (a live ``EXISTS`` on
        ``stream_members``) that pull/search use — so WS fanout scoping cannot
        diverge from read scoping. It reads the connection identity's primitives
        directly rather than fabricating an ``AuthContext`` + detached ORM rows in
        the fanout path.
        """
        predicate = readable_streams_predicate(
            user_id=identity.user_id,
            role=identity.role,
            workspace_id=identity.workspace_id,
        )
        found = await session.scalar(
            select(literal(1)).select_from(Stream).where(Stream.stream_id == stream_id, predicate)
        )
        return found is not None

    async def _send_all(self, recipients: list[Connection], frame: dict[str, Any]) -> None:
        """Send concurrently with per-socket isolation (§4).

        ``gather(return_exceptions=True)`` over per-socket sends: one wedged or
        dead socket can neither stall the others nor propagate to the accept path.
        """
        await asyncio.gather(
            *(self._send_one(conn, frame) for conn in recipients),
            return_exceptions=True,
        )

    async def _send_one(self, connection: Connection, frame: dict[str, Any]) -> None:
        """Send one frame under a timeout; drop + deregister the socket on any failure."""
        try:
            await asyncio.wait_for(
                connection.websocket.send_json(frame), timeout=_SEND_TIMEOUT_SECONDS
            )
        except Exception:
            # Timeout / WebSocketDisconnect / any send error: drop this one frame
            # and schedule the socket's removal. Never propagate — the client will
            # re-pull (delivery is a hint, §3.3/§4). CancelledError is a
            # BaseException and is intentionally NOT swallowed here.
            self.deregister(connection)


#: The process-global hub the fanout seam and the WS router share (single worker).
hub = Hub()
