"""``/v1/read-state`` — synced per-user KV: monotonicity, isolation, WS echo, D3 guard (ENG-123).

Read-state is the THIRD message class (§3.3 / D3): **synced per-user KV**, not a
durable event and not ephemeral presence. It syncs monotonically per user with a
cross-device WS echo, but it is NEVER the log — the load-bearing negative-guard
test (:func:`test_put_read_state_is_not_an_event`) proves a PUT writes no
``events`` row and mutates no projection.

Principals are minted through the real auth path (setup + invite/accept, each
carrying a bearer token); channels are bootstrapped through the real event accept
path. HTTP tests share the rolled-back ``client``/``db_session``; the WS-echo
tests use ``ws_app`` + ``make_ws_client`` (the ENG-68 harness), so connect + PUT +
echo all run in one per-test transaction.

The crux is ISOLATION, proven three ways: a user only ever touches their OWN
markers (own-user-only), only on streams they can READ (uniform 404 otherwise, no
oracle), and the WS echo reaches ONLY that same user's other devices — a different
user's socket receives nothing.
"""

from __future__ import annotations

from typing import Any, cast

import pytest
from authutil import (
    accept_invite,
    auth_header,
    create_invite,
    do_setup,
    join_token,
)
from eventsutil import (
    bootstrap_channel,
    lifecycle_body,
    message_body,
    post_batch,
    wire_item,
)
from fastapi import FastAPI
from harness import make_ws_client
from httpx import AsyncClient
from httpx_ws import aconnect_ws
from msgd.core import ids
from msgd.db.models import Event, MessageProj, ReactionProj, ReadState
from msgd.ws.hub import hub
from msgd.ws.registry import Connection
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocket

READ_STATE_URL = "/v1/read-state"


# --- helpers -----------------------------------------------------------------


async def _put(client: AsyncClient, token: str, *, stream_id: str, last_read_seq: int) -> Any:
    """PUT /v1/read-state as the bearer of ``token``; return the httpx response."""
    return await client.put(
        READ_STATE_URL,
        json={"stream_id": stream_id, "last_read_seq": last_read_seq},
        headers=auth_header(token),
    )


async def _get(client: AsyncClient, token: str) -> Any:
    """GET /v1/read-state as the bearer of ``token``; return the httpx response."""
    return await client.get(READ_STATE_URL, headers=auth_header(token))


def _maybe_marker(get_body: dict[str, Any], stream_id: str) -> dict[str, Any] | None:
    """The read marker for ``stream_id`` in a GET body (or ``None`` if absent)."""
    for row in get_body["streams"]:
        if row["stream_id"] == stream_id:
            return cast(dict[str, Any], row)
    return None


def _marker(get_body: dict[str, Any], stream_id: str) -> dict[str, Any]:
    """The read marker for ``stream_id`` — asserting it is present in the GET body."""
    row = _maybe_marker(get_body, stream_id)
    assert row is not None, f"expected a marker for {stream_id}"
    return row


async def _invite_user(client: AsyncClient, owner: dict[str, Any], *, role: str) -> dict[str, Any]:
    """Create + accept an invite; return the new user's auth dict (token/ids/role)."""
    invite = await create_invite(client, owner["token"], role=role)
    raw = join_token(invite.json()["url"])
    accepted = await accept_invite(client, raw, email=f"{ids.new_ulid().lower()}@example.com")
    assert accepted.status_code == 200, accepted.text
    body: dict[str, Any] = accepted.json()
    return body


async def _add_member(
    client: AsyncClient, owner: dict[str, Any], *, private_stream: str, target: dict[str, Any]
) -> None:
    """Emit channel.member_added for a PRIVATE channel (self-homed, §2.2)."""
    body = lifecycle_body(
        auth=owner,
        home_stream_id=private_stream,
        type="channel.member_added",
        payload={"channel_stream_id": private_stream, "user_id": target["user_id"]},
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert len(resp.json()["accepted"]) == 1, resp.text


# --- monotonicity ------------------------------------------------------------


async def test_put_is_monotonic(client: AsyncClient, db_session: AsyncSession) -> None:
    """PUT 5 → 5; PUT 3 (lower) → still 5 (ignored); PUT 8 → 8. Response is effective."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    r5 = await _put(client, owner["token"], stream_id=channel, last_read_seq=5)
    assert r5.status_code == 200, r5.text
    assert r5.json() == {"stream_id": channel, "last_read_seq": 5}

    got = await _get(client, owner["token"])
    assert _marker(got.json(), channel)["last_read_seq"] == 5

    # A LOWER incoming value is ignored by GREATEST — the stored 5 wins.
    r3 = await _put(client, owner["token"], stream_id=channel, last_read_seq=3)
    assert r3.json() == {"stream_id": channel, "last_read_seq": 5}
    got = await _get(client, owner["token"])
    assert _marker(got.json(), channel)["last_read_seq"] == 5

    # A HIGHER value advances the marker.
    r8 = await _put(client, owner["token"], stream_id=channel, last_read_seq=8)
    assert r8.json() == {"stream_id": channel, "last_read_seq": 8}
    got = await _get(client, owner["token"])
    assert _marker(got.json(), channel)["last_read_seq"] == 8


# --- own-user scope ----------------------------------------------------------


async def test_scope_is_per_user(client: AsyncClient, db_session: AsyncSession) -> None:
    """A's PUT touches only A's rows; A's GET returns only A's markers (keyed on ctx)."""
    owner = await do_setup(client)
    member = await _invite_user(client, owner, role="member")
    # A public channel both can read.
    channel = await bootstrap_channel(client, db_session, owner)

    await _put(client, owner["token"], stream_id=channel, last_read_seq=7)
    await _put(client, member["token"], stream_id=channel, last_read_seq=2)

    # Each user reads back ONLY their own marker for the shared stream.
    owner_marker = _marker((await _get(client, owner["token"])).json(), channel)
    member_marker = _marker((await _get(client, member["token"])).json(), channel)
    assert owner_marker["last_read_seq"] == 7
    assert member_marker["last_read_seq"] == 2

    # Only two rows exist for that stream — one per user; neither addressed the other
    # (there is no user-id input to spoof — the row is keyed on the authed principal).
    rows = (
        (await db_session.execute(select(ReadState).where(ReadState.stream_id == channel)))
        .scalars()
        .all()
    )
    assert {(r.user_id, r.last_read_seq) for r in rows} == {
        (owner["user_id"], 7),
        (member["user_id"], 2),
    }


# --- readable-stream gate ----------------------------------------------------


async def test_put_unknown_stream_404(client: AsyncClient) -> None:
    """PUT on a nonexistent stream → uniform 404 (same as unreadable — no oracle)."""
    owner = await do_setup(client)
    resp = await _put(client, owner["token"], stream_id=ids.new_stream_id(), last_read_seq=1)
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"


async def test_put_unreadable_stream_404(client: AsyncClient, db_session: AsyncSession) -> None:
    """A non-member's PUT on a private channel → the IDENTICAL 404 as unknown (no oracle)."""
    owner = await do_setup(client)
    outsider = await _invite_user(client, owner, role="member")
    private = await bootstrap_channel(client, db_session, owner, visibility="private")

    resp = await _put(client, outsider["token"], stream_id=private, last_read_seq=1)
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"
    # And no marker was written for the outsider.
    row = await db_session.get(ReadState, (outsider["user_id"], private))
    assert row is None


async def test_guest_only_joined_streams(client: AsyncClient, db_session: AsyncSession) -> None:
    """A guest may set read-state ONLY on explicitly-joined streams (FLAGGED DEVIATION)."""
    owner = await do_setup(client)
    guest = await _invite_user(client, owner, role="guest")
    public = await bootstrap_channel(client, db_session, owner)  # guests can't read public
    private = await bootstrap_channel(client, db_session, owner, visibility="private")
    await _add_member(client, owner, private_stream=private, target=guest)

    # Public channel is invisible to a guest → 404.
    r_public = await _put(client, guest["token"], stream_id=public, last_read_seq=1)
    assert r_public.status_code == 404

    # The explicitly-joined private channel is settable.
    r_private = await _put(client, guest["token"], stream_id=private, last_read_seq=4)
    assert r_private.status_code == 200
    assert r_private.json() == {"stream_id": private, "last_read_seq": 4}

    # The guest's GET sees ONLY joined streams — never the public channel or meta.
    body = (await _get(client, guest["token"])).json()
    seen = {row["stream_id"] for row in body["streams"]}
    assert private in seen
    assert public not in seen


# --- unread heads ------------------------------------------------------------


async def test_get_unread_heads(client: AsyncClient, db_session: AsyncSession) -> None:
    """GET reflects unread = head_seq > last_read_seq per readable stream."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    # Fresh channel, no messages: head_seq 0, no marker → not unread.
    marker = _marker((await _get(client, owner["token"])).json(), channel)
    assert marker == {"stream_id": channel, "last_read_seq": 0, "head_seq": 0, "unread": False}

    # Post two messages → the channel's head advances; now unread.
    for _ in range(2):
        body = message_body(auth=owner, stream_id=channel)
        resp = await post_batch(client, owner["token"], [wire_item(body)])
        assert len(resp.json()["accepted"]) == 1, resp.text

    marker = _marker((await _get(client, owner["token"])).json(), channel)
    head = marker["head_seq"]
    assert head == 2
    assert marker["last_read_seq"] == 0
    assert marker["unread"] is True

    # Catch up to head → no longer unread.
    await _put(client, owner["token"], stream_id=channel, last_read_seq=head)
    marker = _marker((await _get(client, owner["token"])).json(), channel)
    assert marker["last_read_seq"] == head
    assert marker["unread"] is False


async def test_get_excludes_unreadable_streams(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """An unreadable stream never appears in a caller's GET (no head_seq leak)."""
    owner = await do_setup(client)
    outsider = await _invite_user(client, owner, role="member")
    private = await bootstrap_channel(client, db_session, owner, visibility="private")
    # Owner has read it and marked it; the outsider must not see it at all.
    await _put(client, owner["token"], stream_id=private, last_read_seq=3)

    body = (await _get(client, outsider["token"])).json()
    assert _maybe_marker(body, private) is None


# --- D3 NEGATIVE GUARD (load-bearing): read-state is NEVER the log -----------


async def test_put_read_state_is_not_an_event(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A read-state PUT creates NO ``events`` row and mutates NO projection (D3).

    Read-state is synced per-user KV, not the log — so the ``events`` count and the
    ``messages_proj`` / ``reactions_proj`` dumps are byte-for-byte unchanged across
    a PUT, while a ``read_state`` row DID appear.
    """
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    async def _events_count() -> int:
        return int((await db_session.execute(select(func.count()).select_from(Event))).scalar_one())

    async def _proj_dump() -> tuple[list[Any], list[Any]]:
        msgs = (
            (await db_session.execute(select(MessageProj).order_by(MessageProj.message_id)))
            .scalars()
            .all()
        )
        reacts = (
            (
                await db_session.execute(
                    select(ReactionProj).order_by(
                        ReactionProj.message_id, ReactionProj.author_user_id, ReactionProj.emoji
                    )
                )
            )
            .scalars()
            .all()
        )
        msg_dump = [(m.message_id, m.stream_id, m.text, m.created_seq, m.deleted) for m in msgs]
        react_dump = [(r.message_id, r.author_user_id, r.emoji) for r in reacts]
        return msg_dump, react_dump

    events_before = await _events_count()
    proj_before = await _proj_dump()
    read_state_before = int(
        (await db_session.execute(select(func.count()).select_from(ReadState))).scalar_one()
    )

    resp = await _put(client, owner["token"], stream_id=channel, last_read_seq=42)
    assert resp.status_code == 200, resp.text

    # The log and every projection are untouched — a read marker is NOT an event.
    assert await _events_count() == events_before
    assert await _proj_dump() == proj_before
    # But the synced-KV row itself DID land (the write is real, just not the log).
    read_state_after = int(
        (await db_session.execute(select(func.count()).select_from(ReadState))).scalar_one()
    )
    assert read_state_after == read_state_before + 1
    row = await db_session.get(ReadState, (owner["user_id"], channel))
    assert row is not None and row.last_read_seq == 42


# --- WS echo isolation (the crux) --------------------------------------------


async def _read_until(ws: Any, t: str, *, timeout: float = 2.0) -> dict[str, Any]:
    """Receive frames until one with ``t`` arrives (skips heartbeat noise)."""
    while True:
        msg = await ws.receive_json(timeout=timeout)
        if isinstance(msg, dict) and msg.get("t") == t:
            return msg


async def _sync(ws: Any) -> None:
    """Ping/pong barrier: a pong proves this socket is registered before we PUT."""
    await ws.send_json({"t": "ping"})
    await _read_until(ws, "pong")


def _bearer(token: str) -> list[str]:
    return ["bearer", token]


def _connect(client: AsyncClient, token: str) -> Any:
    """Open a WS to ``/v1/ws`` with ``token`` in the ``Sec-WebSocket-Protocol`` (off URL)."""
    return aconnect_ws("http://test/v1/ws", client=client, subprotocols=_bearer(token))


async def test_ws_echo_reaches_all_own_devices_only(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """The crux: a PUT echoes read_state to BOTH the user's devices; another user gets NOTHING."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        channel = await bootstrap_channel(client, db_session, owner)

        async with (
            _connect(client, owner["token"]) as ws1,
            _connect(client, owner["token"]) as ws2,
            _connect(client, member["token"]) as ws_other,
        ):
            await _sync(ws1)
            await _sync(ws2)
            await _sync(ws_other)

            resp = await _put(client, owner["token"], stream_id=channel, last_read_seq=11)
            assert resp.status_code == 200, resp.text

            # BOTH of the owner's devices receive the echo, with the exact wire shape.
            for ws in (ws1, ws2):
                frame = await _read_until(ws, "read_state")
                assert frame == {"t": "read_state", "stream_id": channel, "last_read_seq": 11}

            # The OTHER user's socket receives nothing — read markers never cross users.
            with pytest.raises(TimeoutError):
                await ws_other.receive_json(timeout=0.3)


async def test_ws_echo_carries_effective_monotonic_value(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A lower PUT still echoes the EFFECTIVE (higher, stored) value, not the incoming one."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        async with _connect(client, owner["token"]) as ws:
            await _sync(ws)
            await _put(client, owner["token"], stream_id=channel, last_read_seq=9)
            assert (await _read_until(ws, "read_state"))["last_read_seq"] == 9

            # A lower incoming value is ignored; the echo carries the stored 9.
            resp = await _put(client, owner["token"], stream_id=channel, last_read_seq=4)
            assert resp.json()["last_read_seq"] == 9
            assert (await _read_until(ws, "read_state"))["last_read_seq"] == 9


# --- best-effort echo --------------------------------------------------------


class _DeadSocket:
    """A socket whose send always fails — stands in for a wedged/dead client."""

    async def send_json(self, data: Any, mode: str = "text") -> None:
        raise RuntimeError("dead socket")


async def test_put_succeeds_when_echo_fails(ws_app: FastAPI, db_session: AsyncSession) -> None:
    """A failing WS send never fails the PUT — the DB write is authoritative (§3.3)."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        async with _connect(client, owner["token"]) as ws:
            await _sync(ws)
            # Inject a failing connection for the SAME user directly into the registry.
            dead = Connection(
                websocket=cast(WebSocket, _DeadSocket()),
                user_id=owner["user_id"],
                role=owner["role"],
                workspace_id=owner["workspace_id"],
                device_id=ids.new_device_id(),
            )
            assert hub.try_register(dead, max_connections=100)
            assert hub.connection_count() == 2

            resp = await _put(client, owner["token"], stream_id=channel, last_read_seq=5)
            # The PUT still succeeds and the marker is written despite the dead socket.
            assert resp.status_code == 200, resp.text
            assert resp.json()["last_read_seq"] == 5

            # The healthy socket still got its echo; the dead one is dropped + removed.
            frame = await _read_until(ws, "read_state")
            assert frame["last_read_seq"] == 5
            assert hub.connection_count() == 1
