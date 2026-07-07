"""Readable-streams predicate matrix, write matrix, 404 discipline, revocation (ENG-65 D5/D6)."""

from __future__ import annotations

import pytest
from msgd.api import problems
from msgd.api.deps import require_readable_stream
from msgd.auth.context import AuthContext
from msgd.auth.sessions import utcnow
from msgd.core import ids
from msgd.db.models import Device, Session, Stream, StreamMember, User, Workspace
from msgd.events.permissions import can_read, can_write
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession


def _ctx(*, user_id: str, workspace_id: str, role: str) -> AuthContext:
    """Build an in-memory AuthContext (helpers read only id/role/workspace)."""
    user = User(
        user_id=user_id,
        workspace_id=workspace_id,
        email="x@example.com",
        password_hash="x",
        display_name="X",
        role=role,
    )
    device = Device(device_id=ids.new_device_id(), user_id=user_id)
    session = Session(
        token_hash="x", user_id=user_id, device_id=device.device_id, expires_at=utcnow()
    )
    return AuthContext(
        user_id=user_id,
        workspace_id=workspace_id,
        role=role,
        device_id=device.device_id,
        session_token_hash="x",
        user=user,
        device=device,
        session=session,
    )


class _World:
    """A seeded workspace with one stream of each kind + role contexts."""

    def __init__(self, ws: str) -> None:
        self.ws = ws
        self.meta = ids.new_stream_id()
        self.pub = ids.new_stream_id()
        self.priv = ids.new_stream_id()
        self.dm = ids.new_stream_id()
        self.owner = ids.new_user_id()
        self.admin = ids.new_user_id()
        self.member = ids.new_user_id()
        self.guest = ids.new_user_id()

    def ctx(self, user_id: str, role: str) -> AuthContext:
        return _ctx(user_id=user_id, workspace_id=self.ws, role=role)


async def _seed_world(db: AsyncSession) -> _World:
    w = _World(ids.new_workspace_id())
    db.add(Workspace(workspace_id=w.ws, name="Acme"))
    await db.flush()
    for uid, role in [
        (w.owner, "owner"),
        (w.admin, "admin"),
        (w.member, "member"),
        (w.guest, "guest"),
    ]:
        db.add(
            User(
                user_id=uid,
                workspace_id=w.ws,
                email=f"{uid}@example.com",
                password_hash="x",
                display_name=role,
                role=role,
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
    # Memberships: member is in priv + dm; guest is EXPLICITLY in priv only.
    db.add(StreamMember(stream_id=w.priv, user_id=w.member))
    db.add(StreamMember(stream_id=w.dm, user_id=w.member))
    db.add(StreamMember(stream_id=w.priv, user_id=w.guest))
    await db.flush()
    return w


async def test_can_read_matrix(db_session: AsyncSession) -> None:
    """role × kind × membership → the D5 read decision."""
    w = await _seed_world(db_session)
    # (role, user, stream, expected)
    cases = [
        ("owner", w.owner, w.meta, True),
        ("owner", w.owner, w.pub, True),
        ("owner", w.owner, w.priv, False),  # no membership row
        ("owner", w.owner, w.dm, False),
        ("admin", w.admin, w.meta, True),
        ("admin", w.admin, w.pub, True),
        ("admin", w.admin, w.priv, False),
        ("member", w.member, w.meta, True),
        ("member", w.member, w.pub, True),  # public: no join needed
        ("member", w.member, w.priv, True),  # explicit member
        ("member", w.member, w.dm, True),  # explicit member
        ("guest", w.guest, w.meta, False),  # FLAGGED DEVIATION: guests get no meta
        ("guest", w.guest, w.pub, False),  # guest needs an explicit row
        ("guest", w.guest, w.priv, True),  # explicit member → readable
        ("guest", w.guest, w.dm, False),
    ]
    for role, uid, stream, expected in cases:
        got = await can_read(db_session, ctx=w.ctx(uid, role), stream_id=stream)
        assert got is expected, (role, stream, expected)


async def test_unknown_stream_reads_false(db_session: AsyncSession) -> None:
    """A stream that does not exist is simply unreadable (feeds the 404 path)."""
    w = await _seed_world(db_session)
    assert (
        await can_read(db_session, ctx=w.ctx(w.owner, "owner"), stream_id=ids.new_stream_id())
    ) is False


async def test_archived_stream_stays_readable(db_session: AsyncSession) -> None:
    """Archival gates writes/UI, not history access (D13) — predicate ignores it."""
    w = await _seed_world(db_session)
    row = await db_session.get(Stream, w.pub)
    assert row is not None
    row.archived_at = utcnow()
    await db_session.flush()
    assert await can_read(db_session, ctx=w.ctx(w.member, "member"), stream_id=w.pub) is True


async def test_require_readable_stream_404_not_403(db_session: AsyncSession) -> None:
    """The dependency returns 404 for BOTH unknown and unreadable (existence hidden)."""
    w = await _seed_world(db_session)
    owner = w.ctx(w.owner, "owner")

    # Unknown stream → 404.
    with pytest.raises(problems.ProblemException) as unknown:
        await require_readable_stream(ids.new_stream_id(), owner, db_session)
    assert unknown.value.status == 404
    assert unknown.value.type == "/problems/not-found"

    # Existing but unreadable (private, owner not a member) → identical 404.
    with pytest.raises(problems.ProblemException) as forbidden:
        await require_readable_stream(w.priv, owner, db_session)
    assert forbidden.value.status == 404
    assert forbidden.value.type == "/problems/not-found"

    # Readable → returns the id.
    assert await require_readable_stream(w.pub, owner, db_session) == w.pub


async def test_revocation_cuts_access_immediately(db_session: AsyncSession) -> None:
    """Deleting a stream_members row cuts predicate access on the next query (D13)."""
    w = await _seed_world(db_session)
    member = w.ctx(w.member, "member")
    assert await can_read(db_session, ctx=member, stream_id=w.priv) is True

    await db_session.execute(
        delete(StreamMember).where(
            StreamMember.stream_id == w.priv, StreamMember.user_id == w.member
        )
    )
    await db_session.flush()
    # No caching — the live EXISTS re-evaluates and now excludes the stream.
    assert await can_read(db_session, ctx=member, stream_id=w.priv) is False


async def test_can_write_matrix(db_session: AsyncSession) -> None:
    """The M1 write matrix (D6): channel/message/lifecycle rules."""
    w = await _seed_world(db_session)
    owner = w.ctx(w.owner, "owner")
    member = w.ctx(w.member, "member")
    guest = w.ctx(w.guest, "guest")

    # channel.created — any non-guest, guests cannot.
    assert await can_write(db_session, ctx=member, stream_id=w.meta, event_type="channel.created")
    assert not await can_write(
        db_session, ctx=guest, stream_id=w.meta, event_type="channel.created"
    )

    # lifecycle (renamed / member_added) — owner/admin only.
    assert await can_write(db_session, ctx=owner, stream_id=w.pub, event_type="channel.renamed")
    assert not await can_write(
        db_session, ctx=member, stream_id=w.pub, event_type="channel.renamed"
    )
    assert not await can_write(
        db_session, ctx=member, stream_id=w.pub, event_type="channel.member_added"
    )

    # message.created — follows stream read access.
    assert await can_write(
        db_session, ctx=member, stream_id=w.pub, event_type="message.created"
    )  # public read
    assert not await can_write(
        db_session, ctx=guest, stream_id=w.pub, event_type="message.created"
    )  # guest cannot read public
    assert await can_write(
        db_session, ctx=member, stream_id=w.priv, event_type="message.created"
    )  # member of priv
    assert not await can_write(
        db_session, ctx=owner, stream_id=w.priv, event_type="message.created"
    )  # owner not a member of priv

    # dm.created (ENG-104, M3) — any non-guest may open a DM; guests are scoped.
    # ``stream_id`` is the not-yet-existing self-homed DM stream, so this is a pure
    # role gate (author-is-participant + genesis/homing enforced in validate).
    fresh_dm = ids.new_stream_id()
    assert await can_write(db_session, ctx=owner, stream_id=fresh_dm, event_type="dm.created")
    assert await can_write(db_session, ctx=member, stream_id=fresh_dm, event_type="dm.created")
    assert not await can_write(db_session, ctx=guest, stream_id=fresh_dm, event_type="dm.created")

    # reaction.added / reaction.removed (ENG-97) — write access == read access,
    # identical to message.created (a reaction is a write to the message's stream).
    for reaction_type in ("reaction.added", "reaction.removed"):
        assert await can_write(
            db_session, ctx=member, stream_id=w.pub, event_type=reaction_type
        )  # public read
        assert not await can_write(
            db_session, ctx=guest, stream_id=w.pub, event_type=reaction_type
        )  # guest cannot read public
        assert await can_write(
            db_session, ctx=member, stream_id=w.priv, event_type=reaction_type
        )  # member of priv
        assert not await can_write(
            db_session, ctx=owner, stream_id=w.priv, event_type=reaction_type
        )  # owner not a member of priv
