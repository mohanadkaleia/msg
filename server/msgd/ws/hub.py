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
import time
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, cast

from sqlalchemy import literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.core.envelope import Envelope
from msgd.db.engine import get_session
from msgd.db.models import Stream
from msgd.events.permissions import readable_streams_predicate
from msgd.ws.frames import (
    event_frame,
    prefs_frame,
    presence_frame,
    read_state_frame,
    typing_frame,
)
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

#: Inbound-``typing`` anti-spam window (ENG-125, D3): at most one relayed typing
#: signal per user per this interval. A frame arriving inside the window is dropped
#: BEFORE the ``can_read`` DB check, so a spammer cannot hammer the resolver — the
#: gate query is bounded by this throttle. ~1/3 s ≈ 3 signals/s is ample for a
#: "still typing" heartbeat while capping abuse. Per-user (not per-connection) so a
#: multi-device user cannot multiply the rate; the small ``{user_id -> monotonic}``
#: map is bounded (cleaned when the user goes fully offline — see :meth:`deregister`).
_TYPING_THROTTLE_SECONDS: float = 1.0 / 3.0


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
        #: Per-user last-relayed-typing monotonic timestamp (the D3 anti-spam
        #: throttle). In-memory only — like presence, typing state is NEVER
        #: persisted. Bounded: an entry is dropped when the user goes fully offline.
        self._typing_last: dict[str, float] = {}

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
        self._typing_last.clear()
        self._session_factory = _production_session_scope

    # --- registry -------------------------------------------------------------

    def try_register(self, connection: Connection, *, max_connections: int) -> bool:
        """Register a connection unless the user is at the cap (§5)."""
        return self._registry.try_add(connection, max_connections=max_connections)

    def deregister(self, connection: Connection) -> None:
        """Remove a connection (the router's ``finally``; also the send-failure path).

        When this drops the user's LAST socket, evict their typing-throttle entry so
        the in-memory ``{user_id -> …}`` map cannot grow unbounded (D3: no leak). The
        1→0 presence-offline relay itself is driven by the async router, which
        re-checks :meth:`is_online` after this returns (deregister is sync).
        """
        self._registry.remove(connection)
        if not self._registry.is_online(connection.user_id):
            self._typing_last.pop(connection.user_id, None)

    def is_online(self, user_id: str) -> bool:
        """True iff ``user_id`` holds ≥1 live socket — DERIVED presence (D3).

        The router samples this before ``try_register`` and after ``deregister`` to
        detect the 0→1 / 1→0 transitions that drive the presence relay. There is no
        presence table: online-ness is purely the live registry, re-derived on
        reconnect with zero persistence.
        """
        return self._registry.is_online(user_id)

    def connection_count(self) -> int:
        """Total live connections — the thin metrics hook (§5, no Prometheus here)."""
        return self._registry.total()

    def allow_typing(self, user_id: str) -> bool:
        """Consume one token of the per-user typing throttle (D3 anti-spam).

        Returns ``True`` (and records ``now``) iff no relayed typing signal from
        ``user_id`` fell inside the last ``_TYPING_THROTTLE_SECONDS``; otherwise
        ``False`` (drop the frame, silently — no error, no oracle). Checked in the
        router BEFORE the ``can_read`` DB gate so a spammer cannot force the resolver
        to run faster than the throttle. Monotonic clock — immune to wall-clock skew.
        """
        now = time.monotonic()
        last = self._typing_last.get(user_id)
        if last is not None and now - last < _TYPING_THROTTLE_SECONDS:
            return False
        self._typing_last[user_id] = now
        return True

    # --- fanout (§3 resolve + §4 send) ---------------------------------------

    async def publish(self, envelope: Envelope) -> None:
        """Resolve recipients per-send and push the event frame to each (the seam)."""
        recipients = await self._resolve_readers(
            workspace_id=envelope.body.workspace_id, stream_id=envelope.body.stream_id
        )
        if not recipients:
            return
        frame = event_frame(envelope)
        await self._send_all(recipients, frame)

    async def publish_presence(self, *, user_id: str, workspace_id: str, status: str) -> None:
        """Relay a ``presence`` frame for ``user_id`` to their SAME-workspace NON-GUEST peers (D3).

        Presence is the D3 **ephemeral** class — WS-only, never persisted, projected,
        or exported. The router calls this best-effort on ``user_id``'s 0→1
        (``online``) and 1→0 (``offline``) connection transitions (presence is
        DERIVED from the live registry, not stored). Scope = the workspace's NON-GUEST
        roster: every OTHER connection whose ``workspace_id`` matches AND whose
        ``role != "guest"`` receives the frame, so connected members observe each
        other's presence — coarse, standard, and cross-workspace-ISOLATED
        (``workspace_id`` rides on the Connection, so this is a pure in-memory
        registry filter with NO DB round trip, and a different workspace's socket is
        structurally never selected). The subject's own sockets are excluded (a
        client does not need to hear about itself).

        Guest exclusion (ENG-125 follow-up, §3.6 roster-consistency): a guest socket
        is NEVER selected as a recipient here, and the router additionally skips this
        relay entirely for a guest subject (a guest's connect/disconnect broadcasts
        NO presence). Presence is a workspace-ROSTER signal — an opaque ``user_id`` +
        online bit for members across the workspace — exactly the roster
        ``permissions.py`` deliberately withholds from guests: a guest is a member
        with restricted scope and does NOT receive the ``workspace-meta`` roster
        stream (the FLAGGED DEVIATION in ``readable_streams_predicate``). Relaying
        presence to/from guests would leak that same roster sliver, so presence is
        scoped out of guests just like ``workspace-meta``. (Typing is UNCHANGED — it
        is stream-membership-scoped via ``readable_streams_predicate``, so a guest
        still gets/sends typing in streams they explicitly joined.)

        Delivery is a hint (§3.3): :meth:`_send_all` timeout-guards + drops a wedged
        socket without propagating, so a relay failure can NEVER break the connection
        lifecycle. No eligible same-workspace peer connected is a no-op.
        """
        recipients = [
            conn
            for uid, conns in self._registry.snapshot().items()
            if uid != user_id
            for conn in conns
            if conn.workspace_id == workspace_id and conn.role != "guest"
        ]
        if not recipients:
            return
        await self._send_all(recipients, presence_frame(user_id=user_id, status=status))

    async def publish_typing(
        self, *, sender_user_id: str, workspace_id: str, stream_id: str
    ) -> None:
        """Relay a ``typing`` frame to the stream's OTHER connected readers (D3).

        Typing is the D3 **ephemeral** class — WS-only, never persisted, projected,
        or exported. Recipient resolution reuses :meth:`_resolve_readers` — the
        EXACT same live ``readable_streams_predicate`` event fanout uses — so typing
        scoping cannot diverge from read scoping. The **permission gate IS that
        resolve**: the sender is connected (they sent the frame), so they appear in
        the readable set iff they can ``can_read`` the stream; if they do NOT appear,
        the frame is dropped with no relay and no error (no oracle — a non-reader
        never learns the stream exists). Otherwise the frame goes to every readable
        connection EXCLUDING the sender's own sockets (you don't show yourself
        typing) and never across a workspace (the resolver already filtered by
        ``workspace_id``). TTL (~5 s) is a pure client concern — the server only
        relays. Delivery is a hint (per-socket timeout + drop). No other reader is a
        no-op. The caller rate-limits via :meth:`allow_typing` before this runs.
        """
        recipients = await self._resolve_readers(workspace_id=workspace_id, stream_id=stream_id)
        # Permission gate == the fanout predicate: the sender can read the stream iff
        # one of the resolved readers is the sender. If not, drop (no oracle).
        if not any(conn.user_id == sender_user_id for conn in recipients):
            return
        others = [conn for conn in recipients if conn.user_id != sender_user_id]
        if not others:
            return
        await self._send_all(others, typing_frame(stream_id=stream_id, user_id=sender_user_id))

    async def publish_read_state(self, *, user_id: str, stream_id: str, last_read_seq: int) -> None:
        """Echo a ``read_state`` frame to EVERY connection of ``user_id`` — and no one else (D3).

        The read-state message class is **synced per-user KV**, not an event: this is
        NOT the permission-scoped event fanout. Recipient resolution is a DIRECT
        ``_by_user[user_id]`` lookup (:meth:`Registry.connections_for`) — no stream
        readability resolve, no DB round trip — so the echo reaches EXACTLY the
        marker-owner's other devices and structurally cannot reach any other user.
        Isolation crux: a different user's id is never looked up, so no other user
        ever observes another's read marker.

        ``PUT /v1/read-state`` calls this AFTER its authoritative commit, passing the
        EFFECTIVE (monotonic-``GREATEST``) ``last_read_seq``. Delivery is a hint
        (§3.3): the per-socket :meth:`_send_one` timeout-guards each push and drops +
        deregisters a wedged/dead socket without ever propagating — so a failed echo
        can never fail the PUT (the DB write is authoritative; the echo is
        convenience). No connected socket for the user is a no-op.
        """
        await self._publish_to_user(
            user_id, read_state_frame(stream_id=stream_id, last_read_seq=last_read_seq)
        )

    async def publish_prefs(self, *, user_id: str, stream_id: str, level: str) -> None:
        """Echo a ``prefs`` frame to EVERY connection of ``user_id`` — and no one else (D3).

        The SAME synced-per-user-KV same-user echo as :meth:`publish_read_state`,
        for the notification-pref message class (ENG-124): a DIRECT
        ``_by_user[user_id]`` lookup via :meth:`_publish_to_user`, never the
        permission-scoped event fanout, so the echo reaches EXACTLY the pref-owner's
        other devices and structurally cannot reach any other user.

        ``PUT /v1/prefs`` calls this AFTER its authoritative last-write-wins commit,
        passing the STORED ``level`` (``all`` / ``mentions`` / ``mute``). Delivery is
        a hint (§3.3): the per-socket send timeout-guards and drops a wedged socket
        without propagating, so a failed echo can never fail the PUT. No connected
        socket for the user is a no-op.
        """
        await self._publish_to_user(user_id, prefs_frame(stream_id=stream_id, level=level))

    async def _publish_to_user(self, user_id: str, frame: dict[str, Any]) -> None:
        """Best-effort push ``frame`` to EVERY live socket of ``user_id`` — and no one else.

        The shared same-user echo primitive behind :meth:`publish_read_state` and
        :meth:`publish_prefs` (D3 synced per-user KV). Recipient resolution is a
        DIRECT ``_by_user[user_id]`` lookup (:meth:`Registry.connections_for`) — no
        stream-readability resolve, no DB round trip — so the frame reaches exactly
        that user's own other devices and structurally cannot reach any other user
        (a different user's id is simply never looked up). Per-socket
        timeout-guarded + isolated by :meth:`_send_all`; no connected socket is a
        no-op. Keeps the typed public methods as the sole callers.
        """
        recipients = list(self._registry.connections_for(user_id))
        if not recipients:
            return
        await self._send_all(recipients, frame)

    # --- revocation close-signal (ENG-153) ------------------------------------

    async def disconnect_user(self, user_id: str, *, code: int, reason: str = "") -> None:
        """Force-close EVERY live socket of ``user_id`` (the ENG-153 close-signal).

        The revocation-enforcement teardown the snapshot caveat deferred: admin
        deactivation (``PATCH /v1/admin/members/{id}`` ``active:false``) calls this
        AFTER its transaction commits, so an already-open socket stops receiving
        fanout NOW instead of at its natural drop (and any reconnect race lands on
        the committed ``deactivated_at`` → the uniform pre-accept ``4401``).

        The user→sockets lookup mirrors :meth:`_publish_to_user` — a DIRECT
        ``_by_user[user_id]`` COPY (:meth:`Registry.connections_for`), so no other
        user's socket is ever selected and iteration is safe against concurrent
        registry mutation. Each socket is DEREGISTERED FIRST (synchronously — once
        out of the registry no further fanout can select it, even if its close
        wedges), then closed best-effort with per-socket isolation. No connected
        socket is a no-op. Single-process asyncio hub — no cross-process signaling.
        """
        await self._disconnect_all(
            self._registry.connections_for(user_id), code=code, reason=reason
        )

    async def disconnect_session(
        self, *, user_id: str, session_token_hash: str, code: int, reason: str = ""
    ) -> None:
        """Force-close exactly the sockets authenticated by ONE session (ENG-153).

        The ``DELETE /v1/auth/sessions/{id}`` parity case: the revoked session's
        socket(s) die, while the SAME user's other, still-valid sessions keep their
        sockets and their fanout (no over-close). ``session_token_hash`` is the
        session's sha256 token hash — the revoke endpoint's own path id, captured
        onto :class:`Connection` at connect. The lookup is scoped to
        ``connections_for(user_id)`` first (the revoke endpoint is owner-scoped, so
        the caller always knows the user), then filtered by exact hash match; a
        bot-token connection carries ``session_token_hash=None`` and can never
        match. Same deregister-first + best-effort close as :meth:`disconnect_user`.
        """
        matching = {
            conn
            for conn in self._registry.connections_for(user_id)
            if conn.session_token_hash is not None and conn.session_token_hash == session_token_hash
        }
        await self._disconnect_all(matching, code=code, reason=reason)

    async def _disconnect_all(
        self, connections: set[Connection], *, code: int, reason: str
    ) -> None:
        """Deregister then close ``connections`` — shared teardown primitive.

        Order is the security crux: EVERY socket leaves the registry synchronously
        (no ``await`` in the loop — under the single asyncio loop no fanout can
        interleave) BEFORE any close I/O, so a wedged or already-closing socket can
        delay only its own close frame, never its removal from fanout. The closes
        then run concurrently with per-socket isolation, mirroring
        :meth:`_send_all` — one bad socket cannot stall or fail the others, and the
        caller (a committed admin/auth request) never sees an exception from here.
        The router's own ``finally`` deregister is idempotent, and its 1→0
        offline-presence relay still runs when the closed socket's serve loop ends.
        """
        if not connections:
            return
        for conn in connections:
            self.deregister(conn)
        await asyncio.gather(
            *(self._close_one(conn, code=code, reason=reason) for conn in connections),
            return_exceptions=True,
        )

    async def _close_one(self, connection: Connection, *, code: int, reason: str) -> None:
        """Close one socket under the send timeout; swallow any failure.

        A socket already closing/disconnected raises from ``close`` — irrelevant,
        the registry removal already happened. Timeout-guarded like
        :meth:`_send_one` so a wedged close handshake cannot stall the caller.
        CancelledError is a BaseException and is intentionally NOT swallowed.
        """
        try:
            await asyncio.wait_for(
                connection.websocket.close(code=code, reason=reason),
                timeout=_SEND_TIMEOUT_SECONDS,
            )
        except Exception:  # noqa: S110 — best-effort close; deregistration already done
            pass

    async def _resolve_readers(self, *, workspace_id: str, stream_id: str) -> list[Connection]:
        """Return every connected socket whose user may currently read the stream.

        One ``EXISTS`` per **distinct** connected user in ``workspace_id``; users in
        another workspace are skipped without a query (§3b). The SINGLE shared
        stream-readable resolver behind BOTH event fanout (:meth:`publish`) and the
        typing relay (:meth:`publish_typing`), so the two can never diverge in scope.
        """
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
