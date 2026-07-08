"""``/v1/prefs`` — synced per-user KV: LWW, isolation, WS echo, D3 guard (ENG-124).

Notification prefs are the SAME third message class as read-state (§3.3 / D3):
**synced per-user KV**, not a durable event and not ephemeral presence. A pref
syncs per user with a same-user cross-device WS echo, but it is NEVER the log —
the load-bearing negative-guard test (:func:`test_put_prefs_is_not_an_event`)
proves a PUT writes no ``events`` row and mutates no projection.

The behavioural contrast with read-state is **last-write-wins vs monotonic**: a
pref PUT simply REPLACES the previous level (a "lower/earlier" value is NOT
ignored), whereas a read marker upserts with ``GREATEST``.

Principals are minted through the real auth path (setup + invite/accept, each
carrying a bearer token); channels are bootstrapped through the real event accept
path. HTTP tests share the rolled-back ``client``/``db_session``; the WS-echo
tests use ``ws_app`` + ``make_ws_client`` (the ENG-68 harness), so connect + PUT +
echo all run in one per-test transaction.

The crux is ISOLATION, proven three ways: a user only ever touches their OWN prefs
(own-user-only, no ``user_id`` to spoof), only on streams they can READ (uniform
404 otherwise, no oracle), and the WS echo reaches ONLY that same user's other
devices — a different user's socket receives nothing.
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
from msgd.db.models import (
    Event,
    File,
    MessageProj,
    Pref,
    ReactionProj,
    ThreadParticipantProj,
)
from msgd.ws.hub import hub
from msgd.ws.registry import Connection
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocket

PREFS_URL = "/v1/prefs"


# --- helpers -----------------------------------------------------------------


async def _put(client: AsyncClient, token: str, *, stream_id: str, level: str) -> Any:
    """PUT /v1/prefs as the bearer of ``token``; return the httpx response."""
    return await client.put(
        PREFS_URL,
        json={"stream_id": stream_id, "level": level},
        headers=auth_header(token),
    )


async def _get(client: AsyncClient, token: str) -> Any:
    """GET /v1/prefs as the bearer of ``token``; return the httpx response."""
    return await client.get(PREFS_URL, headers=auth_header(token))


def _maybe_entry(get_body: dict[str, Any], stream_id: str) -> dict[str, Any] | None:
    """The pref entry for ``stream_id`` in a GET body (or ``None`` if absent)."""
    for row in get_body["prefs"]:
        if row["stream_id"] == stream_id:
            return cast(dict[str, Any], row)
    return None


def _entry(get_body: dict[str, Any], stream_id: str) -> dict[str, Any]:
    """The pref entry for ``stream_id`` — asserting it is present in the GET body."""
    row = _maybe_entry(get_body, stream_id)
    assert row is not None, f"expected a pref for {stream_id}"
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


# --- round-trip + last-write-wins --------------------------------------------


async def test_put_is_last_write_wins(client: AsyncClient, db_session: AsyncSession) -> None:
    """PUT all → GET all; PUT mute → mute (OVERWRITE, not monotonic); PUT mentions → mentions."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    r_all = await _put(client, owner["token"], stream_id=channel, level="all")
    assert r_all.status_code == 200, r_all.text
    assert r_all.json() == {"stream_id": channel, "level": "all"}
    assert _entry((await _get(client, owner["token"])).json(), channel)["level"] == "all"

    # A later write REPLACES the prior level — there is no ordering, the newest
    # write is the truth (the key contrast with read-state's monotonic GREATEST).
    r_mute = await _put(client, owner["token"], stream_id=channel, level="mute")
    assert r_mute.json() == {"stream_id": channel, "level": "mute"}
    assert _entry((await _get(client, owner["token"])).json(), channel)["level"] == "mute"

    # And overwrite again — mute is not "sticky", a plain LWW overwrite.
    r_mentions = await _put(client, owner["token"], stream_id=channel, level="mentions")
    assert r_mentions.json() == {"stream_id": channel, "level": "mentions"}
    assert _entry((await _get(client, owner["token"])).json(), channel)["level"] == "mentions"

    # Exactly one row exists for (owner, channel) — the upsert never duplicated it.
    count = int(
        (
            await db_session.execute(
                select(func.count())
                .select_from(Pref)
                .where(Pref.user_id == owner["user_id"], Pref.stream_id == channel)
            )
        ).scalar_one()
    )
    assert count == 1


async def test_put_invalid_level_422(client: AsyncClient, db_session: AsyncSession) -> None:
    """A level outside {all,mentions,mute} is rejected with 422 at the boundary."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    resp = await _put(client, owner["token"], stream_id=channel, level="loud")
    assert resp.status_code == 422
    # No row was written for the bad level.
    row = await db_session.get(Pref, (owner["user_id"], channel))
    assert row is None


# --- own-user scope ----------------------------------------------------------


async def test_scope_is_per_user(client: AsyncClient, db_session: AsyncSession) -> None:
    """A's PUT touches only A's rows; A's GET returns only A's prefs (keyed on ctx)."""
    owner = await do_setup(client)
    member = await _invite_user(client, owner, role="member")
    channel = await bootstrap_channel(client, db_session, owner)

    await _put(client, owner["token"], stream_id=channel, level="mute")
    await _put(client, member["token"], stream_id=channel, level="all")

    # Each user reads back ONLY their own pref for the shared stream.
    owner_entry = _entry((await _get(client, owner["token"])).json(), channel)
    member_entry = _entry((await _get(client, member["token"])).json(), channel)
    assert owner_entry["level"] == "mute"
    assert member_entry["level"] == "all"

    # Only two rows exist for that stream — one per user; neither addressed the
    # other (there is no user-id input to spoof — the row is keyed on the principal).
    rows = (await db_session.execute(select(Pref).where(Pref.stream_id == channel))).scalars().all()
    assert {(r.user_id, r.level) for r in rows} == {
        (owner["user_id"], "mute"),
        (member["user_id"], "all"),
    }


# --- readable-stream gate ----------------------------------------------------


async def test_put_unknown_stream_404(client: AsyncClient) -> None:
    """PUT on a nonexistent stream → uniform 404 (same as unreadable — no oracle)."""
    owner = await do_setup(client)
    resp = await _put(client, owner["token"], stream_id=ids.new_stream_id(), level="all")
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"


async def test_put_unreadable_stream_404(client: AsyncClient, db_session: AsyncSession) -> None:
    """A non-member's PUT on a private channel → the IDENTICAL 404 as unknown (no oracle)."""
    owner = await do_setup(client)
    outsider = await _invite_user(client, owner, role="member")
    private = await bootstrap_channel(client, db_session, owner, visibility="private")

    resp = await _put(client, outsider["token"], stream_id=private, level="mute")
    assert resp.status_code == 404
    assert resp.json()["type"] == "/problems/not-found"
    # And no pref was written for the outsider.
    row = await db_session.get(Pref, (outsider["user_id"], private))
    assert row is None


async def test_guest_only_joined_streams(client: AsyncClient, db_session: AsyncSession) -> None:
    """A guest may set a pref ONLY on explicitly-joined streams (FLAGGED DEVIATION)."""
    owner = await do_setup(client)
    guest = await _invite_user(client, owner, role="guest")
    public = await bootstrap_channel(client, db_session, owner)  # guests can't read public
    private = await bootstrap_channel(client, db_session, owner, visibility="private")
    await _add_member(client, owner, private_stream=private, target=guest)

    # Public channel is invisible to a guest → 404.
    r_public = await _put(client, guest["token"], stream_id=public, level="all")
    assert r_public.status_code == 404

    # The explicitly-joined private channel is settable.
    r_private = await _put(client, guest["token"], stream_id=private, level="mentions")
    assert r_private.status_code == 200
    assert r_private.json() == {"stream_id": private, "level": "mentions"}

    # The guest's GET sees ONLY joined streams — never the public channel or meta.
    body = (await _get(client, guest["token"])).json()
    seen = {row["stream_id"] for row in body["prefs"]}
    assert private in seen
    assert public not in seen


async def test_get_returns_only_explicit_readable_prefs(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """GET returns only the caller's EXPLICIT prefs on readable streams — no leaks, no defaults."""
    owner = await do_setup(client)
    outsider = await _invite_user(client, owner, role="member")
    with_pref = await bootstrap_channel(client, db_session, owner)
    without_pref = await bootstrap_channel(client, db_session, owner)
    private = await bootstrap_channel(client, db_session, owner, visibility="private")

    await _put(client, owner["token"], stream_id=with_pref, level="mute")
    # Owner also sets a pref on a private channel the outsider cannot read.
    await _put(client, owner["token"], stream_id=private, level="all")

    body = (await _get(client, owner["token"])).json()
    # The stream WITH an explicit pref appears; the one WITHOUT does not (absence =
    # default `all`, which GET never materializes).
    assert _entry(body, with_pref)["level"] == "mute"
    assert _maybe_entry(body, without_pref) is None

    # The outsider sees NONE of the owner's prefs — not the readable-to-owner one,
    # and certainly not the private one (never leaks across users or read boundary).
    outsider_body = (await _get(client, outsider["token"])).json()
    assert _maybe_entry(outsider_body, with_pref) is None
    assert _maybe_entry(outsider_body, private) is None


# --- D3 NEGATIVE GUARD (load-bearing): prefs is NEVER the log ----------------


async def test_put_prefs_is_not_an_event(client: AsyncClient, db_session: AsyncSession) -> None:
    """A prefs PUT creates NO ``events`` row and mutates NO projection (D3).

    Prefs are synced per-user KV, not the log — so the ``events`` count AND every
    rebuildable projection dump (``messages_proj`` / ``reactions_proj`` /
    ``thread_participants_proj`` / ``files``) are byte-for-byte unchanged across a
    PUT, while a ``prefs`` row DID appear (non-vacuous). A message is posted first
    so the projection dump carries real rows — the equality assertion is not over
    empty tables. Parity with the read-state analog
    (``test_read_state.py::test_put_read_state_is_not_an_event``), extended to all
    four projections.
    """
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    # Post a message so messages_proj (and the projection dump) is non-empty — the
    # before/after equality then compares REAL rows, not empty sets.
    resp = await post_batch(
        client, owner["token"], [wire_item(message_body(auth=owner, stream_id=channel))]
    )
    assert len(resp.json()["accepted"]) == 1, resp.text

    async def _events_count() -> int:
        return int((await db_session.execute(select(func.count()).select_from(Event))).scalar_one())

    async def _prefs_count() -> int:
        return int((await db_session.execute(select(func.count()).select_from(Pref))).scalar_one())

    async def _proj_dump() -> tuple[list[Any], list[Any], list[Any], list[Any]]:
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
        threads = (
            (
                await db_session.execute(
                    select(ThreadParticipantProj).order_by(
                        ThreadParticipantProj.root_message_id, ThreadParticipantProj.user_id
                    )
                )
            )
            .scalars()
            .all()
        )
        files = (await db_session.execute(select(File).order_by(File.file_id))).scalars().all()
        msg_dump = [(m.message_id, m.stream_id, m.text, m.created_seq, m.deleted) for m in msgs]
        react_dump = [(r.message_id, r.author_user_id, r.emoji) for r in reacts]
        thread_dump = [(t.root_message_id, t.user_id) for t in threads]
        file_dump = [(f.file_id, f.stream_id, f.present, f.thumbnail_sha256) for f in files]
        return msg_dump, react_dump, thread_dump, file_dump

    events_before = await _events_count()
    prefs_before = await _prefs_count()
    proj_before = await _proj_dump()

    resp = await _put(client, owner["token"], stream_id=channel, level="mentions")
    assert resp.status_code == 200, resp.text

    # The log is untouched — a pref is NOT an event.
    assert await _events_count() == events_before
    # And every rebuildable projection is byte-for-byte unchanged (matches the
    # module/model/schema docstrings' D3 promise).
    assert await _proj_dump() == proj_before
    # But the synced-KV row itself DID land (the write is real, just not the log).
    assert await _prefs_count() == prefs_before + 1
    row = await db_session.get(Pref, (owner["user_id"], channel))
    assert row is not None and row.level == "mentions"


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
    """The crux: a PUT echoes prefs to BOTH the user's devices; another user gets NOTHING."""
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

            resp = await _put(client, owner["token"], stream_id=channel, level="mute")
            assert resp.status_code == 200, resp.text

            # BOTH of the owner's devices receive the echo, with the exact wire shape.
            for ws in (ws1, ws2):
                frame = await _read_until(ws, "prefs")
                assert frame == {"t": "prefs", "stream_id": channel, "level": "mute"}

            # The OTHER user's socket receives nothing — prefs never cross users.
            with pytest.raises(TimeoutError):
                await ws_other.receive_json(timeout=0.3)


async def test_ws_echo_read_state_still_works(ws_app: FastAPI, db_session: AsyncSession) -> None:
    """The shared ``_publish_to_user`` refactor did NOT break read-state's echo (ENG-123 green)."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)

        async with _connect(client, owner["token"]) as ws:
            await _sync(ws)
            resp = await client.put(
                "/v1/read-state",
                json={"stream_id": channel, "last_read_seq": 7},
                headers=auth_header(owner["token"]),
            )
            assert resp.status_code == 200, resp.text
            frame = await _read_until(ws, "read_state")
            assert frame == {"t": "read_state", "stream_id": channel, "last_read_seq": 7}


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

            resp = await _put(client, owner["token"], stream_id=channel, level="all")
            # The PUT still succeeds and the pref is written despite the dead socket.
            assert resp.status_code == 200, resp.text
            assert resp.json()["level"] == "all"

            # The healthy socket still got its echo; the dead one is dropped + removed.
            frame = await _read_until(ws, "prefs")
            assert frame["level"] == "all"
            assert hub.connection_count() == 1
