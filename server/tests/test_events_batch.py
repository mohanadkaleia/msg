"""``POST /v1/events/batch`` endpoint acceptance (ENG-66).

Covers the §3.2 response shaping, batch caps, all five rejection codes, the
raw-hash discipline (coercion tamper + redacted smuggling), per-event isolation
and ordering, homing, unknown types (D9), the archived-write gate, idempotency,
the D13 adversary case, the WS seam, and the per-user rate limit.
"""

from __future__ import annotations

from typing import Any

import pytest
from authutil import (
    accept_invite,
    auth_header,
    create_invite,
    do_setup,
    fetch_meta_stream_id,
    fetch_stream,
    fetch_stream_events,
    join_token,
    make_app,
    make_client,
)
from eventsutil import (
    BATCH_URL,
    bootstrap_channel,
    channel_created_body,
    custom_body,
    dm_created_body,
    lifecycle_body,
    message_body,
    post_batch,
    wire_item,
)
from httpx import AsyncClient
from msgd.auth.ratelimit import RateLimiter
from msgd.core import ids
from msgd.core.envelope import Envelope
from msgd.core.hashing import hash_event
from msgd.db.models import Event, Stream, StreamMember, User, Workspace
from msgd.settings import Settings
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession


async def _invite_user(client: AsyncClient, owner: dict[str, Any], *, role: str) -> dict[str, Any]:
    """Create + accept an invite; return the new user's auth dict."""
    invite = await create_invite(client, owner["token"], role=role)
    raw = join_token(invite.json()["url"])
    accepted = await accept_invite(client, raw, email=f"{ids.new_ulid().lower()}@example.com")
    assert accepted.status_code == 200, accepted.text
    body: dict[str, Any] = accepted.json()
    return body


async def _event_rows(db: AsyncSession, event_id: str) -> list[Event]:
    rows = await db.execute(select(Event).where(Event.event_id == event_id))
    return list(rows.scalars().all())


# --- accept path + response shape ------------------------------------------------


async def test_message_upload_accepted_and_stored_verbatim(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A valid message is sequenced at 1 in its channel and stored byte-faithfully."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    body = message_body(auth=owner, stream_id=channel, text="first!")
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["rejected"] == []
    (entry,) = payload["accepted"]
    assert entry["event_id"] == body["event_id"]
    assert entry["stream_id"] == channel
    assert entry["server_sequence"] == 1
    assert entry["server_received_at"].endswith("Z")

    (row,) = await _event_rows(db_session, body["event_id"])
    assert row.body == body  # verbatim — the raw dict, not a model round-trip
    assert hash_event(row.body) == row.event_hash
    assert row.payload_redacted is False


async def test_empty_batch_returns_empty_arrays(client: AsyncClient) -> None:
    owner = await do_setup(client)
    resp = await post_batch(client, owner["token"], [])
    assert resp.status_code == 200
    assert resp.json() == {"accepted": [], "rejected": []}


# --- batch-level caps + malformed top-level ---------------------------------------


async def test_malformed_top_level_is_422(client: AsyncClient) -> None:
    owner = await do_setup(client)
    headers = {**auth_header(owner["token"]), "content-type": "application/json"}

    for content in (b"not json", b"[1,2]", b'{"events": 5}', b"{}"):
        resp = await client.post(BATCH_URL, content=content, headers=headers)
        assert resp.status_code == 422, content
        assert resp.json()["type"] == "/problems/validation-error"


async def test_batch_count_cap_422(client: AsyncClient) -> None:
    """>100 events → 422 /problems/batch-too-large (whole request rejected)."""
    owner = await do_setup(client)
    resp = await post_batch(client, owner["token"], [{} for _ in range(101)])
    assert resp.status_code == 422
    assert resp.json()["type"] == "/problems/batch-too-large"


async def test_batch_body_cap_413(client: AsyncClient) -> None:
    """Body >1 MB → 413 /problems/payload-too-large (whole request rejected)."""
    owner = await do_setup(client)
    headers = {**auth_header(owner["token"]), "content-type": "application/json"}
    blob = b'{"events": [{"body": {"pad": "' + b"a" * 1_100_000 + b'"}}]}'
    resp = await client.post(BATCH_URL, content=blob, headers=headers)
    assert resp.status_code == 413
    assert resp.json()["type"] == "/problems/payload-too-large"


async def test_per_event_size_cap_is_a_rejection_not_a_problem(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A >64 KB event lands in rejected[] with code payload_too_large (200 OK)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    body = message_body(auth=owner, stream_id=channel, text="x" * 70_000)
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert resp.status_code == 200
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "payload_too_large"
    assert entry["event_id"] == body["event_id"]


# --- per-event isolation + in-batch ordering ---------------------------------------


async def test_bad_event_does_not_sink_neighbors(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """[valid, invalid, valid] → 2 accepted (persisted, consecutive), 1 rejected."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    first = message_body(auth=owner, stream_id=channel, text="one")
    tampered = message_body(auth=owner, stream_id=channel, text="two")
    third = message_body(auth=owner, stream_id=channel, text="three")
    items = [
        wire_item(first),
        {"body": tampered, "event_hash": "sha256:" + "0" * 64},
        wire_item(third),
    ]
    resp = await post_batch(client, owner["token"], items)
    assert resp.status_code == 200
    payload = resp.json()
    assert [e["code"] for e in payload["rejected"]] == ["hash_mismatch"]
    assert [e["server_sequence"] for e in payload["accepted"]] == [1, 2]  # batch order
    assert [e["event_id"] for e in payload["accepted"]] == [
        first["event_id"],
        third["event_id"],
    ]
    events = await fetch_stream_events(db_session, channel)
    assert [e.body["payload"]["text"] for e in events] == ["one", "three"]


# --- idempotency (point 6 / D7) -----------------------------------------------------


async def test_idempotent_reupload_returns_original_record(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-uploading the same {body, event_hash} reproduces the ORIGINAL accepted entry."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    item = wire_item(message_body(auth=owner, stream_id=channel))

    first = await post_batch(client, owner["token"], [item])
    assert first.status_code == 200, first.text
    (original,) = first.json()["accepted"]

    again = await post_batch(client, owner["token"], [item])
    assert again.status_code == 200, again.text
    (replay,) = again.json()["accepted"]
    assert replay == original  # same sequence, stream AND server_received_at string

    # Exactly one stored row; no sequence was consumed by the replay.
    rows = await _event_rows(db_session, item["body"]["event_id"])
    assert len(rows) == 1
    stream_row = await fetch_stream(db_session, channel)
    assert stream_row is not None and stream_row.head_seq == 1


async def test_ws_seam_invoked_once_per_new_accept(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """publish_event fires once per NEWLY accepted event, never on re-accepts."""
    # ENG-161: the post-commit publish call site lives in the shared write
    # helper (msgd.events.write.store_event), which both the batch router and
    # the hook receiver run — patch it there.
    import msgd.events.write as write_module

    published: list[Envelope] = []

    async def spy(envelope: Envelope) -> None:
        published.append(envelope)

    monkeypatch.setattr(write_module, "publish_event", spy)

    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    item = wire_item(message_body(auth=owner, stream_id=channel))

    await post_batch(client, owner["token"], [item])
    assert len(published) == 2  # the channel genesis + the message
    await post_batch(client, owner["token"], [item])  # idempotent re-accept
    assert len(published) == 2  # NOT re-published
    assert published[-1].body.event_id == item["body"]["event_id"]


# --- raw-hash discipline: coercion tamper + redaction smuggling ---------------------


async def test_coercion_tamper_hash_mismatch(client: AsyncClient, db_session: AsyncSession) -> None:
    """'"type_version":"1"' with a hash over int 1 → hash_mismatch (raw-faithful)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    body_int = message_body(auth=owner, stream_id=channel)
    stale = hash_event(body_int)
    body_str = dict(body_int)
    body_str["type_version"] = "1"
    resp = await post_batch(client, owner["token"], [{"body": body_str, "event_hash": stale}])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "hash_mismatch"

    # Companion (DOCUMENTED DEVIATION): the honestly-hashed string form is
    # rejected invalid_schema by the storability gate (insert_event's INTEGER
    # convenience column cannot store a str) instead of the plan's "accepted and
    # stored verbatim" — see validate.py.
    honest = await post_batch(client, owner["token"], [wire_item(body_str)])
    (entry,) = honest.json()["rejected"]
    assert entry["code"] == "invalid_schema"


async def test_redacted_smuggle_is_inert(client: AsyncClient, db_session: AsyncSession) -> None:
    """Client-supplied server/signature never influence acceptance (point 3)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    # Wrong hash + smuggled payload_redacted → hash_mismatch (verify_hash's
    # redaction exemption is unreachable: the validator never calls it).
    body = message_body(auth=owner, stream_id=channel)
    smuggled = {
        "body": body,
        "event_hash": "sha256:" + "0" * 64,
        "server": {"payload_redacted": True, "server_sequence": 1},
        "signature": "forged",
    }
    resp = await post_batch(client, owner["token"], [smuggled])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "hash_mismatch"

    # Correct hash + smuggled flag → accepted, stored payload_redacted=False.
    ok_item = {
        "body": body,
        "event_hash": hash_event(body),
        "server": {"payload_redacted": True},
        "signature": "forged",
    }
    resp = await post_batch(client, owner["token"], [ok_item])
    assert len(resp.json()["accepted"]) == 1, resp.text
    (row,) = await _event_rows(db_session, body["event_id"])
    assert row.payload_redacted is False
    assert row.body == body  # no smuggled key leaked into storage


# --- permission_denied family --------------------------------------------------------


async def test_author_and_workspace_binding(client: AsyncClient, db_session: AsyncSession) -> None:
    owner = await do_setup(client)
    member = await _invite_user(client, owner, role="member")
    channel = await bootstrap_channel(client, db_session, owner)

    for override in (
        {"author_user_id": member["user_id"]},  # someone else's identity
        {"author_device_id": ids.new_device_id()},  # not the session's device
        {"workspace_id": ids.new_workspace_id()},  # foreign workspace
    ):
        body = message_body(auth=owner, stream_id=channel, **override)
        resp = await post_batch(client, owner["token"], [wire_item(body)])
        (entry,) = resp.json()["rejected"]
        assert entry["code"] == "permission_denied", override


async def test_adversary_write_nondisclosure(client: AsyncClient, db_session: AsyncSession) -> None:
    """D13: absent vs forbidden private stream → IDENTICAL code + detail."""
    owner = await do_setup(client)
    member = await _invite_user(client, owner, role="member")
    private = await bootstrap_channel(client, db_session, owner, visibility="private")

    to_private = message_body(auth=member, stream_id=private)
    to_absent = message_body(auth=member, stream_id=ids.new_stream_id())
    resp = await post_batch(client, member["token"], [wire_item(to_private), wire_item(to_absent)])
    forbidden, absent = resp.json()["rejected"]
    assert forbidden["code"] == "permission_denied"
    assert (forbidden["code"], forbidden["detail"]) == (absent["code"], absent["detail"])


async def test_guest_channel_created_denied(client: AsyncClient, db_session: AsyncSession) -> None:
    owner = await do_setup(client)
    guest = await _invite_user(client, owner, role="guest")
    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None
    body = channel_created_body(auth=guest, home_stream_id=meta)
    resp = await post_batch(client, guest["token"], [wire_item(body)])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "permission_denied"


async def test_dm_created_end_to_end(client: AsyncClient, db_session: AsyncSession) -> None:
    """ENG-104: a member opens a DM; both participants can read/write it, an outsider cannot.

    Drives the real endpoint: dm.created accept → the DM stream + participant
    membership rows are created by the reducer → each participant may post a
    message → a non-participant member sees the DM as absent (404-equivalent
    permission_denied, D13 non-disclosure).
    """
    owner = await do_setup(client)
    member = await _invite_user(client, owner, role="member")
    outsider = await _invite_user(client, owner, role="member")

    dm = ids.new_stream_id()
    genesis = dm_created_body(
        auth=member,
        dm_stream_id=dm,
        member_user_ids=[member["user_id"], owner["user_id"]],
    )
    resp = await post_batch(client, member["token"], [wire_item(genesis)])
    assert len(resp.json()["accepted"]) == 1, resp.text

    # The reducer created the DM stream (kind dm) + one membership row per participant.
    stream_row = await fetch_stream(db_session, dm)
    assert stream_row is not None and stream_row.kind == "dm" and stream_row.visibility is None
    members = (
        (await db_session.execute(select(StreamMember.user_id).where(StreamMember.stream_id == dm)))
        .scalars()
        .all()
    )
    assert set(members) == {member["user_id"], owner["user_id"]}

    # Both participants may post into the DM.
    for participant in (member, owner):
        resp = await post_batch(
            client, participant["token"], [wire_item(message_body(auth=participant, stream_id=dm))]
        )
        assert len(resp.json()["accepted"]) == 1, resp.text

    # An outsider (workspace member, non-participant) cannot write — and the DM is
    # non-disclosed: identical code+detail to a never-existed stream (D13).
    to_dm = message_body(auth=outsider, stream_id=dm)
    to_absent = message_body(auth=outsider, stream_id=ids.new_stream_id())
    resp = await post_batch(client, outsider["token"], [wire_item(to_dm), wire_item(to_absent)])
    forbidden, absent = resp.json()["rejected"]
    assert forbidden["code"] == "permission_denied"
    assert (forbidden["code"], forbidden["detail"]) == (absent["code"], absent["detail"])


async def test_dm_created_author_not_participant_denied(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """ENG-104: a member cannot open a DM that excludes themselves → permission_denied."""
    owner = await do_setup(client)
    member = await _invite_user(client, owner, role="member")
    other = await _invite_user(client, owner, role="member")

    dm = ids.new_stream_id()
    genesis = dm_created_body(
        auth=member,
        dm_stream_id=dm,
        member_user_ids=[owner["user_id"], other["user_id"]],  # author omitted
    )
    resp = await post_batch(client, member["token"], [wire_item(genesis)])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "permission_denied"
    # No DM stream leaked into existence.
    assert await fetch_stream(db_session, dm) is None


async def test_guest_dm_created_denied(client: AsyncClient, db_session: AsyncSession) -> None:
    """ENG-104/§3.6: a guest cannot open a DM (scoped) → permission_denied."""
    owner = await do_setup(client)
    guest = await _invite_user(client, owner, role="guest")
    dm = ids.new_stream_id()
    genesis = dm_created_body(
        auth=guest,
        dm_stream_id=dm,
        member_user_ids=[guest["user_id"], owner["user_id"]],
    )
    resp = await post_batch(client, guest["token"], [wire_item(genesis)])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "permission_denied"


async def test_archived_write_gate(client: AsyncClient, db_session: AsyncSession) -> None:
    """Obligation b: archive via the endpoint, then message.created → permission_denied."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None

    archive = lifecycle_body(
        auth=owner,
        home_stream_id=meta,
        type="channel.archived",
        payload={"channel_stream_id": channel},
    )
    resp = await post_batch(client, owner["token"], [wire_item(archive)])
    assert len(resp.json()["accepted"]) == 1, resp.text

    msg = message_body(auth=owner, stream_id=channel)
    resp = await post_batch(client, owner["token"], [wire_item(msg)])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "permission_denied"


# --- invalid_schema family: genesis collision + homing -------------------------------


async def test_genesis_collision_rejected_no_side_effects(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Obligation a: adopting an existing stream id → invalid_schema, no membership grant."""
    owner = await do_setup(client)
    member = await _invite_user(client, owner, role="member")
    channel = await bootstrap_channel(client, db_session, owner)
    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None
    meta_row = await fetch_stream(db_session, meta)
    assert meta_row is not None
    head_before = meta_row.head_seq

    body = channel_created_body(auth=member, home_stream_id=meta, channel_stream_id=channel)
    resp = await post_batch(client, member["token"], [wire_item(body)])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "invalid_schema"

    # The reducer never ran: no cross-stream read grant for the colliding author
    # (the ENG-65 reducer guard is the backstop; this validator is the primary gate).
    grant = await db_session.scalar(
        select(StreamMember).where(
            StreamMember.stream_id == channel, StreamMember.user_id == member["user_id"]
        )
    )
    assert grant is None
    meta_row = await fetch_stream(db_session, meta)
    assert meta_row is not None and meta_row.head_seq == head_before  # no sequence burned


async def test_homing_rules_end_to_end(client: AsyncClient, db_session: AsyncSession) -> None:
    """§2.2: violations → invalid_schema; correct homing sequences per the spec."""
    owner = await do_setup(client)
    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None

    # Private genesis homed in workspace-meta → invalid_schema.
    body = channel_created_body(auth=owner, home_stream_id=meta, visibility="private")
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert resp.json()["rejected"][0]["code"] == "invalid_schema"

    # Public genesis homed anywhere but meta → invalid_schema.
    stray = ids.new_stream_id()
    body = channel_created_body(
        auth=owner, home_stream_id=stray, channel_stream_id=stray, visibility="public"
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert resp.json()["rejected"][0]["code"] == "invalid_schema"

    # Correct private: self-homed genesis at sequence 1 of its own stream.
    private_id = ids.new_stream_id()
    body = channel_created_body(
        auth=owner, home_stream_id=private_id, channel_stream_id=private_id, visibility="private"
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    (entry,) = resp.json()["accepted"]
    assert (entry["stream_id"], entry["server_sequence"]) == (private_id, 1)

    # Correct public: appended to meta; the channel's own stream stays head_seq=0.
    public_id = ids.new_stream_id()
    body = channel_created_body(
        auth=owner, home_stream_id=meta, channel_stream_id=public_id, visibility="public"
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    (entry,) = resp.json()["accepted"]
    assert entry["stream_id"] == meta
    channel_row = await fetch_stream(db_session, public_id)
    assert channel_row is not None and channel_row.head_seq == 0


# --- unknown_stream (the non-leaky lifecycle referential) -----------------------------


async def test_lifecycle_unknown_stream(client: AsyncClient, db_session: AsyncSession) -> None:
    owner = await do_setup(client)
    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None
    body = lifecycle_body(
        auth=owner,
        home_stream_id=meta,
        type="channel.renamed",
        payload={"channel_stream_id": ids.new_stream_id(), "name": "ghost"},
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "unknown_stream"


# --- F1: cross-tenant lifecycle isolation + strict lifecycle homing -------------------


class _ForeignTenant:
    """Workspace B seeded via DIRECT DB rows (a stand-in for another tenant)."""

    def __init__(self) -> None:
        self.ws = ids.new_workspace_id()
        self.user = ids.new_user_id()
        self.meta = ids.new_stream_id()
        self.pub = ids.new_stream_id()
        self.priv = ids.new_stream_id()
        self.dm = ids.new_stream_id()


async def _seed_foreign_tenant(db: AsyncSession) -> _ForeignTenant:
    """Seed tenant B directly.

    Single-workspace ``/v1/setup`` runs exactly once and cannot mint a SECOND
    workspace, so B's rows are inserted straight into the DB. B's public channel
    carries a non-trivial ``head_seq`` + name + member so the isolation asserts
    can prove nothing changed.
    """
    b = _ForeignTenant()
    db.add(Workspace(workspace_id=b.ws, name="Bravo"))
    await db.flush()
    db.add(
        User(
            user_id=b.user,
            workspace_id=b.ws,
            email="b@example.com",
            password_hash="x",
            display_name="B",
            role="owner",
        )
    )
    db.add(Stream(stream_id=b.meta, workspace_id=b.ws, kind="workspace-meta", head_seq=3))
    db.add(
        Stream(
            stream_id=b.pub,
            workspace_id=b.ws,
            kind="channel",
            name="bee-public",
            visibility="public",
            head_seq=5,
        )
    )
    db.add(
        Stream(
            stream_id=b.priv,
            workspace_id=b.ws,
            kind="channel",
            name="bee-private",
            visibility="private",
            head_seq=2,
        )
    )
    db.add(Stream(stream_id=b.dm, workspace_id=b.ws, kind="dm", head_seq=1))
    await db.flush()
    db.add(StreamMember(stream_id=b.pub, user_id=b.user))
    db.add(StreamMember(stream_id=b.priv, user_id=b.user))
    await db.flush()
    return b


async def _stream_snapshot(db: AsyncSession, stream_id: str) -> tuple[Any, ...]:
    row = await fetch_stream(db, stream_id)
    assert row is not None
    member_count = await db.scalar(
        select(func.count()).select_from(StreamMember).where(StreamMember.stream_id == stream_id)
    )
    return (row.name, row.visibility, row.head_seq, row.archived_at, member_count)


async def test_cross_tenant_lifecycle_is_inert_and_nondisclosing(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """F1: A's admin cannot rename/archive/mutate a workspace-B stream, and B's id
    is indistinguishable from a never-existed id (unknown_stream, same detail)."""
    owner = await do_setup(client)  # A's owner (owner ∈ admin-ish → may fire lifecycle)
    a_meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert a_meta is not None
    b = await _seed_foreign_tenant(db_session)
    before = await _stream_snapshot(db_session, b.pub)

    # A-admin aims every lifecycle type at B's channel id (homed at A's meta so the
    # only failing gate is the workspace-scoped target resolution).
    attacks = [
        ("channel.renamed", {"channel_stream_id": b.pub, "name": "PWNED"}),
        ("channel.archived", {"channel_stream_id": b.pub}),
        ("channel.member_added", {"channel_stream_id": b.pub, "user_id": owner["user_id"]}),
        ("channel.member_removed", {"channel_stream_id": b.pub, "user_id": b.user}),
    ]
    for type_, payload in attacks:
        body = lifecycle_body(auth=owner, home_stream_id=a_meta, type=type_, payload=payload)
        resp = await post_batch(client, owner["token"], [wire_item(body)])
        (entry,) = resp.json()["rejected"]
        assert entry["code"] == "unknown_stream", (type_, resp.text)

    # Mutation AND injection both dead: B's stream is byte-for-byte unchanged.
    assert await _stream_snapshot(db_session, b.pub) == before

    # Non-disclosure pin: B's stream id and a random nonexistent id → identical
    # code AND detail (no cross-tenant existence oracle).
    b_target = lifecycle_body(
        auth=owner,
        home_stream_id=a_meta,
        type="channel.renamed",
        payload={"channel_stream_id": b.pub, "name": "x"},
    )
    ghost_target = lifecycle_body(
        auth=owner,
        home_stream_id=a_meta,
        type="channel.renamed",
        payload={"channel_stream_id": ids.new_stream_id(), "name": "x"},
    )
    resp = await post_batch(client, owner["token"], [wire_item(b_target), wire_item(ghost_target)])
    b_rej, ghost_rej = resp.json()["rejected"]
    assert b_rej["code"] == "unknown_stream"
    assert (b_rej["code"], b_rej["detail"]) == (ghost_rej["code"], ghost_rej["detail"])


async def test_lifecycle_homed_at_foreign_stream_is_invalid_schema(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """F1: a valid A target but the event HOMED at a B stream id → invalid_schema.

    The target resolves (A's own public channel), so the failing gate is strict
    §2.2 homing: a public target must home at A's workspace-meta, not B's stream.
    B's log is never touched (head_seq unchanged) — no cross-tenant injection.
    """
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner, visibility="public")
    b = await _seed_foreign_tenant(db_session)
    b_head_before = (await fetch_stream(db_session, b.meta)).head_seq  # type: ignore[union-attr]

    body = lifecycle_body(
        auth=owner,
        home_stream_id=b.meta,  # inject into B's meta log
        type="channel.renamed",
        payload={"channel_stream_id": channel, "name": "new"},
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "invalid_schema"
    b_meta = await fetch_stream(db_session, b.meta)
    assert b_meta is not None and b_meta.head_seq == b_head_before


async def test_lifecycle_kind_gate_blocks_dm_and_meta_graft(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """F1: channel.member_added aimed at one's OWN dm/meta stream id → unknown_stream.

    Closes the intra-tenant membership-graft hole without a DM existence oracle
    (same code as a nonexistent channel); no stream_members row is created.
    """
    owner = await do_setup(client)
    a_meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert a_meta is not None
    # An A-owned DM stream (direct row — no DM endpoint in M1).
    a_dm = ids.new_stream_id()
    db_session.add(Stream(stream_id=a_dm, workspace_id=owner["workspace_id"], kind="dm"))
    await db_session.flush()

    for target in (a_dm, a_meta):
        body = lifecycle_body(
            auth=owner,
            home_stream_id=a_meta,
            type="channel.member_added",
            payload={"channel_stream_id": target, "user_id": owner["user_id"]},
        )
        resp = await post_batch(client, owner["token"], [wire_item(body)])
        (entry,) = resp.json()["rejected"]
        assert entry["code"] == "unknown_stream", target
        grant = await db_session.scalar(
            select(StreamMember).where(
                StreamMember.stream_id == target, StreamMember.user_id == owner["user_id"]
            )
        )
        assert grant is None


async def test_lifecycle_correct_homing_accepted(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """F1 positive controls: correctly-homed rename of A's public (meta) + private (self)."""
    owner = await do_setup(client)
    a_meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert a_meta is not None
    public = await bootstrap_channel(client, db_session, owner, visibility="public")
    private = await bootstrap_channel(client, db_session, owner, visibility="private")

    # public target → homed in workspace-meta.
    pub_rename = lifecycle_body(
        auth=owner,
        home_stream_id=a_meta,
        type="channel.renamed",
        payload={"channel_stream_id": public, "name": "renamed-public"},
    )
    resp = await post_batch(client, owner["token"], [wire_item(pub_rename)])
    assert len(resp.json()["accepted"]) == 1, resp.text

    # private target → self-homed in the channel's own stream.
    priv_rename = lifecycle_body(
        auth=owner,
        home_stream_id=private,
        type="channel.renamed",
        payload={"channel_stream_id": private, "name": "renamed-private"},
    )
    resp = await post_batch(client, owner["token"], [wire_item(priv_rename)])
    assert len(resp.json()["accepted"]) == 1, resp.text
    row = await fetch_stream(db_session, private)
    assert row is not None and row.name == "renamed-private"


# --- security round 2: CRITICAL non-total genesis homing ------------------------------


async def test_channel_created_v2_null_visibility_injection_blocked(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """CRITICAL exploit: a non-guest member uploads channel.created v2 with
    visibility=null aimed at a victim stream (tenant B's channel AND a private
    channel in A they are not in). The non-total homing gate previously fell
    through to accept with an unconstrained home, appending to the victim stream.
    It must now reject invalid_schema with the victim stream and stream table
    completely untouched, and no channel created."""
    owner = await do_setup(client)
    attacker = await _invite_user(client, owner, role="member")  # non-guest → passes step iii
    b = await _seed_foreign_tenant(db_session)
    a_private = await bootstrap_channel(client, db_session, owner, visibility="private")

    for victim in (b.pub, a_private):
        victim_before = await _stream_snapshot(db_session, victim)
        streams_before = await db_session.scalar(select(func.count()).select_from(Stream))
        fresh = ids.new_stream_id()

        exploit = channel_created_body(
            auth=attacker,
            home_stream_id=victim,  # inject into the victim's log
            channel_stream_id=fresh,
            name="x",
            visibility=None,  # v2 skips payload validation, so this reaches homing
            type_version=2,
        )
        resp = await post_batch(client, attacker["token"], [wire_item(exploit)])
        assert resp.status_code == 200, resp.text
        (entry,) = resp.json()["rejected"]
        assert entry["code"] == "invalid_schema", (victim, resp.text)

        # Injection dead: victim stream byte-for-byte unchanged, no head_seq bump.
        assert await _stream_snapshot(db_session, victim) == victim_before
        # No channel created (neither the fresh id nor any new streams row).
        assert await db_session.scalar(select(func.count()).select_from(Stream)) == streams_before
        assert await fetch_stream(db_session, fresh) is None


# --- security round 2: hardening — author-scoped idempotency + lifecycle 500 guard ----


async def test_cross_user_event_id_collision_does_not_echo_other_author(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A different author re-using another user's event_id (same workspace) must NOT
    receive that author's record/sequence — it is a real conflict, rejected."""
    owner = await do_setup(client)
    member = await _invite_user(client, owner, role="member")
    channel = await bootstrap_channel(client, db_session, owner)  # public: both can write

    shared_event_id = ids.new_event_id()
    owner_msg = message_body(auth=owner, stream_id=channel, text="mine", event_id=shared_event_id)
    first = await post_batch(client, owner["token"], [wire_item(owner_msg)])
    (original,) = first.json()["accepted"]

    # The member submits a DIFFERENT body under the SAME event_id.
    member_msg = message_body(
        auth=member, stream_id=channel, text="not yours", event_id=shared_event_id
    )
    resp = await post_batch(client, member["token"], [wire_item(member_msg)])
    assert resp.status_code == 200, resp.text
    assert resp.json()["accepted"] == []
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "invalid_schema"
    assert entry["event_id"] == shared_event_id
    # The other author's coordinates are NOT disclosed via the reject detail.
    assert original["server_sequence"] != 0
    assert str(original["server_sequence"]) not in entry["detail"]
    assert channel not in entry["detail"]

    # Exactly one stored row for that id — still the owner's, untouched.
    rows = await _event_rows(db_session, shared_event_id)
    assert len(rows) == 1
    assert rows[0].author_user_id == owner["user_id"]


async def test_unknown_version_lifecycle_missing_field_rejects_not_500(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """channel.renamed v2 with a valid target but no ``name`` must reject cleanly
    (invalid_schema, 200) instead of 500ing in the version-agnostic reducer."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner, visibility="public")
    meta = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta is not None
    before = await fetch_stream(db_session, channel)
    assert before is not None
    name_before = before.name

    body = lifecycle_body(
        auth=owner,
        home_stream_id=meta,
        type="channel.renamed",
        payload={"channel_stream_id": channel},  # ``name`` omitted
        type_version=2,
    )
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert resp.status_code == 200, resp.text
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "invalid_schema"
    # The reducer never ran: the channel's name is unchanged.
    after = await fetch_stream(db_session, channel)
    assert after is not None and after.name == name_before


# --- F2: narrow storability backstop (DataError only) ---------------------------------


async def test_nul_in_payload_is_per_event_invalid_schema(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A JSON-valid, JCS-hashable, JSONB-fatal NUL in a payload string → invalid_schema.

    The first real exercise of the storability backstop: neighbors in the batch
    are unaffected (per-event isolation via the savepoint)."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    good_before = message_body(auth=owner, stream_id=channel, text="before")
    nul = custom_body(auth=owner, stream_id=channel, payload={"note": "bad\x00nul"})
    good_after = message_body(auth=owner, stream_id=channel, text="after")
    resp = await post_batch(
        client,
        owner["token"],
        [wire_item(good_before), wire_item(nul), wire_item(good_after)],
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert [e["code"] for e in payload["rejected"]] == ["invalid_schema"]
    assert payload["rejected"][0]["event_id"] == nul["event_id"]
    # Neighbors persisted with consecutive sequences (the NUL burned none).
    assert [e["server_sequence"] for e in payload["accepted"]] == [1, 2]
    rows = await _event_rows(db_session, nul["event_id"])
    assert rows == []  # the fatal event stored nothing


# --- F3: chunked-body DoS — streaming cap-and-abort -----------------------------------


async def test_oversize_chunked_body_without_content_length_413(client: AsyncClient) -> None:
    """A >1 MB body sent WITHOUT Content-Length (chunked) is 413'd mid-stream."""
    owner = await do_setup(client)

    async def _oversize() -> Any:
        chunk = b"a" * 100_000
        for _ in range(12):  # 1.2 MB, no Content-Length (async generator → chunked)
            yield chunk

    headers = {**auth_header(owner["token"]), "content-type": "application/json"}
    resp = await client.post(BATCH_URL, content=_oversize(), headers=headers)
    assert resp.status_code == 413
    assert resp.json()["type"] == "/problems/payload-too-large"


# --- unknown types (D9) ---------------------------------------------------------------


async def test_unknown_type_accepted_reducer_noop_sequence_consumed(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """D9: custom.thing is stored + sequenced, has no reducer effect, and burns a seq."""
    owner = await do_setup(client)
    member = await _invite_user(client, owner, role="member")
    channel = await bootstrap_channel(client, db_session, owner)

    streams_before = await db_session.scalar(select(func.count()).select_from(Stream))
    members_before = await db_session.scalar(select(func.count()).select_from(StreamMember))

    body = custom_body(auth=member, stream_id=channel, payload={"volume": 11})
    resp = await post_batch(client, member["token"], [wire_item(body)])
    (entry,) = resp.json()["accepted"]
    assert entry["server_sequence"] == 1

    (row,) = await _event_rows(db_session, body["event_id"])
    assert (row.type, row.type_version) == ("custom.thing", 1)
    assert row.body == body

    # Reducer no-op: no streams/membership changes.
    assert await db_session.scalar(select(func.count()).select_from(Stream)) == streams_before
    assert await db_session.scalar(select(func.count()).select_from(StreamMember)) == members_before

    # The sequence was consumed: the next message lands at 2.
    msg = message_body(auth=member, stream_id=channel)
    resp = await post_batch(client, member["token"], [wire_item(msg)])
    assert resp.json()["accepted"][0]["server_sequence"] == 2


async def test_known_type_unknown_version_accepted(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """message.created v2 (unknown version) skips payload validation and is accepted."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    body = message_body(auth=owner, stream_id=channel, type_version=2)
    body["payload"] = {"schema": "from the future"}
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    assert len(resp.json()["accepted"]) == 1, resp.text


async def test_known_type_invalid_payload_rejected(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Obligation c: a known type with a broken payload → invalid_schema."""
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)
    body = message_body(auth=owner, stream_id=channel)
    body["payload"]["message_id"] = "not-an-id"
    resp = await post_batch(client, owner["token"], [wire_item(body)])
    (entry,) = resp.json()["rejected"]
    assert entry["code"] == "invalid_schema"


# --- rate limiting (§4.3) ---------------------------------------------------------------


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def test_event_rate_limit_burst_and_window(
    settings: Settings, db_session: AsyncSession
) -> None:
    """The per-user burst limiter trips with 429 + Retry-After and resets with time."""
    clock = _Clock()

    def install(app: Any) -> None:
        app.state.event_limiter_minute = RateLimiter(100, 60, now=clock)
        app.state.event_limiter_burst = RateLimiter(3, 1, now=clock)

    app = make_app(settings, db_session, configure=install)
    async with make_client(app) as client:
        owner = await do_setup(client)
        for _ in range(3):
            assert (await post_batch(client, owner["token"], [])).status_code == 200
        blocked = await post_batch(client, owner["token"], [])
        assert blocked.status_code == 429
        assert blocked.json()["type"] == "/problems/rate-limited"
        assert int(blocked.headers["retry-after"]) >= 1

        clock.now += 2  # the 1 s burst window has elapsed
        assert (await post_batch(client, owner["token"], [])).status_code == 200


async def test_event_rate_limit_sustained_minute(
    settings: Settings, db_session: AsyncSession
) -> None:
    """The 60 s sustained limiter trips independently of the burst limiter."""
    clock = _Clock()

    def install(app: Any) -> None:
        app.state.event_limiter_minute = RateLimiter(2, 60, now=clock)
        app.state.event_limiter_burst = RateLimiter(100, 1, now=clock)

    app = make_app(settings, db_session, configure=install)
    async with make_client(app) as client:
        owner = await do_setup(client)
        for _ in range(2):
            assert (await post_batch(client, owner["token"], [])).status_code == 200
        blocked = await post_batch(client, owner["token"], [])
        assert blocked.status_code == 429
        assert blocked.json()["type"] == "/problems/rate-limited"
