"""Unit tests over ``validate_event`` — every code, locked step order (ENG-66 D5)."""

from __future__ import annotations

from typing import Any

from eventsutil import (
    channel_created_body,
    custom_body,
    dm_created_body,
    lifecycle_body,
    message_body,
    wire_item,
)
from msgd.auth.context import AuthContext
from msgd.auth.sessions import utcnow
from msgd.core import ids
from msgd.core.envelope import Body
from msgd.core.hashing import hash_event
from msgd.db.models import Device, Session, Stream, StreamMember, User, Workspace
from msgd.events.validate import Accepted, Rejected, _check_referential, validate_event
from sqlalchemy.ext.asyncio import AsyncSession


def _ctx(*, user_id: str, workspace_id: str, role: str, device_id: str) -> AuthContext:
    """An in-memory AuthContext (validate_event reads only ids/role)."""
    user = User(
        user_id=user_id,
        workspace_id=workspace_id,
        email="x@example.com",
        password_hash="x",
        display_name="X",
        role=role,
    )
    device = Device(device_id=device_id, user_id=user_id)
    session = Session(token_hash="x", user_id=user_id, device_id=device_id, expires_at=utcnow())
    return AuthContext(
        user_id=user_id,
        workspace_id=workspace_id,
        role=role,
        device_id=device_id,
        session_token_hash="x",
        user=user,
        device=device,
        session=session,
    )


class _World:
    """A seeded workspace: meta + public/private/dm streams + role contexts."""

    def __init__(self) -> None:
        self.ws = ids.new_workspace_id()
        self.meta = ids.new_stream_id()
        self.pub = ids.new_stream_id()
        self.priv = ids.new_stream_id()
        self.dm = ids.new_stream_id()
        self.owner = _ctx(
            user_id=ids.new_user_id(),
            workspace_id=self.ws,
            role="owner",
            device_id=ids.new_device_id(),
        )
        self.member = _ctx(
            user_id=ids.new_user_id(),
            workspace_id=self.ws,
            role="member",
            device_id=ids.new_device_id(),
        )
        self.guest = _ctx(
            user_id=ids.new_user_id(),
            workspace_id=self.ws,
            role="guest",
            device_id=ids.new_device_id(),
        )

    def auth(self, ctx: AuthContext) -> dict[str, Any]:
        """The builder-facing auth dict for ``ctx`` (see eventsutil)."""
        return {
            "workspace_id": ctx.workspace_id,
            "user_id": ctx.user_id,
            "device_id": ctx.device_id,
        }


async def _seed(db: AsyncSession) -> _World:
    w = _World()
    db.add(Workspace(workspace_id=w.ws, name="Acme"))
    await db.flush()
    for ctx in (w.owner, w.member, w.guest):
        db.add(
            User(
                user_id=ctx.user_id,
                workspace_id=w.ws,
                email=f"{ctx.user_id}@example.com",
                password_hash="x",
                display_name=ctx.role,
                role=ctx.role,
            )
        )
    db.add(Stream(stream_id=w.meta, workspace_id=w.ws, kind="workspace-meta"))
    db.add(
        Stream(stream_id=w.pub, workspace_id=w.ws, kind="channel", name="g", visibility="public")
    )
    db.add(
        Stream(stream_id=w.priv, workspace_id=w.ws, kind="channel", name="s", visibility="private")
    )
    db.add(Stream(stream_id=w.dm, workspace_id=w.ws, kind="dm"))
    await db.flush()
    # member is in priv + dm; owner/guest have no explicit rows.
    db.add(StreamMember(stream_id=w.priv, user_id=w.member.user_id))
    db.add(StreamMember(stream_id=w.dm, user_id=w.member.user_id))
    await db.flush()
    return w


def _expect_rejected(outcome: Accepted | Rejected, code: str) -> Rejected:
    assert isinstance(outcome, Rejected), outcome
    assert outcome.code == code, (outcome.code, outcome.detail)
    return outcome


# --- step 0: item shape --------------------------------------------------------


async def test_item_shape_rejects(db_session: AsyncSession) -> None:
    """Non-object items and missing body/event_hash → invalid_schema, id best-effort."""
    w = await _seed(db_session)
    bad_items: tuple[Any, ...] = (None, 42, "x", [])
    for bad in bad_items:
        out = _expect_rejected(
            await validate_event(db_session, ctx=w.member, item=bad), "invalid_schema"
        )
        assert out.event_id == ""

    body = message_body(auth=w.auth(w.member), stream_id=w.pub)
    # Missing event_hash — but the event_id is readable, so it is echoed back.
    out = _expect_rejected(
        await validate_event(db_session, ctx=w.member, item={"body": body}), "invalid_schema"
    )
    assert out.event_id == body["event_id"]
    # body not an object.
    out = _expect_rejected(
        await validate_event(db_session, ctx=w.member, item={"body": 3, "event_hash": "x"}),
        "invalid_schema",
    )
    assert out.event_id == ""


# --- step ii: workspace + author binding ----------------------------------------


async def test_identity_binding_mismatches(db_session: AsyncSession) -> None:
    """workspace_id / author_user_id / author_device_id ≠ session → permission_denied."""
    w = await _seed(db_session)
    auth = w.auth(w.member)
    for override in (
        {"workspace_id": ids.new_workspace_id()},
        {"author_user_id": w.owner.user_id},
        {"author_device_id": ids.new_device_id()},
    ):
        body = message_body(auth=auth, stream_id=w.pub, **override)
        out = _expect_rejected(
            await validate_event(db_session, ctx=w.member, item=wire_item(body)),
            "permission_denied",
        )
        assert out.event_id == body["event_id"]


# --- step iii: write permission + non-disclosure + archived gate ----------------


async def test_stream_denied_is_uniform_for_absent_and_forbidden(
    db_session: AsyncSession,
) -> None:
    """D13: absent stream and forbidden private stream → IDENTICAL code + detail."""
    w = await _seed(db_session)
    auth = w.auth(w.owner)  # owner is NOT a member of priv
    forbidden = message_body(auth=auth, stream_id=w.priv)
    absent = message_body(auth=auth, stream_id=ids.new_stream_id())

    out_forbidden = _expect_rejected(
        await validate_event(db_session, ctx=w.owner, item=wire_item(forbidden)),
        "permission_denied",
    )
    out_absent = _expect_rejected(
        await validate_event(db_session, ctx=w.owner, item=wire_item(absent)),
        "permission_denied",
    )
    assert out_forbidden.code == out_absent.code
    assert out_forbidden.detail == out_absent.detail  # existence not disclosed


async def test_guest_channel_created_denied(db_session: AsyncSession) -> None:
    w = await _seed(db_session)
    body = channel_created_body(auth=w.auth(w.guest), home_stream_id=w.meta)
    _expect_rejected(
        await validate_event(db_session, ctx=w.guest, item=wire_item(body)), "permission_denied"
    )


async def test_member_lifecycle_denied(db_session: AsyncSession) -> None:
    """channel.renamed is owner/admin-only; a member gets permission_denied."""
    w = await _seed(db_session)
    body = lifecycle_body(
        auth=w.auth(w.member),
        home_stream_id=w.meta,
        type="channel.renamed",
        payload={"channel_stream_id": w.pub, "name": "new"},
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "permission_denied"
    )


async def test_dm_created_accepted_for_participant(db_session: AsyncSession) -> None:
    """dm.created by a member who is a participant, self-homed in a fresh DM stream → Accepted."""
    w = await _seed(db_session)
    dm_id = ids.new_stream_id()
    body = dm_created_body(
        auth=w.auth(w.member),
        dm_stream_id=dm_id,
        member_user_ids=[w.member.user_id, w.owner.user_id],
    )
    out = await validate_event(db_session, ctx=w.member, item=wire_item(body))
    assert isinstance(out, Accepted), out
    assert out.home_stream_id == dm_id


async def test_dm_created_denied_for_guest(db_session: AsyncSession) -> None:
    """dm.created by a guest → permission_denied (guests are scoped, §3.6)."""
    w = await _seed(db_session)
    dm_id = ids.new_stream_id()
    body = dm_created_body(
        auth=w.auth(w.guest),
        dm_stream_id=dm_id,
        member_user_ids=[w.guest.user_id, w.member.user_id],
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.guest, item=wire_item(body)), "permission_denied"
    )


async def test_dm_created_author_must_be_participant(db_session: AsyncSession) -> None:
    """dm.created whose member_user_ids omit the author → permission_denied.

    A user cannot open a DM they are not part of (grafting membership onto others).
    """
    w = await _seed(db_session)
    dm_id = ids.new_stream_id()
    body = dm_created_body(
        auth=w.auth(w.member),
        dm_stream_id=dm_id,
        member_user_ids=[w.owner.user_id],  # author (member) omitted
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "permission_denied"
    )


async def test_dm_created_collision_and_homing_rejected(db_session: AsyncSession) -> None:
    """dm.created adopting an existing stream id → invalid_schema; wrong home → invalid_schema."""
    w = await _seed(db_session)
    auth = w.auth(w.member)
    # collision: dm_stream_id is an EXISTING stream (the seeded public channel).
    body = dm_created_body(
        auth=auth,
        dm_stream_id=w.pub,
        member_user_ids=[w.member.user_id, w.owner.user_id],
        home_stream_id=w.pub,
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )
    # wrong home: a fresh DM stream homed somewhere other than itself.
    fresh = ids.new_stream_id()
    body = dm_created_body(
        auth=auth,
        dm_stream_id=fresh,
        member_user_ids=[w.member.user_id, w.owner.user_id],
        home_stream_id=w.meta,  # not self-homed
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )


async def test_dm_created_bad_payload_rejected(db_session: AsyncSession) -> None:
    """dm.created with an empty member_user_ids (unknown version skips model) → invalid_schema."""
    w = await _seed(db_session)
    auth = w.auth(w.member)
    dm_id = ids.new_stream_id()
    # unknown version + empty participant list → the referential shape gate fires.
    body = dm_created_body(
        auth=auth,
        dm_stream_id=dm_id,
        member_user_ids=[],
        type_version=2,
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )


async def test_archived_write_gate(db_session: AsyncSession) -> None:
    """message.created to an archived stream → permission_denied (obligation b)."""
    w = await _seed(db_session)
    row = await db_session.get(Stream, w.pub)
    assert row is not None
    row.archived_at = utcnow()
    await db_session.flush()

    body = message_body(auth=w.auth(w.member), stream_id=w.pub)
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "permission_denied"
    )


# --- step iv: schema gates -------------------------------------------------------


async def test_envelope_gate_invalid_schema(db_session: AsyncSession) -> None:
    w = await _seed(db_session)
    body = message_body(auth=w.auth(w.member), stream_id=w.pub, event_id="not-a-ulid")
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )


async def test_schema_checked_before_hash(db_session: AsyncSession) -> None:
    """A body that is BOTH schema-invalid and hash-wrong → invalid_schema (order)."""
    w = await _seed(db_session)
    body = message_body(auth=w.auth(w.member), stream_id=w.pub, event_id="not-a-ulid")
    item = {"body": body, "event_hash": "sha256:" + "0" * 64}
    _expect_rejected(await validate_event(db_session, ctx=w.member, item=item), "invalid_schema")


async def test_known_type_invalid_payload(db_session: AsyncSession) -> None:
    """Obligation c: message.created with a bad message_id / missing text → invalid_schema."""
    w = await _seed(db_session)
    auth = w.auth(w.member)
    bad_id = message_body(auth=auth, stream_id=w.pub)
    bad_id["payload"]["message_id"] = "nope"
    missing_text = message_body(auth=auth, stream_id=w.pub)
    del missing_text["payload"]["text"]
    for body in (bad_id, missing_text):
        _expect_rejected(
            await validate_event(db_session, ctx=w.member, item=wire_item(body)),
            "invalid_schema",
        )


# --- F5: multi-fault order pins (the locked §3.2 order at every adjacent pair) ---


async def test_permission_precedes_schema_for_stream_access(
    db_session: AsyncSession,
) -> None:
    """iii before iv: non-member target AND schema-invalid payload → permission_denied."""
    w = await _seed(db_session)
    # owner is NOT a member of the private stream; payload is also broken.
    body = message_body(auth=w.auth(w.owner), stream_id=w.priv)
    body["payload"]["message_id"] = "not-an-id"
    _expect_rejected(
        await validate_event(db_session, ctx=w.owner, item=wire_item(body)), "permission_denied"
    )


async def test_identity_precedes_schema(db_session: AsyncSession) -> None:
    """ii before iv: author-binding mismatch AND schema-invalid body → permission_denied."""
    w = await _seed(db_session)
    body = message_body(
        auth=w.auth(w.member),
        stream_id=w.pub,
        author_user_id=w.owner.user_id,  # not the session's user
        event_id="not-a-ulid",  # also envelope-invalid
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "permission_denied"
    )


# --- step v: hash over the RAW dict ---------------------------------------------


async def test_hash_mismatch(db_session: AsyncSession) -> None:
    w = await _seed(db_session)
    body = message_body(auth=w.auth(w.member), stream_id=w.pub)
    item = {"body": body, "event_hash": "sha256:" + "0" * 64}
    _expect_rejected(await validate_event(db_session, ctx=w.member, item=item), "hash_mismatch")


async def test_jcs_out_of_domain_is_invalid_schema(db_session: AsyncSession) -> None:
    """An un-hashable body (over-cap int) → invalid_schema, never hash_mismatch."""
    w = await _seed(db_session)
    body = custom_body(auth=w.auth(w.member), stream_id=w.pub, payload={"n": 2**60})
    item = {"body": body, "event_hash": "sha256:" + "0" * 64}
    _expect_rejected(await validate_event(db_session, ctx=w.member, item=item), "invalid_schema")


async def test_coercion_tamper_is_hash_mismatch(db_session: AsyncSession) -> None:
    """'"type_version":"1"' with a hash computed over int 1 → hash_mismatch (ENG-56)."""
    w = await _seed(db_session)
    body_int = message_body(auth=w.auth(w.member), stream_id=w.pub)
    stale_hash = hash_event(body_int)  # hash over the int form
    body_str = dict(body_int)
    body_str["type_version"] = "1"  # lax coercion would "repair" this; raw hash must not
    item = {"body": body_str, "event_hash": stale_hash}
    _expect_rejected(await validate_event(db_session, ctx=w.member, item=item), "hash_mismatch")


async def test_honest_string_type_version_rejected_as_unstorable(
    db_session: AsyncSession,
) -> None:
    """DOCUMENTED DEVIATION from the plan's companion ruling.

    The plan expected an honestly-hashed '"type_version":"1"' body to be accepted
    and stored verbatim. ``insert_event`` (ENG-65, not editable in ENG-66) feeds
    the raw ``type_version`` into the INTEGER convenience column and asyncpg
    strictly rejects a str — acceptance would 500. The storability gate rejects
    it as invalid_schema instead, AFTER the hash check so the tamper case above
    still reports hash_mismatch.
    """
    w = await _seed(db_session)
    body = message_body(auth=w.auth(w.member), stream_id=w.pub, type_version="1")
    out = _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )
    assert "type_version" in out.detail


async def test_unparseable_client_created_at_rejected(db_session: AsyncSession) -> None:
    """Shape-valid but unparseable timestamp (month 13) → invalid_schema, not a 500."""
    w = await _seed(db_session)
    body = message_body(
        auth=w.auth(w.member), stream_id=w.pub, client_created_at="2026-13-45T99:99:99Z"
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )


# --- step vi: referential --------------------------------------------------------


async def test_genesis_collision_rejected(db_session: AsyncSession) -> None:
    """channel.created adopting an EXISTING stream id → invalid_schema (obligation a)."""
    w = await _seed(db_session)
    body = channel_created_body(
        auth=w.auth(w.member), home_stream_id=w.meta, channel_stream_id=w.pub
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )


async def test_homing_rules(db_session: AsyncSession) -> None:
    """§2.2: public genesis → workspace-meta; private genesis → self-homed."""
    w = await _seed(db_session)
    auth = w.auth(w.member)

    # public homed anywhere but meta → invalid_schema.
    body = channel_created_body(auth=auth, home_stream_id=w.pub, visibility="public")
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )

    # private homed in meta → invalid_schema.
    body = channel_created_body(auth=auth, home_stream_id=w.meta, visibility="private")
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )

    # private self-homed → Accepted, homed in the channel's own stream.
    new_id = ids.new_stream_id()
    body = channel_created_body(
        auth=auth, home_stream_id=new_id, channel_stream_id=new_id, visibility="private"
    )
    out = await validate_event(db_session, ctx=w.member, item=wire_item(body))
    assert isinstance(out, Accepted)
    assert out.home_stream_id == new_id
    assert out.raw_body is body  # the verbatim dict, not a copy


async def test_lifecycle_unknown_stream(db_session: AsyncSession) -> None:
    """Owner lifecycle event referencing an absent channel → unknown_stream."""
    w = await _seed(db_session)
    cases: list[tuple[str, dict[str, Any]]] = [
        ("channel.renamed", {"channel_stream_id": ids.new_stream_id(), "name": "n"}),
        (
            "channel.member_added",
            {"channel_stream_id": ids.new_stream_id(), "user_id": w.member.user_id},
        ),
    ]
    for type_, payload in cases:
        body = lifecycle_body(
            auth=w.auth(w.owner), home_stream_id=w.meta, type=type_, payload=payload
        )
        _expect_rejected(
            await validate_event(db_session, ctx=w.owner, item=wire_item(body)), "unknown_stream"
        )


# --- security round 2: totality of every homing/visibility branch ----------------


async def test_channel_created_v2_non_enum_visibility_is_rejected(
    db_session: AsyncSession,
) -> None:
    """CRITICAL: channel.created v2 with a non-enum visibility must NOT fall through
    to accept — visibility is enforced here regardless of type_version (v2 skips the
    step-iv payload model that would otherwise enforce the enum)."""
    w = await _seed(db_session)
    auth = w.auth(w.member)
    for visibility in (None, "secret", 123, True):
        body = channel_created_body(
            auth=auth,
            home_stream_id=w.priv,  # a victim home the gate must never leave unconstrained
            type_version=2,
            visibility=visibility,
        )
        out = _expect_rejected(
            await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
        )
        assert "visibility" in out.detail, visibility


async def test_channel_created_v2_missing_or_bad_channel_stream_id_rejected(
    db_session: AsyncSession,
) -> None:
    """channel.created v2 missing / malformed channel_stream_id → invalid_schema (no accept)."""
    w = await _seed(db_session)
    auth = w.auth(w.member)
    # absent field entirely.
    body = channel_created_body(
        auth=auth, home_stream_id=w.meta, type_version=2, include_channel_stream_id=False
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )
    # present but not a stream id.
    body = channel_created_body(
        auth=auth, home_stream_id=w.meta, type_version=2, channel_stream_id="not-a-stream"
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )


async def test_channel_created_home_neither_meta_nor_self_rejected(
    db_session: AsyncSession,
) -> None:
    """Belt-and-braces: a home that is neither workspace-meta nor channel_stream_id
    is rejected under both visibilities (no unconstrained-home accept path)."""
    w = await _seed(db_session)
    auth = w.auth(w.member)
    fresh = ids.new_stream_id()
    stray = ids.new_stream_id()  # neither meta nor the channel's own id

    # public homed at a stray stream (not meta) → invalid_schema.
    body = channel_created_body(
        auth=auth, home_stream_id=stray, channel_stream_id=fresh, visibility="public"
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )
    # public homed at its OWN channel_stream_id (must be meta) → invalid_schema.
    body = channel_created_body(
        auth=auth, home_stream_id=fresh, channel_stream_id=fresh, visibility="public"
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )
    # private homed at a stray stream (must be self) → invalid_schema.
    body = channel_created_body(
        auth=auth, home_stream_id=stray, channel_stream_id=fresh, visibility="private"
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "invalid_schema"
    )


async def test_dm_created_branch_is_total_homed(db_session: AsyncSession) -> None:
    """The dm.created referential branch never accepts with an unconstrained home.

    A valid self-homed participant DM passes; a DM homed anywhere but its own stream
    is refused (invalid_schema) rather than falling through to accept.
    """
    w = await _seed(db_session)
    dm_id = ids.new_stream_id()

    def _model(home: str) -> Body:
        return Body.model_validate(
            {
                "event_id": ids.new_event_id(),
                "workspace_id": w.ws,
                "stream_id": home,
                "type": "dm.created",
                "type_version": 1,
                "author_user_id": w.member.user_id,
                "author_device_id": w.member.device_id,
                "client_created_at": "2026-07-05T00:00:00.000Z",
                "payload": {
                    "dm_stream_id": dm_id,
                    "member_user_ids": [w.member.user_id, w.owner.user_id],
                },
            }
        )

    # self-homed → passes (returns None).
    ok = await _check_referential(
        db_session,
        ctx=w.member,
        body_model=(m := _model(dm_id)),
        raw_body=m.model_dump(mode="json"),
    )
    assert ok is None, ok

    # homed at workspace-meta (a DM must never leak into meta) → invalid_schema.
    out = await _check_referential(
        db_session,
        ctx=w.member,
        body_model=(m := _model(w.meta)),
        raw_body=m.model_dump(mode="json"),
    )
    assert isinstance(out, Rejected) and out.code == "invalid_schema"


async def test_lifecycle_unknown_version_missing_field_rejects_not_500(
    db_session: AsyncSession,
) -> None:
    """Unknown-version lifecycle whose payload lacks a reducer field → invalid_schema,
    rejected BEFORE the reducer (which reads the field unconditionally would 500)."""
    w = await _seed(db_session)
    auth = w.auth(w.owner)

    # channel.renamed v2 targeting a real channel, homed correctly, but no ``name``.
    body = lifecycle_body(
        auth=auth,
        home_stream_id=w.meta,
        type="channel.renamed",
        payload={"channel_stream_id": w.pub},  # name missing
        type_version=2,
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.owner, item=wire_item(body)), "invalid_schema"
    )

    # channel.member_added v2 with a bad user_id.
    body = lifecycle_body(
        auth=auth,
        home_stream_id=w.meta,
        type="channel.member_added",
        payload={"channel_stream_id": w.pub, "user_id": "not-a-user"},
        type_version=2,
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.owner, item=wire_item(body)), "invalid_schema"
    )


async def test_lifecycle_missing_channel_stream_id_rejects_cleanly(
    db_session: AsyncSession,
) -> None:
    """Lifecycle event with no resolvable target field → invalid_schema (no None-accept,
    no reducer 500)."""
    w = await _seed(db_session)
    body = lifecycle_body(
        auth=w.auth(w.owner),
        home_stream_id=w.meta,
        type="channel.archived",
        payload={},  # no channel_stream_id
        type_version=2,
    )
    _expect_rejected(
        await validate_event(db_session, ctx=w.owner, item=wire_item(body)), "invalid_schema"
    )


# --- step vii: size cap ----------------------------------------------------------


async def test_per_event_size_cap(db_session: AsyncSession) -> None:
    w = await _seed(db_session)
    body = message_body(auth=w.auth(w.member), stream_id=w.pub, text="x" * 70_000)
    _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=wire_item(body)), "payload_too_large"
    )


# --- D9 unknown types + smuggle inertness ----------------------------------------


async def test_unknown_type_gated_by_read_access(db_session: AsyncSession) -> None:
    """D9: unknown types are membership-gated via can_read (not can_write's default-deny)."""
    w = await _seed(db_session)

    # member of the private stream → accepted.
    body = custom_body(auth=w.auth(w.member), stream_id=w.priv)
    out = await validate_event(db_session, ctx=w.member, item=wire_item(body))
    assert isinstance(out, Accepted)

    # owner (not a member of priv) → permission_denied.
    body = custom_body(auth=w.auth(w.owner), stream_id=w.priv)
    _expect_rejected(
        await validate_event(db_session, ctx=w.owner, item=wire_item(body)), "permission_denied"
    )

    # guest cannot read the public stream (no explicit row) → permission_denied.
    body = custom_body(auth=w.auth(w.guest), stream_id=w.pub)
    _expect_rejected(
        await validate_event(db_session, ctx=w.guest, item=wire_item(body)), "permission_denied"
    )


async def test_client_server_and_signature_keys_are_ignored(db_session: AsyncSession) -> None:
    """Extra item keys (server/signature) never influence the outcome (point 3)."""
    w = await _seed(db_session)
    body = message_body(auth=w.auth(w.member), stream_id=w.pub)
    item = {
        "body": body,
        "event_hash": hash_event(body),
        "server": {"payload_redacted": True, "server_sequence": 999},
        "signature": "forged",
    }
    out = await validate_event(db_session, ctx=w.member, item=item)
    assert isinstance(out, Accepted)
    assert out.raw_body is body
