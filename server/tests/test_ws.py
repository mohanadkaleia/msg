"""``GET /v1/ws`` — hub, permission-scoped fanout, heartbeat (ENG-68 / M1, §3.3).

Driven with ``httpx-ws``'s ``aconnect_ws`` over an in-process WS-capable ASGI
transport in the test's own loop (§8), so WS auth + fanout resolution run against
the same rolled-back per-test transaction as the HTTP setup / batch calls. The
``ws_app`` fixture yields the configured app; each test enters
``make_ws_client(ws_app)`` in its own task (the transport's anyio task group must
be opened and closed in the same task — see the harness note).

The bearer token travels in ``Sec-WebSocket-Protocol: bearer, <token>`` (security
round 1 — off the URL), i.e. ``aconnect_ws(url, client=…, subprotocols=["bearer",
token])``; the server echoes ``bearer`` on accept.

httpx-ws surfaces a close code two ways: a **pre-accept** reject raises
``WebSocketDisconnect`` from ``aconnect_ws.__aenter__``; an **accept-then-close**
(or a mid-session server close) raises it from ``receive`` *inside* the ``async
with`` block. ``_connect_expect_close`` catches both. Disconnects must be caught
INSIDE the context manager or anyio re-wraps them in an ``ExceptionGroup``.
"""

from __future__ import annotations

import contextlib
import io
import logging
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest
from authutil import (
    accept_invite,
    auth_header,
    create_invite,
    do_login,
    do_setup,
    join_token,
    make_app,
)
from eventsutil import (
    bootstrap_channel,
    lifecycle_body,
    message_body,
    post_batch,
    wire_item,
)
from fastapi import FastAPI
from harness import bound_session_factory, make_ws_client
from httpx import AsyncClient
from httpx_ws import WebSocketDisconnect, aconnect_ws
from httpx_ws._api import AsyncWebSocketSession
from msgd.auth.tokens import hash_token
from msgd.core import ids
from msgd.core.envelope import Body, Envelope, ServerMetadata
from msgd.core.hashing import hash_event
from msgd.db.models import Session, User
from msgd.logging import RedactSecretsFilter
from msgd.settings import Settings
from msgd.ws.frames import WSCloseCode, event_frame
from msgd.ws.hub import hub
from msgd.ws.registry import Connection
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocket

# --- URL + socket helpers --------------------------------------------------------


_WS_URL = "http://test/v1/ws"


def _bearer(token: str) -> list[str]:
    """The ``Sec-WebSocket-Protocol`` value list for a bearer ``token``."""
    return ["bearer", token]


def _aconnect(
    client: AsyncClient, *, subprotocols: list[str] | None
) -> AbstractAsyncContextManager[AsyncWebSocketSession]:
    """Typed ``aconnect_ws`` wrapper — the token rides in ``subprotocols`` (off URL).

    Its session typevar is otherwise unbound, hence the cast.
    """
    return cast(
        "AbstractAsyncContextManager[AsyncWebSocketSession]",
        aconnect_ws(_WS_URL, client=client, subprotocols=subprotocols),
    )


async def _read_until(ws: AsyncWebSocketSession, t: str, *, timeout: float = 2.0) -> dict[str, Any]:
    """Receive frames until one with ``t`` arrives (skips heartbeat noise)."""
    while True:
        msg = await ws.receive_json(timeout=timeout)
        if isinstance(msg, dict) and msg.get("t") == t:
            return msg


async def _recv_event(ws: AsyncWebSocketSession, *, timeout: float = 2.0) -> dict[str, Any]:
    """Receive the next ``{"t": "event", …}`` fanout frame."""
    return await _read_until(ws, "event", timeout=timeout)


async def _sync(ws: AsyncWebSocketSession) -> None:
    """Ping/pong round-trip barrier: a pong proves the server finished registering.

    The receive loop only runs once ``_serve`` starts, which is *after*
    ``hub.try_register`` — so a returned pong guarantees this socket is in the
    registry before the test posts an event to fan out (defeats the accept↔register
    scheduling race).
    """
    await ws.send_json({"t": "ping"})
    await _read_until(ws, "pong")


async def _connect_expect_close(
    client: AsyncClient, subprotocols: list[str] | None, *, timeout: float = 2.0
) -> int:
    """Connect and return the close code, whether rejected pre-accept or after accept."""
    try:
        async with _aconnect(client, subprotocols=subprotocols) as ws:
            try:
                while True:
                    await ws.receive_json(timeout=timeout)
            except WebSocketDisconnect as exc:
                return exc.code
    except WebSocketDisconnect as exc:  # rejected during the handshake (pre-accept)
        return exc.code
    raise AssertionError("expected the socket to be closed")  # pragma: no cover


async def _invite_user(client: AsyncClient, owner: dict[str, Any], *, role: str) -> dict[str, Any]:
    """Create + accept an invite; return the new user's auth dict (token/ids/role)."""
    invite = await create_invite(client, owner["token"], role=role)
    raw = join_token(invite.json()["url"])
    accepted = await accept_invite(client, raw, email=f"{ids.new_ulid().lower()}@example.com")
    assert accepted.status_code == 200, accepted.text
    body: dict[str, Any] = accepted.json()
    return body


async def _member_event(
    client: AsyncClient,
    owner: dict[str, Any],
    *,
    private_stream: str,
    target: dict[str, Any],
    added: bool,
) -> None:
    """Emit channel.member_added/removed for a PRIVATE channel (self-homed, §2.2)."""
    body = lifecycle_body(
        auth=owner,
        home_stream_id=private_stream,
        type="channel.member_added" if added else "channel.member_removed",
        payload={"channel_stream_id": private_stream, "user_id": target["user_id"]},
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert len(resp.json()["accepted"]) == 1, resp.text


# --- T1: auth reject pre-accept (uniform 4401, never accepted) --------------------


async def test_ws_reject_missing_token(ws_app: FastAPI) -> None:
    async with make_ws_client(ws_app) as client:
        code = await _connect_expect_close(client, None)
        assert code == WSCloseCode.UNAUTHENTICATED


async def test_ws_reject_bad_token(ws_app: FastAPI) -> None:
    async with make_ws_client(ws_app) as client:
        code = await _connect_expect_close(client, _bearer("not-a-real-token"))
        assert code == WSCloseCode.UNAUTHENTICATED


async def test_ws_reject_expired_session(ws_app: FastAPI, db_session: AsyncSession) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        await db_session.execute(
            update(Session)
            .where(Session.token_hash == hash_token(owner["token"]))
            .values(expires_at=datetime.now(UTC) - timedelta(days=1))
        )
        code = await _connect_expect_close(client, _bearer(owner["token"]))
        assert code == WSCloseCode.UNAUTHENTICATED


async def test_ws_reject_deactivated_user(ws_app: FastAPI, db_session: AsyncSession) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        await db_session.execute(
            update(User)
            .where(User.user_id == owner["user_id"])
            .values(deactivated_at=datetime.now(UTC))
        )
        code = await _connect_expect_close(client, _bearer(owner["token"]))
        assert code == WSCloseCode.UNAUTHENTICATED


# --- T2: happy-path fanout -------------------------------------------------------


async def test_ws_happy_path_fanout(ws_app: FastAPI, db_session: AsyncSession) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        async with _aconnect(client, subprotocols=_bearer(owner["token"])) as ws:
            await _sync(ws)
            body = message_body(auth=owner, stream_id=channel, text="hi")
            resp = await post_batch(client, owner["token"], [wire_item(body)])
            assert resp.status_code == 200, resp.text

            frame = await _recv_event(ws)
            assert frame["event"]["body"]["event_id"] == body["event_id"]
            assert isinstance(frame["event"]["server"]["server_sequence"], int)
            assert frame["event"]["server"]["server_sequence"] >= 1


# --- T3: adversary isolation on a private stream ---------------------------------


async def test_ws_adversary_receives_zero_frames(ws_app: FastAPI, db_session: AsyncSession) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        adversary = await _invite_user(client, owner, role="member")
        private = await bootstrap_channel(client, db_session, owner, visibility="private")
        await _member_event(client, owner, private_stream=private, target=member, added=True)

        async with (
            _aconnect(client, subprotocols=_bearer(member["token"])) as ws_member,
            _aconnect(client, subprotocols=_bearer(adversary["token"])) as ws_adv,
        ):
            await _sync(ws_member)
            await _sync(ws_adv)

            body = message_body(auth=owner, stream_id=private, text="secret")
            resp = await post_batch(client, owner["token"], [wire_item(body)])
            assert len(resp.json()["accepted"]) == 1, resp.text

            frame = await _recv_event(ws_member)
            assert frame["event"]["body"]["event_id"] == body["event_id"]
            # The non-member gets NOTHING for the private stream (§12.4 at the WS surface).
            with pytest.raises(TimeoutError):
                await ws_adv.receive_json(timeout=0.3)


# --- T4: membership removal mid-connection cuts fanout immediately ----------------


async def test_ws_membership_removal_stops_fanout(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        private = await bootstrap_channel(client, db_session, owner, visibility="private")
        await _member_event(client, owner, private_stream=private, target=member, added=True)

        async with _aconnect(client, subprotocols=_bearer(member["token"])) as ws:
            await _sync(ws)

            first = message_body(auth=owner, stream_id=private, text="one")
            await post_batch(client, owner["token"], [wire_item(first)])
            frame = await _recv_event(ws)
            assert frame["event"]["body"]["event_id"] == first["event_id"]

            # Remove the member; the removal reducer commits BEFORE the next event's
            # per-send resolution, so the live predicate revokes on the next event.
            await _member_event(client, owner, private_stream=private, target=member, added=False)

            second = message_body(auth=owner, stream_id=private, text="two")
            await post_batch(client, owner["token"], [wire_item(second)])
            # No further frame — neither the removal event nor the follow-up message.
            with pytest.raises(TimeoutError):
                await ws.receive_json(timeout=0.3)


# --- T5: per-user connection cap (10; 11th → 4029) -------------------------------


async def test_ws_connection_cap(ws_app: FastAPI, db_session: AsyncSession) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        async with contextlib.AsyncExitStack() as stack:
            sockets: list[AsyncWebSocketSession] = []
            for _ in range(10):
                ws = await stack.enter_async_context(
                    _aconnect(client, subprotocols=_bearer(owner["token"]))
                )
                await _sync(ws)
                sockets.append(ws)
            assert hub.connection_count() == 10

            # The 11th is accepted then closed 4029; the first 10 stay live.
            code = await _connect_expect_close(client, _bearer(owner["token"]))
            assert code == WSCloseCode.TOO_MANY_CONNECTIONS
            assert hub.connection_count() == 10

            body = message_body(auth=owner, stream_id=channel)
            resp = await post_batch(client, owner["token"], [wire_item(body)])
            assert resp.status_code == 200, resp.text
            for ws in sockets:
                frame = await _recv_event(ws)
                assert frame["event"]["body"]["event_id"] == body["event_id"]


# --- T6: heartbeat ---------------------------------------------------------------


async def test_ws_client_ping_gets_pong(ws_app: FastAPI) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        async with _aconnect(client, subprotocols=_bearer(owner["token"])) as ws:
            await ws.send_json({"t": "ping"})
            assert await _read_until(ws, "pong") == {"t": "pong"}


async def test_ws_missed_heartbeat_closes_4408(
    settings: Settings, db_session: AsyncSession
) -> None:
    # Shrink the heartbeat so a never-answered ping closes the socket in ~0.2 s (R5).
    fast = settings.model_copy(update={"ws_heartbeat_interval_seconds": 0.1})
    app = make_app(fast, db_session)
    hub.set_session_factory(bound_session_factory(db_session))

    async with make_ws_client(app) as client:
        owner = await do_setup(client)
        async with _aconnect(client, subprotocols=_bearer(owner["token"])) as ws:
            # Never answer the server's ping → the next tick closes 4408.
            with pytest.raises(WebSocketDisconnect) as excinfo:
                while True:
                    await ws.receive_json(timeout=2.0)
            assert excinfo.value.code == WSCloseCode.HEARTBEAT_TIMEOUT


# --- T7: fanout only after commit (rejected event → no frame) --------------------


async def test_ws_rejected_event_produces_no_frame(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        async with _aconnect(client, subprotocols=_bearer(owner["token"])) as ws:
            await _sync(ws)
            good = message_body(auth=owner, stream_id=channel, text="ok")
            # A message to a non-existent stream is rejected (permission_denied) and
            # never opens a transaction / reaches publish_event.
            bad = message_body(auth=owner, stream_id=ids.new_stream_id(), text="nope")
            resp = await post_batch(client, owner["token"], [wire_item(good), wire_item(bad)])
            payload = resp.json()
            assert len(payload["accepted"]) == 1
            assert len(payload["rejected"]) == 1

            frame = await _recv_event(ws)
            assert frame["event"]["body"]["event_id"] == good["event_id"]
            # Exactly ONE frame — the rejected event produced none.
            with pytest.raises(TimeoutError):
                await ws.receive_json(timeout=0.3)


# --- T8: hash fidelity of the pushed frame (pure unit — §6a guard) ---------------


def _envelope(body: dict[str, Any]) -> Envelope:
    return Envelope(
        body=Body(**body),
        event_hash=hash_event(body),
        signature=None,
        server=ServerMetadata(server_sequence=5, server_received_at="2026-07-05T00:00:00.000Z"),
    )


def _base_body() -> dict[str, Any]:
    return {
        "event_id": ids.new_event_id(),
        "workspace_id": ids.new_workspace_id(),
        "stream_id": ids.new_stream_id(),
        "type": "message.created",
        "type_version": 1,
        "author_user_id": ids.new_user_id(),
        "author_device_id": ids.new_device_id(),
        "client_created_at": "2026-07-05T00:00:00.000Z",
        "payload": {"message_id": ids.new_message_id(), "text": "hello"},
    }


def test_event_frame_hash_fidelity_known_type() -> None:
    body = _base_body()
    frame = event_frame(_envelope(body))
    assert frame["t"] == "event"
    assert frame["event"]["signature"] is None
    assert frame["event"]["server"]["server_sequence"] == 5
    assert hash_event(frame["event"]["body"]) == frame["event"]["event_hash"]


def test_event_frame_hash_fidelity_unknown_type() -> None:
    # Unknown type + extra top-level fields + an opaque nested payload — all must
    # survive ``extra="allow"`` round-tripping and stay hash-valid.
    body = _base_body()
    body["type"] = "custom.opaque"
    body["type_version"] = 9
    body["surprise"] = {"z": [3, 2, 1], "nested": {"deep": True}}
    body["payload"] = {"arbitrary": {"n": 123456789, "flag": False}, "list": [{"x": 1}, {"y": 2}]}
    frame = event_frame(_envelope(body))
    assert hash_event(frame["event"]["body"]) == frame["event"]["event_hash"]


# --- T9: idempotent re-accept never double-pushes --------------------------------


async def test_ws_idempotent_reaccept_no_double_push(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        async with _aconnect(client, subprotocols=_bearer(owner["token"])) as ws:
            await _sync(ws)
            item = wire_item(message_body(auth=owner, stream_id=channel))
            await post_batch(client, owner["token"], [item])
            frame = await _recv_event(ws)
            assert frame["event"]["body"]["event_id"] == item["body"]["event_id"]

            # Re-uploading the same event is an idempotent re-accept → no publish.
            await post_batch(client, owner["token"], [item])
            with pytest.raises(TimeoutError):
                await ws.receive_json(timeout=0.3)


# --- T10: dead/slow socket isolation ---------------------------------------------


class _DeadSocket:
    """A socket whose send always fails — stands in for a wedged/dead client."""

    async def send_json(self, data: Any, mode: str = "text") -> None:
        raise RuntimeError("dead socket")


async def test_ws_dead_socket_isolated(ws_app: FastAPI, db_session: AsyncSession) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        async with _aconnect(client, subprotocols=_bearer(owner["token"])) as ws:
            await _sync(ws)
            # Inject a failing connection for the same user directly into the registry.
            dead = Connection(
                websocket=cast(WebSocket, _DeadSocket()),
                user_id=owner["user_id"],
                role=owner["role"],
                workspace_id=owner["workspace_id"],
                device_id=ids.new_device_id(),
            )
            assert hub.try_register(dead, max_connections=100)
            assert hub.connection_count() == 2

            body = message_body(auth=owner, stream_id=channel)
            resp = await post_batch(client, owner["token"], [wire_item(body)])
            assert resp.status_code == 200, resp.text

            # The healthy socket still gets its frame; the dead one is dropped + removed.
            frame = await _recv_event(ws)
            assert frame["event"]["body"]["event_id"] == body["event_id"]
            assert hub.connection_count() == 1


# --- T11: multi-device same user -------------------------------------------------


async def test_ws_multi_device_same_user(ws_app: FastAPI, db_session: AsyncSession) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        async with (
            _aconnect(client, subprotocols=_bearer(owner["token"])) as ws1,
            _aconnect(client, subprotocols=_bearer(owner["token"])) as ws2,
        ):
            await _sync(ws1)
            await _sync(ws2)
            assert hub.connection_count() == 2

            body = message_body(auth=owner, stream_id=channel)
            await post_batch(client, owner["token"], [wire_item(body)])
            for ws in (ws1, ws2):
                frame = await _recv_event(ws)
                assert frame["event"]["body"]["event_id"] == body["event_id"]


# --- T12: unknown inbound frame tolerated ----------------------------------------


async def test_ws_unknown_inbound_frame_ignored(ws_app: FastAPI) -> None:
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        async with _aconnect(client, subprotocols=_bearer(owner["token"])) as ws:
            await _sync(ws)
            await ws.send_json({"t": "typing", "stream_id": "s_x"})  # reserved M3 → ignored
            await ws.send_text("not-json{{{")  # garbage → ignored
            await ws.send_json({"no_type": True})  # unknown → ignored
            # Still open and responsive.
            await ws.send_json({"t": "ping"})
            assert await _read_until(ws, "pong") == {"t": "pong"}


# --- T-SEC (security round 1): token off the URL + never logged ------------------


async def test_ws_token_never_appears_in_logs(ws_app: FastAPI, db_session: AsyncSession) -> None:
    """T-SEC-1 (regression for finding b): the raw token leaks into NO log record.

    Captures ``root`` + the ``uvicorn*`` loggers (which carry the handshake line in
    production) across a full authenticated connect + accept + fanout, and asserts
    the raw session token appears nowhere — message or field. This is the guard that
    was missing when the query-param form leaked the token into ``uvicorn.error``.
    """
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setLevel(logging.DEBUG)
    handler.addFilter(RedactSecretsFilter())  # the same filter the app installs
    names = ("", "uvicorn", "uvicorn.error", "uvicorn.access")
    loggers = [logging.getLogger(name) for name in names]
    previous = [(lg, lg.level) for lg in loggers]
    for lg in loggers:
        lg.addHandler(handler)
        lg.setLevel(logging.DEBUG)
    try:
        async with make_ws_client(ws_app) as client:
            owner = await do_setup(client)
            channel = await bootstrap_channel(client, db_session, owner)
            async with _aconnect(client, subprotocols=_bearer(owner["token"])) as ws:
                await _sync(ws)
                body = message_body(auth=owner, stream_id=channel, text="hi")
                await post_batch(client, owner["token"], [wire_item(body)])
                frame = await _recv_event(ws)
                assert frame["event"]["body"]["event_id"] == body["event_id"]
                token = owner["token"]
    finally:
        for lg, level in previous:
            lg.removeHandler(handler)
            lg.setLevel(level)

    assert token not in buffer.getvalue(), "the raw session token leaked into the logs"


async def test_ws_subprotocol_echoed_on_accept(ws_app: FastAPI) -> None:
    """T-SEC-2: a valid ``["bearer", token]`` connect succeeds and echoes ``bearer``.

    A dropped echo breaks a real browser handshake, so assert the negotiated
    response subprotocol explicitly.
    """
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        async with _aconnect(client, subprotocols=_bearer(owner["token"])) as ws:
            assert ws.subprotocol == "bearer"
            await _sync(ws)


async def test_ws_malformed_subprotocol_rejects_4401(ws_app: FastAPI) -> None:
    """T-SEC-3: absent / token-less / non-bearer subprotocol → uniform 4401 pre-accept."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        for subprotocols in (
            None,  # no Sec-WebSocket-Protocol at all
            ["bearer"],  # the bearer marker with no token element
            ["notbearer", owner["token"]],  # valid token but wrong marker
        ):
            code = await _connect_expect_close(client, subprotocols)
            assert code == WSCloseCode.UNAUTHENTICATED, subprotocols


# --- T13 (ENG-153): revocation close-signal — deactivation / session revoke ------


class _ClosableSocket:
    """A fake socket recording its close — stands in for a live client (ENG-153)."""

    def __init__(self) -> None:
        self.closed_with: tuple[int, str] | None = None

    async def send_json(self, data: Any, mode: str = "text") -> None:
        return None

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed_with = (code, reason or "")


class _BrokenCloseSocket(_ClosableSocket):
    """A socket whose close always raises — an already-torn-down/wedged client."""

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        raise RuntimeError("already closing")


def _conn(
    socket: _ClosableSocket,
    *,
    user_id: str,
    workspace_id: str = "ws_x",
    session_token_hash: str | None = None,
) -> Connection:
    """A registry :class:`Connection` around a fake socket (unit tests only)."""
    return Connection(
        websocket=cast(WebSocket, socket),
        user_id=user_id,
        role="member",
        workspace_id=workspace_id,
        device_id=ids.new_device_id(),
        session_token_hash=session_token_hash,
    )


async def test_ws_deactivation_force_closes_socket_and_blocks_reconnect(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """The ENG-153 teeth: admin deactivation force-closes the target's live socket.

    A member is receiving live fanout; ``PATCH …/members/{id}`` ``active:false``
    closes their socket ``4401`` (no post-deactivation frame can reach it — the
    connection leaves the registry before the close I/O), the owner's own delivery
    is unaffected by the mid-fanout disconnect, and the dead bearer cannot
    reconnect (pre-accept 4401) — closed socket + no reconnect = full revocation.
    """
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        channel = await bootstrap_channel(client, db_session, owner)

        async with (
            _aconnect(client, subprotocols=_bearer(owner["token"])) as ws_owner,
            _aconnect(client, subprotocols=_bearer(member["token"])) as ws_member,
        ):
            await _sync(ws_owner)
            await _sync(ws_member)

            # The member IS receiving live fanout before the deactivation.
            first = message_body(auth=owner, stream_id=channel, text="one")
            await post_batch(client, owner["token"], [wire_item(first)])
            frame = await _recv_event(ws_member)
            assert frame["event"]["body"]["event_id"] == first["event_id"]
            await _recv_event(ws_owner)

            r = await client.patch(
                f"/v1/admin/members/{member['user_id']}",
                json={"active": False},
                headers=auth_header(owner["token"]),
            )
            assert r.status_code == 200, r.text

            # The PATCH itself force-closed the member's socket with the re-auth code.
            with pytest.raises(WebSocketDisconnect) as excinfo:
                while True:
                    await ws_member.receive_json(timeout=2.0)
            assert excinfo.value.code == WSCloseCode.UNAUTHENTICATED
            assert not hub.is_online(member["user_id"])

            # Post-deactivation fanout: the OWNER still receives (a mid-fanout
            # disconnect never disturbs other users' delivery); the member's
            # connection is out of the registry, so no frame can reach it.
            second = message_body(auth=owner, stream_id=channel, text="two")
            await post_batch(client, owner["token"], [wire_item(second)])
            frame = await _recv_event(ws_owner)
            assert frame["event"]["body"]["event_id"] == second["event_id"]

        # Full revocation: the deactivated user's bearer cannot reopen a socket —
        # sessions were bulk-deleted and deactivated_at committed BEFORE the close,
        # so a reconnect race always lands on the uniform pre-accept 4401.
        code = await _connect_expect_close(client, _bearer(member["token"]))
        assert code == WSCloseCode.UNAUTHENTICATED


async def test_ws_deactivation_without_close_signal_keeps_fanout(
    ws_app: FastAPI, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """NON-VACUITY proof: absent the close-signal, the deactivated socket lives on.

    With ``hub.disconnect_user`` neutered, the same deactivation PATCH leaves the
    member's already-open socket receiving live fanout — the exact ENG-153 gap
    (fanout re-checks stream membership per send, never ``deactivated_at`` or
    session validity). This is what proves the close assertion in the previous
    test is load-bearing and not a side effect of the session bulk-delete.
    """

    async def _neutered(user_id: str, *, code: int, reason: str = "") -> None:
        return None

    monkeypatch.setattr(hub, "disconnect_user", _neutered)

    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        channel = await bootstrap_channel(client, db_session, owner)

        async with _aconnect(client, subprotocols=_bearer(member["token"])) as ws:
            await _sync(ws)

            r = await client.patch(
                f"/v1/admin/members/{member['user_id']}",
                json={"active": False},
                headers=auth_header(owner["token"]),
            )
            assert r.status_code == 200, r.text

            # The gap: the deactivated member STILL gets the next event's frame.
            body = message_body(auth=owner, stream_id=channel, text="leak")
            await post_batch(client, owner["token"], [wire_item(body)])
            frame = await _recv_event(ws)
            assert frame["event"]["body"]["event_id"] == body["event_id"]


async def test_ws_session_revoke_closes_only_that_sessions_socket(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """Session-revoke parity WITHOUT over-close: only the revoked session's socket dies.

    One user, two valid sessions (A: accept-invite, B: login), one socket each.
    ``DELETE /v1/auth/sessions/{hash(A)}`` closes A's socket ``4401`` while B's
    socket stays open AND keeps receiving fanout — revoking one device must never
    kick the user's other valid sessions (the per-session ``token_hash`` captured
    on the connection is what scopes the close).
    """
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        invite = await create_invite(client, owner["token"], role="member")
        raw = join_token(invite.json()["url"])
        email = f"{ids.new_ulid().lower()}@example.com"
        accepted = await accept_invite(client, raw, email=email)
        assert accepted.status_code == 200, accepted.text
        session_a: dict[str, Any] = accepted.json()
        login = await do_login(client, email=email, password="another-valid-password")
        assert login.status_code == 200, login.text
        session_b: dict[str, Any] = login.json()
        assert session_b["user_id"] == session_a["user_id"]

        channel = await bootstrap_channel(client, db_session, owner)

        async with (
            _aconnect(client, subprotocols=_bearer(session_a["token"])) as ws_a,
            _aconnect(client, subprotocols=_bearer(session_b["token"])) as ws_b,
        ):
            await _sync(ws_a)
            await _sync(ws_b)

            first = message_body(auth=owner, stream_id=channel, text="one")
            await post_batch(client, owner["token"], [wire_item(first)])
            for ws in (ws_a, ws_b):
                frame = await _recv_event(ws)
                assert frame["event"]["body"]["event_id"] == first["event_id"]

            # Revoke session A from session B (the session id IS the token hash).
            r = await client.delete(
                f"/v1/auth/sessions/{hash_token(session_a['token'])}",
                headers=auth_header(session_b["token"]),
            )
            assert r.status_code == 204, r.text

            # A's socket is force-closed with the re-auth code…
            with pytest.raises(WebSocketDisconnect) as excinfo:
                while True:
                    await ws_a.receive_json(timeout=2.0)
            assert excinfo.value.code == WSCloseCode.UNAUTHENTICATED

            # …while B's socket survives and KEEPS its fanout (no over-close).
            assert hub.is_online(session_a["user_id"])
            second = message_body(auth=owner, stream_id=channel, text="two")
            await post_batch(client, owner["token"], [wire_item(second)])
            frame = await _recv_event(ws_b)
            assert frame["event"]["body"]["event_id"] == second["event_id"]


async def test_ws_redeactivate_fires_no_spurious_close_signal(
    ws_app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The transition guard: only the active→inactive EDGE fires the close-signal.

    Re-deactivating an already-inactive member is the documented 200 no-op and
    must not spuriously call ``disconnect_user`` again; a reactivate→deactivate
    round trip IS a new transition and fires again. Reactivation itself never
    fires (there is nothing to close).
    """
    calls: list[str] = []
    original = hub.disconnect_user

    async def _recording(user_id: str, *, code: int, reason: str = "") -> None:
        calls.append(user_id)
        await original(user_id, code=code, reason=reason)

    monkeypatch.setattr(hub, "disconnect_user", _recording)

    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        headers = auth_header(owner["token"])
        url = f"/v1/admin/members/{member['user_id']}"

        r = await client.patch(url, json={"active": False}, headers=headers)
        assert r.status_code == 200, r.text
        assert calls == [member["user_id"]]

        # Idempotent re-deactivate: 200, but NO second close-signal.
        r = await client.patch(url, json={"active": False}, headers=headers)
        assert r.status_code == 200, r.text
        assert calls == [member["user_id"]]

        # Reactivate never fires; the NEXT deactivation is a fresh transition.
        r = await client.patch(url, json={"active": True}, headers=headers)
        assert r.status_code == 200, r.text
        assert calls == [member["user_id"]]
        r = await client.patch(url, json={"active": False}, headers=headers)
        assert r.status_code == 200, r.text
        assert calls == [member["user_id"], member["user_id"]]


async def test_ws_bot_deactivation_closes_bot_socket(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """Deactivating a BOT closes its socket too — same user-level close-signal.

    A bot socket authenticates via a bot token (no session row), so its
    ``session_token_hash`` is None; the deactivation path still tears it down via
    ``disconnect_user``. Driven with a fake registered connection so the test
    exercises the PATCH→hub wiring without a full bot-token WS handshake.
    """
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        bot_id = ids.new_user_id()
        db_session.add(
            User(
                user_id=bot_id,
                workspace_id=owner["workspace_id"],
                email="bot@example.com",
                password_hash="x",
                display_name="Helper Bot",
                role="member",
                is_bot=True,
            )
        )
        await db_session.flush()

        socket = _ClosableSocket()
        conn = _conn(
            socket,
            user_id=bot_id,
            workspace_id=owner["workspace_id"],
            session_token_hash=None,
        )
        assert hub.try_register(conn, max_connections=10)

        r = await client.patch(
            f"/v1/admin/members/{bot_id}",
            json={"active": False},
            headers=auth_header(owner["token"]),
        )
        assert r.status_code == 200, r.text
        assert socket.closed_with == (WSCloseCode.UNAUTHENTICATED, "account deactivated")
        assert not hub.is_online(bot_id)


async def test_hub_disconnect_user_isolates_close_failures() -> None:
    """Hub unit: a raising close is swallowed, the registry still empties, others live.

    A wedged/already-closing socket cannot make ``disconnect_user`` raise into the
    (already-committed) admin request, cannot keep itself registered, and cannot
    disturb another user's connection. An unknown user is a clean no-op.
    """
    broken = _BrokenCloseSocket()
    healthy = _ClosableSocket()
    other = _ClosableSocket()
    hub.try_register(_conn(broken, user_id="u_target"), max_connections=10)
    hub.try_register(_conn(healthy, user_id="u_target"), max_connections=10)
    hub.try_register(_conn(other, user_id="u_other"), max_connections=10)

    await hub.disconnect_user("u_target", code=WSCloseCode.UNAUTHENTICATED, reason="gone")

    assert not hub.is_online("u_target")  # broken close still deregistered
    assert healthy.closed_with == (WSCloseCode.UNAUTHENTICATED, "gone")
    assert hub.is_online("u_other")
    assert other.closed_with is None

    # No sockets at all → no-op, no error.
    await hub.disconnect_user("u_ghost", code=WSCloseCode.UNAUTHENTICATED, reason="gone")


async def test_hub_disconnect_session_exact_match_only() -> None:
    """Hub unit: the per-session close hits EXACTLY the matching token hash.

    Same user, three sockets: session A, session B, and a bot-style connection
    with ``session_token_hash=None``. Disconnecting session A closes/removes only
    A — B and the None-hash socket stay registered (a ``None`` stored hash can
    never match, so a bot socket is unreachable via the session path by design).
    """
    sock_a, sock_b, sock_bot = _ClosableSocket(), _ClosableSocket(), _ClosableSocket()
    hub.try_register(_conn(sock_a, user_id="u1", session_token_hash="hash-a"), max_connections=10)
    hub.try_register(_conn(sock_b, user_id="u1", session_token_hash="hash-b"), max_connections=10)
    hub.try_register(_conn(sock_bot, user_id="u1", session_token_hash=None), max_connections=10)

    # Another user's socket with the SAME hash value is out of scope by user key.
    sock_other = _ClosableSocket()
    hub.try_register(
        _conn(sock_other, user_id="u2", session_token_hash="hash-a"), max_connections=10
    )

    await hub.disconnect_session(
        user_id="u1",
        session_token_hash="hash-a",
        code=WSCloseCode.UNAUTHENTICATED,
        reason="session revoked",
    )

    assert sock_a.closed_with == (WSCloseCode.UNAUTHENTICATED, "session revoked")
    assert sock_b.closed_with is None
    assert sock_bot.closed_with is None
    assert sock_other.closed_with is None
    assert hub.is_online("u1")  # B + the bot-style socket survive
    assert hub.is_online("u2")
    assert hub.connection_count() == 3
