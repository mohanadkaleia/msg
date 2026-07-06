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
from authutil import accept_invite, create_invite, do_setup, join_token, make_app
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
