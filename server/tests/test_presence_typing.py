"""Presence + typing — the D3 EPHEMERAL message class (WS-only, ENG-125).

Presence (online/offline) and typing are a THIRD kind of state distinct from BOTH
durable events and synced per-user KV: **ephemeral**. They are WS-only — NEVER
appended to the log, hashed, projected, rebuilt, exported, or even persisted. The
load-bearing negative guard (:func:`test_presence_typing_never_touch_the_log`)
proves a full ``presence(online) → typing → typing → presence(offline)`` sequence
writes NO ``events`` row and mutates NO projection, and that there is no presence /
typing DB table at all — the state is purely in-memory.

Presence is DERIVED from the live connection registry (a user is online iff they
hold ≥1 socket); the router relays on the 0→1 (``online``) and 1→0 (``offline``)
transitions to SAME-workspace peers only. Typing is an inbound client frame,
rate-limited, gated on ``can_read`` (the SAME readable-streams predicate event
fanout uses), and relayed to the stream's OTHER connected readers — never to a
non-reader, never across a workspace, never back to the sender.

Driven with the ENG-68 WS harness (``ws_app`` + ``make_ws_client``), so connect +
inbound frame + relay all run in one rolled-back per-test transaction.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, cast

from authutil import accept_invite, create_invite, do_setup, join_token
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
from httpx_ws._api import AsyncWebSocketSession
from msgd.auth.sessions import utcnow
from msgd.auth.tokens import hash_token
from msgd.core import ids
from msgd.db.models import (
    Device,
    Event,
    File,
    MessageProj,
    ReactionProj,
    Session,
    Stream,
    ThreadParticipantProj,
    User,
    Workspace,
)
from msgd.ws.frames import presence_frame, typing_frame
from msgd.ws.hub import hub
from msgd.ws.registry import Connection
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocket

# --- socket helpers (mirrors the ENG-68 harness in test_ws.py) -------------------


def _bearer(token: str) -> list[str]:
    return ["bearer", token]


def _connect(client: AsyncClient, token: str) -> Any:
    """Open a WS to ``/v1/ws`` with ``token`` in the ``Sec-WebSocket-Protocol`` (off URL)."""
    return aconnect_ws("http://test/v1/ws", client=client, subprotocols=_bearer(token))


async def _read_until(ws: AsyncWebSocketSession, t: str, *, timeout: float = 2.0) -> dict[str, Any]:
    """Receive frames until one with ``t`` arrives (skips ping/pong + presence noise)."""
    while True:
        msg = await ws.receive_json(timeout=timeout)
        if isinstance(msg, dict) and msg.get("t") == t:
            return msg


async def _sync(ws: AsyncWebSocketSession) -> None:
    """Ping/pong barrier: a pong proves this socket is registered before we act."""
    await ws.send_json({"t": "ping"})
    await _read_until(ws, "pong")


async def _expect_no(ws: AsyncWebSocketSession, t: str, *, timeout: float = 0.3) -> None:
    """Assert NO frame of type ``t`` arrives within ``timeout`` (other frames tolerated).

    Presence/pong noise may legitimately be queued on a socket, so this drains
    whatever arrives and only fails on the forbidden ``t`` — the precise negative
    assertion the isolation crux needs.
    """
    while True:
        try:
            msg = await ws.receive_json(timeout=timeout)
        except TimeoutError:
            return
        assert not (isinstance(msg, dict) and msg.get("t") == t), f"unexpected {t} frame: {msg}"


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


async def _seed_workspace(db: AsyncSession, *, name: str) -> dict[str, str]:
    """Seed a full SECOND workspace (owner user + device + live session + streams).

    ``/v1/setup`` is single-tenant (409 once a user exists), so a second workspace
    for the cross-workspace isolation tests is seeded directly on the bound test
    session — the same session the app's ``get_session`` override yields, so a
    bearer token authenticates the WS handshake against it.
    """
    ws_id = ids.new_workspace_id()
    user_id = ids.new_user_id()
    device_id = ids.new_device_id()
    raw_token = f"seed-token-{ws_id}"

    db.add(Workspace(workspace_id=ws_id, name=name))
    await db.flush()
    db.add(
        User(
            user_id=user_id,
            workspace_id=ws_id,
            email=f"owner@{name}.example.com",
            password_hash="x",
            display_name="Seed Owner",
            role="owner",
        )
    )
    await db.flush()
    db.add(Device(device_id=device_id, user_id=user_id))
    await db.flush()
    db.add(
        Session(
            token_hash=hash_token(raw_token),
            user_id=user_id,
            device_id=device_id,
            expires_at=utcnow() + timedelta(days=1),
        )
    )
    db.add(Stream(stream_id=ids.new_stream_id(), workspace_id=ws_id, kind="workspace-meta"))
    await db.flush()
    return {"workspace_id": ws_id, "user_id": user_id, "token": raw_token}


# --- pure frame builders ---------------------------------------------------------


def test_presence_frame_shape() -> None:
    assert presence_frame(user_id="u_1", status="online") == {
        "t": "presence",
        "user_id": "u_1",
        "status": "online",
    }
    assert presence_frame(user_id="u_1", status="offline")["status"] == "offline"


def test_typing_frame_shape() -> None:
    assert typing_frame(stream_id="s_1", user_id="u_1") == {
        "t": "typing",
        "stream_id": "s_1",
        "user_id": "u_1",
    }


# --- presence: online / offline transitions, workspace-scoped --------------------


async def test_presence_online_relayed_to_workspace_peer(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A user's FIRST connection relays presence(online) to a same-workspace peer."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")

        async with _connect(client, owner["token"]) as ws_owner:
            await _sync(ws_owner)
            # The member's first connect is the 0→1 transition → owner is notified.
            async with _connect(client, member["token"]) as ws_member:
                await _sync(ws_member)
                frame = await _read_until(ws_owner, "presence")
                assert frame == {"t": "presence", "user_id": member["user_id"], "status": "online"}


async def test_presence_offline_on_last_disconnect(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A user's LAST disconnect relays presence(offline) to a same-workspace peer."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")

        async with _connect(client, owner["token"]) as ws_owner:
            await _sync(ws_owner)
            async with _connect(client, member["token"]) as ws_member:
                await _sync(ws_member)
                assert (await _read_until(ws_owner, "presence"))["status"] == "online"
            # ws_member closed → member's last socket gone → owner sees offline.
            frame = await _read_until(ws_owner, "presence")
            assert frame == {"t": "presence", "user_id": member["user_id"], "status": "offline"}


async def test_presence_multi_device_no_reonline_no_early_offline(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A SECOND device does not re-relay online; closing ONE of two does not relay offline."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")

        async with _connect(client, owner["token"]) as ws_owner:
            await _sync(ws_owner)
            async with _connect(client, member["token"]) as ws_m1:
                await _sync(ws_m1)
                assert (await _read_until(ws_owner, "presence"))["status"] == "online"

                async with _connect(client, member["token"]) as ws_m2:
                    await _sync(ws_m2)
                    # The 2nd device is 1→2, NOT 0→1 → NO second online relay.
                    await _expect_no(ws_owner, "presence")
                # Closing ws_m2 is 2→1, NOT 1→0 → NO offline relay (still online).
                await _expect_no(ws_owner, "presence")
            # Closing the last (ws_m1) is 1→0 → offline now relays.
            assert (await _read_until(ws_owner, "presence"))["status"] == "offline"


async def test_presence_never_crosses_workspace(ws_app: FastAPI, db_session: AsyncSession) -> None:
    """A different-workspace connection observes NO presence for a peer in another workspace."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        other = await _seed_workspace(db_session, name="beta")

        async with _connect(client, other["token"]) as ws_other:
            await _sync(ws_other)
            # The owner (workspace A) connecting must never reach workspace B.
            async with _connect(client, owner["token"]) as ws_owner:
                await _sync(ws_owner)
                await _expect_no(ws_other, "presence")


# --- presence: guests are scoped OUT entirely (§3.6 roster-consistency) -----------


async def test_presence_guest_broadcasts_nothing(ws_app: FastAPI, db_session: AsyncSession) -> None:
    """A GUEST connecting/disconnecting relays NO presence; a member in the same setup still does.

    Non-vacuous: the SAME observer (owner) sees a non-guest member's online/offline
    in this exact setup, so the assertion would catch a regression that started
    broadcasting guest presence.
    """
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        guest = await _invite_user(client, owner, role="guest")
        member = await _invite_user(client, owner, role="member")

        async with _connect(client, owner["token"]) as ws_owner:
            await _sync(ws_owner)
            # A guest's 0→1 connect broadcasts NOTHING to the owner.
            async with _connect(client, guest["token"]) as ws_guest:
                await _sync(ws_guest)
                await _expect_no(ws_owner, "presence")
                # Non-vacuous: a NON-guest member connecting DOES still broadcast.
                async with _connect(client, member["token"]) as ws_member:
                    await _sync(ws_member)
                    frame = await _read_until(ws_owner, "presence")
                    assert frame == {
                        "t": "presence",
                        "user_id": member["user_id"],
                        "status": "online",
                    }
                # member's last socket closed (1→0) → owner sees offline (relay is live).
                assert (await _read_until(ws_owner, "presence"))["status"] == "offline"
            # The guest's 1→0 disconnect ALSO broadcasts nothing.
            await _expect_no(ws_owner, "presence")


async def test_presence_guest_receives_nothing(ws_app: FastAPI, db_session: AsyncSession) -> None:
    """When a non-guest MEMBER goes online/offline, a connected GUEST receives NO presence.

    A non-guest observer (owner) DOES see the same transitions — the asymmetry proves
    the recipient filter excludes only the guest socket.
    """
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        guest = await _invite_user(client, owner, role="guest")
        member = await _invite_user(client, owner, role="member")

        async with (
            _connect(client, owner["token"]) as ws_owner,
            _connect(client, guest["token"]) as ws_guest,
        ):
            await _sync(ws_owner)
            await _sync(ws_guest)
            # A non-guest member goes online: the owner (member) sees it, the guest does not.
            async with _connect(client, member["token"]) as ws_member:
                await _sync(ws_member)
                frame = await _read_until(ws_owner, "presence")
                assert frame == {"t": "presence", "user_id": member["user_id"], "status": "online"}
                await _expect_no(ws_guest, "presence")
            # ...and offline: same asymmetry — owner sees it, the guest never does.
            assert (await _read_until(ws_owner, "presence"))["status"] == "offline"
            await _expect_no(ws_guest, "presence")


# --- typing: relay scope (the crux) ----------------------------------------------


async def test_typing_relays_to_stream_readers_only(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """CRUX: typing reaches the stream's OTHER readers — not the sender, not a non-reader."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        adversary = await _invite_user(client, owner, role="member")
        private = await bootstrap_channel(client, db_session, owner, visibility="private")
        await _member_event(client, owner, private_stream=private, target=member, added=True)

        async with (
            _connect(client, owner["token"]) as ws_owner,
            _connect(client, member["token"]) as ws_member,
            _connect(client, adversary["token"]) as ws_adv,
        ):
            await _sync(ws_owner)
            await _sync(ws_member)
            await _sync(ws_adv)

            await ws_member.send_json({"t": "typing", "stream_id": private})

            # The other reader (owner) gets it, tagged with the sender's id.
            frame = await _read_until(ws_owner, "typing")
            assert frame == {"t": "typing", "stream_id": private, "user_id": member["user_id"]}
            # The sender does NOT see itself typing; the non-member sees NOTHING.
            await _expect_no(ws_member, "typing")
            await _expect_no(ws_adv, "typing")


async def test_typing_dropped_on_unreadable_stream(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A user typing in a stream they CANNOT read → dropped, no relay (no oracle)."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        outsider = await _invite_user(client, owner, role="member")
        private = await bootstrap_channel(client, db_session, owner, visibility="private")
        # outsider is a workspace member but NOT in the private channel.

        async with (
            _connect(client, owner["token"]) as ws_owner,
            _connect(client, outsider["token"]) as ws_out,
        ):
            await _sync(ws_owner)
            await _sync(ws_out)

            # The outsider signals typing for a stream they can't read → gate drops it.
            await ws_out.send_json({"t": "typing", "stream_id": private})
            # The channel's reader (owner) receives NOTHING — the can_read gate held.
            await _expect_no(ws_owner, "typing")


async def test_typing_guest_only_in_joined_streams(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A guest cannot signal typing in a public channel they have not explicitly joined."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        guest = await _invite_user(client, owner, role="guest")
        public = await bootstrap_channel(client, db_session, owner)  # public channel

        async with (
            _connect(client, owner["token"]) as ws_owner,
            _connect(client, guest["token"]) as ws_guest,
        ):
            await _sync(ws_owner)
            await _sync(ws_guest)

            # A guest has NO explicit membership in the public channel → cannot read
            # it (§3.6) → typing is dropped, the owner sees nothing.
            await ws_guest.send_json({"t": "typing", "stream_id": public})
            await _expect_no(ws_owner, "typing")


async def test_typing_guest_works_in_joined_stream(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A guest explicitly added to a channel still SENDS and RECEIVES typing there.

    Regression guard for the ENG-125 presence follow-up: excluding guests from
    presence must NOT touch typing, which stays stream-membership-scoped — a guest
    with an explicit ``stream_members`` row participates in that stream's typing
    both ways.
    """
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        guest = await _invite_user(client, owner, role="guest")
        private = await bootstrap_channel(client, db_session, owner, visibility="private")
        # The guest is EXPLICITLY added to the private channel (§3.6 guest scope).
        await _member_event(client, owner, private_stream=private, target=guest, added=True)

        async with (
            _connect(client, owner["token"]) as ws_owner,
            _connect(client, guest["token"]) as ws_guest,
        ):
            await _sync(ws_owner)
            await _sync(ws_guest)

            # The guest can read the channel (explicit membership) → their typing relays.
            await ws_guest.send_json({"t": "typing", "stream_id": private})
            frame = await _read_until(ws_owner, "typing")
            assert frame == {"t": "typing", "stream_id": private, "user_id": guest["user_id"]}

            # ...and the guest RECEIVES the other member's typing (bidirectional).
            await ws_owner.send_json({"t": "typing", "stream_id": private})
            frame = await _read_until(ws_guest, "typing")
            assert frame == {"t": "typing", "stream_id": private, "user_id": owner["user_id"]}


async def test_typing_never_crosses_workspace(ws_app: FastAPI, db_session: AsyncSession) -> None:
    """Typing for a workspace-A stream never reaches a workspace-B connection."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        channel = await bootstrap_channel(client, db_session, owner)
        other = await _seed_workspace(db_session, name="beta")

        async with (
            _connect(client, owner["token"]) as ws_owner,
            _connect(client, other["token"]) as ws_other,
        ):
            await _sync(ws_owner)
            await _sync(ws_other)

            await ws_owner.send_json({"t": "typing", "stream_id": channel})
            # Workspace B never sees workspace A's typing (resolver filters by ws).
            await _expect_no(ws_other, "typing")


# --- typing: rate-limit ----------------------------------------------------------


async def test_typing_rate_limited(ws_app: FastAPI, db_session: AsyncSession) -> None:
    """Two typing frames within the throttle window relay only ONCE; after it, again."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        channel = await bootstrap_channel(client, db_session, owner)  # public, member-readable

        async with (
            _connect(client, owner["token"]) as ws_owner,
            _connect(client, member["token"]) as ws_member,
        ):
            await _sync(ws_owner)
            await _sync(ws_member)

            # Two back-to-back frames land inside the ~1/3 s window: first relays.
            await ws_member.send_json({"t": "typing", "stream_id": channel})
            await ws_member.send_json({"t": "typing", "stream_id": channel})
            assert (await _read_until(ws_owner, "typing"))["user_id"] == member["user_id"]
            # The second was throttled — no further typing frame arrives.
            await _expect_no(ws_owner, "typing", timeout=0.2)

            # After the window elapses, a fresh frame relays again.
            await asyncio.sleep(0.4)
            await ws_member.send_json({"t": "typing", "stream_id": channel})
            assert (await _read_until(ws_owner, "typing"))["user_id"] == member["user_id"]


# --- malformed inbound tolerance (D9) --------------------------------------------


async def test_malformed_typing_ignored_connection_alive(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A typing frame with a missing/invalid stream_id, a binary frame, unknown t → ignored."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        async with _connect(client, owner["token"]) as ws:
            await _sync(ws)
            await ws.send_json({"t": "typing"})  # missing stream_id
            await ws.send_json({"t": "typing", "stream_id": ""})  # empty
            await ws.send_json({"t": "typing", "stream_id": 123})  # non-str
            await ws.send_json({"t": "presence", "status": "online"})  # inbound presence ignored
            await ws.send_bytes(b"\x00\x01\x02")  # binary → ignored
            await ws.send_text("not-json{{{")  # garbage → ignored
            await ws.send_json({"no_type": True})  # unknown → ignored
            # Still open and responsive.
            await ws.send_json({"t": "ping"})
            assert await _read_until(ws, "pong") == {"t": "pong"}


# --- best-effort relay: a dead recipient never fails the relay/sender ------------


class _DeadSocket:
    """A socket whose send always fails — stands in for a wedged/dead client."""

    async def send_json(self, data: Any, mode: str = "text") -> None:
        raise RuntimeError("dead socket")


async def test_typing_relay_survives_dead_recipient(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A dead recipient socket is dropped without failing the relay or the sender."""
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        channel = await bootstrap_channel(client, db_session, owner)

        async with (
            _connect(client, owner["token"]) as ws_owner,
            _connect(client, member["token"]) as ws_member,
        ):
            await _sync(ws_owner)
            await _sync(ws_member)

            # Inject a dead reader for the OWNER directly into the registry.
            dead = Connection(
                websocket=cast(WebSocket, _DeadSocket()),
                user_id=owner["user_id"],
                role=owner["role"],
                workspace_id=owner["workspace_id"],
                device_id=ids.new_device_id(),
            )
            assert hub.try_register(dead, max_connections=100)
            before = hub.connection_count()

            await ws_member.send_json({"t": "typing", "stream_id": channel})
            # The healthy owner socket still receives the typing frame...
            assert (await _read_until(ws_owner, "typing"))["user_id"] == member["user_id"]
            # ...and the dead socket was dropped + deregistered.
            assert hub.connection_count() == before - 1


# --- NEGATIVE GUARD (the hard requirement): ephemeral, never the log -------------


async def test_presence_typing_never_touch_the_log(
    ws_app: FastAPI, db_session: AsyncSession
) -> None:
    """A full presence→typing→typing→presence sequence writes NO event, mutates NO projection.

    The load-bearing D3 guard: presence/typing are ephemeral (WS-only). Across the
    whole lifecycle the ``events`` count and EVERY projection dump
    (``messages_proj`` / ``reactions_proj`` / ``thread_participants_proj`` /
    ``files``) stay byte-for-byte identical, and there is NO presence/typing DB
    table. Non-vacuous: a real message is seeded first, so the projections are
    non-empty and a mutation WOULD be detected.
    """
    async with make_ws_client(ws_app) as client:
        owner = await do_setup(client)
        member = await _invite_user(client, owner, role="member")
        channel = await bootstrap_channel(client, db_session, owner)

        # Seed a real message so the projections are non-empty (non-vacuous guard).
        seed = message_body(auth=owner, stream_id=channel, text="seeded")
        resp = await post_batch(client, owner["token"], [wire_item(seed)])
        assert len(resp.json()["accepted"]) == 1, resp.text

        async def _events_count() -> int:
            return int(
                (await db_session.execute(select(func.count()).select_from(Event))).scalar_one()
            )

        async def _proj_dump() -> dict[str, list[Any]]:
            msgs = (
                (await db_session.execute(select(MessageProj).order_by(MessageProj.message_id)))
                .scalars()
                .all()
            )
            reacts = (
                (
                    await db_session.execute(
                        select(ReactionProj).order_by(
                            ReactionProj.message_id,
                            ReactionProj.author_user_id,
                            ReactionProj.emoji,
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
                            ThreadParticipantProj.root_message_id,
                            ThreadParticipantProj.user_id,
                        )
                    )
                )
                .scalars()
                .all()
            )
            files = (await db_session.execute(select(File).order_by(File.file_id))).scalars().all()
            return {
                "messages": [
                    (m.message_id, m.stream_id, m.text, m.created_seq, m.deleted) for m in msgs
                ],
                "reactions": [(r.message_id, r.author_user_id, r.emoji) for r in reacts],
                "threads": [(t.root_message_id, t.user_id) for t in threads],
                "files": [(f.file_id, f.sha256, f.present) for f in files],
            }

        events_before = await _events_count()
        proj_before = await _proj_dump()
        assert proj_before["messages"], "guard is vacuous — projections must be non-empty"

        # Drive the full ephemeral lifecycle: presence(online) → typing → typing →
        # presence(offline), all over live WebSockets.
        async with _connect(client, owner["token"]) as ws_owner:
            await _sync(ws_owner)
            async with _connect(client, member["token"]) as ws_member:
                await _sync(ws_member)
                assert (await _read_until(ws_owner, "presence"))["status"] == "online"

                await ws_member.send_json({"t": "typing", "stream_id": channel})
                assert (await _read_until(ws_owner, "typing"))["user_id"] == member["user_id"]
                # A second (throttled) typing frame — still no persistence either way.
                await ws_member.send_json({"t": "typing", "stream_id": channel})
                await _expect_no(ws_owner, "typing", timeout=0.2)
            # member disconnected → presence(offline).
            assert (await _read_until(ws_owner, "presence"))["status"] == "offline"

        # The log and EVERY projection are byte-identical — nothing was persisted.
        assert await _events_count() == events_before
        assert await _proj_dump() == proj_before

        # And there is NO presence/typing table — the state is purely in-memory.
        tables = (
            (
                await db_session.execute(
                    text(
                        "SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema = 'public'"
                    )
                )
            )
            .scalars()
            .all()
        )
        assert not any("presence" in name or "typing" in name for name in tables), tables
