"""Seam fills: /v1/setup + /v1/auth/accept-invite emit meta events (ENG-65 D2/D8)."""

from __future__ import annotations

from authutil import (
    accept_invite,
    create_invite,
    do_setup,
    fetch_meta_stream_id,
    fetch_stream_events,
    join_token,
)
from httpx import AsyncClient
from msgd.core.envelope import Body, Envelope
from msgd.core.hashing import hash_event, verify_hash
from msgd.db.models import Stream, StreamMember
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def test_setup_emits_meta_events_and_seeds_general_channel(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Setup homes workspace.created(1) + user.joined(2) + channel.created(3) for #general.

    ENG-109: the third meta event is a server-authored PUBLIC channel.created for
    the default `general` channel, so a fresh workspace is usable out of the box.
    """
    body = await do_setup(client)
    ws = body["workspace_id"]

    meta = await fetch_meta_stream_id(db_session, ws)
    assert meta is not None

    events = await fetch_stream_events(db_session, meta)
    assert [e.type for e in events] == ["workspace.created", "user.joined", "channel.created"]
    assert [e.server_sequence for e in events] == [1, 2, 3]

    wc, uj, cc = events
    # All three authored by the owner, using the owner's just-minted device (D2).
    assert wc.author_user_id == body["user_id"]
    assert wc.author_device_id == body["device_id"]
    assert uj.author_user_id == body["user_id"]
    assert uj.body["payload"]["user_id"] == body["user_id"]  # owner joins themselves
    assert cc.author_user_id == body["user_id"]
    assert cc.author_device_id == body["device_id"]
    # The default channel is public and named `general`, homed in workspace-meta.
    assert cc.body["payload"]["name"] == "general"
    assert cc.body["payload"]["visibility"] == "public"
    channel_stream_id = cc.body["payload"]["channel_stream_id"]

    # Raw-hash discipline: re-hash the verbatim stored body AND verify the model.
    for e in events:
        assert hash_event(e.body) == e.event_hash
        assert verify_hash(Envelope(body=Body(**e.body), event_hash=e.event_hash))

    # Exactly two streams exist: the workspace-meta + the seeded `general` channel.
    kinds = (
        (
            await db_session.execute(
                select(Stream.kind).where(Stream.workspace_id == ws).order_by(Stream.kind)
            )
        )
        .scalars()
        .all()
    )
    assert list(kinds) == ["channel", "workspace-meta"]

    # The channel got its OWN stream row (head_seq 0 — genesis is homed in meta).
    channel = await db_session.get(Stream, channel_stream_id)
    assert channel is not None
    assert channel.kind == "channel"
    assert channel.name == "general"
    assert channel.visibility == "public"
    assert channel.head_seq == 0

    # The owner was auto-subscribed as a member (the reducer's genesis member-add).
    member = await db_session.scalar(
        select(StreamMember).where(
            StreamMember.stream_id == channel_stream_id,
            StreamMember.user_id == body["user_id"],
        )
    )
    assert member is not None

    # The channel.created is homed in workspace-meta, so meta advances to seq 3.
    meta_row = await db_session.get(Stream, meta)
    assert meta_row is not None and meta_row.head_seq == 3


async def test_accept_invite_emits_user_joined_for_invitee(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Accepting an invite homes a user.joined for the invitee at the next meta seq."""
    owner = await do_setup(client)
    invite = await create_invite(client, owner["token"], role="member")
    raw = join_token(invite.json()["url"])

    accepted = await accept_invite(client, raw, email="joiner@example.com")
    assert accepted.status_code == 200, accepted.text
    joiner = accepted.json()

    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None
    events = await fetch_stream_events(db_session, meta)

    # setup(1,2,3 — ws.created, owner join, #general) then the invitee's join at seq 4.
    assert [e.type for e in events] == [
        "workspace.created",
        "user.joined",
        "channel.created",
        "user.joined",
    ]
    invitee_join = events[-1]
    assert invitee_join.server_sequence == 4
    assert invitee_join.author_user_id == joiner["user_id"]  # the joiner authors (D2)
    assert invitee_join.author_device_id == joiner["device_id"]
    assert invitee_join.body["payload"]["user_id"] == joiner["user_id"]

    assert hash_event(invitee_join.body) == invitee_join.event_hash
    assert verify_hash(Envelope(body=Body(**invitee_join.body), event_hash=invitee_join.event_hash))
