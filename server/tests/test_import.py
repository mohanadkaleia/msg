"""Unit/integration tests for the §9 bundle restore (ENG-157, M4-3).

Runs :func:`msgd.export.restore.import_workspace` (and the ``import_event``
primitive) directly against the harness's rolled-back ``db_session``. Each
scenario builds instance **A** honestly — every event through the live
``emit_event`` reducer-before-insert path, so incremental projections and
``streams``/``stream_members`` state are exactly what real ingest produces —
exports it with the real M4-1 writer, TRUNCATEs the database (instance **B**
is "a fresh instance" in the same container), and imports.

Covered here: the full round trip (projection dumps, head_seqs, membership,
blobs, users, files byte/state-equal), §12 invariant 6 (rebuild fixed point +
a NEW send sequencing from the restored head_seq), §12 invariant 4 (readable
sets not widened), the fresh-instance guard, fail-closed hash/manifest
mismatches (transaction rollback leaves B empty), idempotency (re-run refused;
crash-then-retry succeeds), owner re-credentialing, and the verbatim
``import_event`` primitive. The end-to-end path (real uvicorn + the actual
``msgctl import`` CLI + the M4-2 verify gate) lives in
``cli/tests/test_import_e2e.py``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from eventsutil import (
    channel_created_body,
    dm_created_body,
    file_uploaded_body,
    lifecycle_body,
    message_body,
    message_deleted_body,
    message_edited_body,
    reaction_body,
)
from msgd.auth.passwords import hash_password, verify_password
from msgd.blobs.store import LocalDiskBlobStore
from msgd.core import ids
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body
from msgd.core.payloads.meta import build_user_joined_body, build_workspace_created_body
from msgd.core.time import now_rfc3339, to_rfc3339
from msgd.db.models import Event, File, Invite, Stream, StreamMember, User, Workspace
from msgd.events.emit import emit_event
from msgd.events.insert import insert_event
from msgd.events.permissions import readable_streams_predicate
from msgd.export.bundle import export_workspace
from msgd.export.restore import (
    UNUSABLE_PASSWORD_HASH,
    RestoreError,
    import_event,
    import_workspace,
)
from msgd.projections.dump import (
    dump_messages_proj,
    dump_reactions_proj,
    dump_thread_participants_proj,
)
from msgd.projections.rebuild import rebuild_projections
from msgd.settings import Settings
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

EXPORTED_AT = "2026-07-09T12:00:00.000Z"
TOOL = "msgctl/test"
OWNER_PASSWORD = "new-owner-password-after-import"

#: A recognizable secret marker for instance A's password hashes: it must never
#: survive an export → import round trip (§9: bundles carry no hashes).
SECRET_HASH = "argon2id$super-secret-password-hash-marker"

_RESET = (
    "TRUNCATE messages_proj, reactions_proj, thread_participants_proj, events, "
    "read_state, prefs, files, stream_members, streams, sessions, devices, "
    "invites, users, workspaces CASCADE"
)


async def _bytes_stream(data: bytes) -> AsyncIterator[bytes]:
    yield data


@dataclass
class SeededA:
    """Instance A's identity + the bundle exported from it."""

    workspace_id: str
    meta_id: str
    general_id: str
    private_id: str
    dm_id: str
    owner_id: str
    member_id: str
    guest_id: str
    bundle_dir: Path
    blob_shas: dict[str, bytes]  # sha -> content bytes (content, thumbnail, text)
    state: CapturedState


@dataclass
class CapturedState:
    """Everything the round-trip equality assertions compare."""

    dumps: dict[str, str]
    head_seqs: dict[str, int]
    stream_members: set[tuple[str, str]]
    guest_readable: set[str]
    member_readable: set[str]
    # user_id, email, display_name, role, is_bot, deactivated_at, + ENG-164:
    # title, description, status_emoji, status_text, status_expires_at.
    users: list[
        tuple[
            str,
            str,
            str,
            str,
            bool,
            str | None,
            str | None,
            str | None,
            str | None,
            str | None,
            str | None,
        ]
    ]
    files: list[tuple[str, str, str, str, int, str, str | None, bool, str | None, str]]
    streams: dict[str, tuple[str, str | None, str | None, str | None]]


def _auth(workspace_id: str, user_id: str) -> dict[str, Any]:
    return {"workspace_id": workspace_id, "user_id": user_id, "device_id": ids.new_device_id()}


def _msg(
    auth: dict[str, Any],
    stream_id: str,
    text_: str,
    *,
    thread_root_id: str | None = None,
    mentions: list[str] | None = None,
    message_id: str | None = None,
) -> dict[str, Any]:
    """A ``message.created`` body with payload-level knobs (message_id/mentions).

    ``eventsutil.message_body``'s ``**overrides`` land on the TOP-LEVEL body
    dict, but ``message_id``/``mentions`` live inside ``payload`` — so this
    goes through the real builder instead.
    """
    return build_message_created_body(
        workspace_id=auth["workspace_id"],
        stream_id=stream_id,
        author_user_id=auth["user_id"],
        author_device_id=auth["device_id"],
        client_created_at=now_rfc3339(),
        text=text_,
        thread_root_id=thread_root_id,
        mentions=mentions,
        message_id=message_id,
    ).model_dump(mode="json")


async def _readable(db: AsyncSession, *, workspace_id: str, user_id: str, role: str) -> set[str]:
    rows = await db.execute(
        select(Stream.stream_id).where(
            readable_streams_predicate(user_id=user_id, role=role, workspace_id=workspace_id)
        )
    )
    return {sid for (sid,) in rows.all()}


async def _capture_state(
    db: AsyncSession, *, workspace_id: str, guest_id: str, member_id: str
) -> CapturedState:
    members = {
        (sid, uid)
        for sid, uid in (
            await db.execute(select(StreamMember.stream_id, StreamMember.user_id))
        ).all()
    }
    heads = {
        sid: head
        for sid, head in (await db.execute(select(Stream.stream_id, Stream.head_seq))).all()
    }
    users = [
        (
            u.user_id,
            u.email,
            u.display_name,
            u.role,
            u.is_bot,
            _opt_rfc3339(u.deactivated_at),
            # ENG-164 richer-profile columns — part of the round-trip surface.
            u.title,
            u.description,
            u.status_emoji,
            u.status_text,
            _opt_rfc3339(u.status_expires_at),
        )
        for u in (await db.execute(select(User).order_by(User.user_id))).scalars().all()
    ]
    files = [
        (
            f.file_id,
            f.sha256,
            f.name,
            f.mime_type,
            f.size_bytes,
            f.uploaded_by,
            f.stream_id,
            f.present,
            f.thumbnail_sha256,
            to_rfc3339(f.created_at),
        )
        for f in (await db.execute(select(File).order_by(File.file_id))).scalars().all()
    ]
    streams = {
        s.stream_id: (s.kind, s.name, s.visibility, _opt_rfc3339(s.archived_at))
        for s in (await db.execute(select(Stream))).scalars().all()
    }
    return CapturedState(
        dumps={
            "messages_proj": await dump_messages_proj(db),
            "reactions_proj": await dump_reactions_proj(db),
            "thread_participants_proj": await dump_thread_participants_proj(db),
        },
        head_seqs=heads,
        stream_members=members,
        guest_readable=await _readable(
            db, workspace_id=workspace_id, user_id=guest_id, role="guest"
        ),
        member_readable=await _readable(
            db, workspace_id=workspace_id, user_id=member_id, role="member"
        ),
        users=users,
        files=files,
        streams=streams,
    )


def _opt_rfc3339(moment: Any) -> str | None:
    return None if moment is None else to_rfc3339(moment)


async def _seed_and_export(db: AsyncSession, tmp_path: Path) -> SeededA:
    """Build a dogfood-shaped instance A through the LIVE paths, then export it.

    Streams: workspace-meta, a renamed public channel, an archived private
    channel (member: owner+member, not the guest), a DM. Events: genesis +
    membership lifecycle, threads, mentions, an edit, a delete, reactions
    (incl. a remove), two ``file.uploaded``. Files: an "image" with a thumbnail
    + a text attachment. All events flow through ``emit_event``
    (reducer-before-insert + incremental projection), so A is exactly what live
    ingest produces.
    """
    await db.execute(text(_RESET))

    ws = ids.new_workspace_id()
    db.add(Workspace(workspace_id=ws, name="Acme", file_quota_bytes=1234567890))
    await db.flush()

    owner, member, guest = sorted(ids.new_user_id() for _ in range(3))
    for uid, email, name, role in (
        (owner, "alice@example.com", "Alice", "owner"),
        (member, "bob@example.com", "Bob", "member"),
        (guest, "gina@example.com", "Gina", "guest"),
    ):
        db.add(
            User(
                user_id=uid,
                workspace_id=ws,
                email=email,
                password_hash=SECRET_HASH,
                display_name=name,
                role=role,
                is_bot=False,
                # ENG-164: give the OWNER a full richer profile so the users-row
                # round-trip is non-vacuous for the five new columns (title +
                # description + a custom status with a future expiry). Absence on
                # the others exercises the null path.
                title="Founder" if role == "owner" else None,
                description="Runs Acme." if role == "owner" else None,
                status_emoji="🚀" if role == "owner" else None,
                status_text="shipping" if role == "owner" else None,
                status_expires_at=(datetime(2099, 1, 1, tzinfo=UTC) if role == "owner" else None),
            )
        )
    await db.flush()

    a_owner, a_member = _auth(ws, owner), _auth(ws, member)

    # --- workspace-meta: genesis + joins + public-channel lifecycle ----------
    meta = ids.new_stream_id()
    await emit_event(
        db,
        home_stream_id=meta,
        body=build_workspace_created_body(
            workspace_id=ws,
            stream_id=meta,
            author_user_id=owner,
            author_device_id=a_owner["device_id"],
            client_created_at=now_rfc3339(),
            name="Acme",
        ),
    )
    for uid, name in ((owner, "Alice"), (member, "Bob"), (guest, "Gina")):
        await emit_event(
            db,
            home_stream_id=meta,
            body=build_user_joined_body(
                workspace_id=ws,
                stream_id=meta,
                author_user_id=uid,
                author_device_id=ids.new_device_id(),
                client_created_at=now_rfc3339(),
                user_id=uid,
                display_name=name,
            ),
        )
    general = ids.new_stream_id()
    await emit_event(
        db,
        home_stream_id=meta,
        body=channel_created_body(
            auth=a_owner, home_stream_id=meta, channel_stream_id=general, name="general"
        ),
    )
    await emit_event(  # public lifecycle homes in meta (§2.2)
        db,
        home_stream_id=meta,
        body=lifecycle_body(
            auth=a_owner,
            home_stream_id=meta,
            type="channel.renamed",
            payload={"channel_stream_id": general, "name": "town-square"},
        ),
    )
    await emit_event(  # the guest's EXPLICIT grant to the public channel (§3.6)
        db,
        home_stream_id=meta,
        body=lifecycle_body(
            auth=a_owner,
            home_stream_id=meta,
            type="channel.member_added",
            payload={"channel_stream_id": general, "user_id": guest},
        ),
    )

    # --- private channel: self-homed genesis + membership + archive ----------
    private = ids.new_stream_id()
    await emit_event(
        db,
        home_stream_id=private,
        body=channel_created_body(
            auth=a_owner,
            home_stream_id=private,
            channel_stream_id=private,
            name="secret-plans",
            visibility="private",
        ),
    )
    await emit_event(
        db,
        home_stream_id=private,
        body=lifecycle_body(
            auth=a_owner,
            home_stream_id=private,
            type="channel.member_added",
            payload={"channel_stream_id": private, "user_id": member},
        ),
    )
    for text_ in ("private one", "private two"):
        await emit_event(db, home_stream_id=private, body=_msg(a_member, private, text_))

    # --- DM (owner <-> member) ------------------------------------------------
    dm = ids.new_stream_id()
    await emit_event(
        db,
        home_stream_id=dm,
        body=dm_created_body(auth=a_owner, dm_stream_id=dm, member_user_ids=[owner, member]),
    )
    await emit_event(db, home_stream_id=dm, body=_msg(a_member, dm, "dm hi"))

    # --- general: thread + mention + edit + delete + reactions ----------------
    m_root, m_edit, m_del = (ids.new_message_id() for _ in range(3))
    await emit_event(
        db,
        home_stream_id=general,
        body=_msg(a_owner, general, "thread root 🌍", message_id=m_root),
    )
    await emit_event(
        db,
        home_stream_id=general,
        body=_msg(a_member, general, "a reply", thread_root_id=m_root),
    )
    await emit_event(
        db,
        home_stream_id=general,
        body=_msg(a_owner, general, "hey @bob", mentions=[member]),
    )
    await emit_event(
        db,
        home_stream_id=general,
        body=_msg(a_owner, general, "before edit", message_id=m_edit),
    )
    await emit_event(
        db,
        home_stream_id=general,
        body=message_edited_body(
            auth=a_owner, stream_id=general, message_id=m_edit, text="after edit"
        ),
    )
    await emit_event(
        db,
        home_stream_id=general,
        body=_msg(a_owner, general, "to be deleted", message_id=m_del),
    )
    await emit_event(
        db,
        home_stream_id=general,
        body=message_deleted_body(auth=a_owner, stream_id=general, message_id=m_del),
    )
    for emoji, removed, who in (
        ("🎉", False, a_member),
        ("✅", False, a_owner),
        ("✅", True, a_owner),
    ):
        await emit_event(
            db,
            home_stream_id=general,
            body=reaction_body(
                auth=who, stream_id=general, message_id=m_root, emoji=emoji, removed=removed
            ),
        )

    # --- files: an "image" with a thumbnail + a private text attachment -------
    blob_root = tmp_path / "a-blobs"
    store = LocalDiskBlobStore(blob_root)
    content = b"PNG-ish bytes \x89PNG..." * 10
    thumb = b"WEBP-thumb-bytes" * 4
    text_blob = b"quarterly numbers, very private\n" * 8
    content_sha = await store.put(_bytes_stream(content))
    thumb_sha = await store.put(_bytes_stream(thumb))
    text_sha = await store.put(_bytes_stream(text_blob))

    f_img, f_txt = sorted(ids.new_file_id() for _ in range(2))
    db.add(
        File(
            file_id=f_img,
            workspace_id=ws,
            sha256=content_sha,
            name="logo.png",
            mime_type="image/png",
            size_bytes=len(content),
            uploaded_by=owner,
            stream_id=general,
            present=True,
            thumbnail_sha256=thumb_sha,
        )
    )
    db.add(
        File(
            file_id=f_txt,
            workspace_id=ws,
            sha256=text_sha,
            name="numbers.txt",
            mime_type="text/plain",
            size_bytes=len(text_blob),
            uploaded_by=member,
            stream_id=private,
            present=True,
        )
    )
    await db.flush()
    await emit_event(
        db,
        home_stream_id=general,
        body=file_uploaded_body(
            auth=a_owner,
            stream_id=general,
            file_id=f_img,
            sha256=content_sha,
            name="logo.png",
            size_bytes=len(content),
        ),
    )
    await emit_event(
        db,
        home_stream_id=private,
        body=file_uploaded_body(
            auth=a_member,
            stream_id=private,
            file_id=f_txt,
            sha256=text_sha,
            name="numbers.txt",
            mime_type="text/plain",
            size_bytes=len(text_blob),
        ),
    )

    # Archive the private channel LAST (self-homed lifecycle, §2.2).
    await emit_event(
        db,
        home_stream_id=private,
        body=lifecycle_body(
            auth=a_owner,
            home_stream_id=private,
            type="channel.archived",
            payload={"channel_stream_id": private},
        ),
    )
    await db.flush()

    state = await _capture_state(db, workspace_id=ws, guest_id=guest, member_id=member)

    bundle_dir = tmp_path / "bundle"
    await export_workspace(db, store, bundle_dir, exported_at=EXPORTED_AT, tool=TOOL)
    return SeededA(
        workspace_id=ws,
        meta_id=meta,
        general_id=general,
        private_id=private,
        dm_id=dm,
        owner_id=owner,
        member_id=member,
        guest_id=guest,
        bundle_dir=bundle_dir,
        blob_shas={content_sha: content, thumb_sha: thumb, text_sha: text_blob},
        state=state,
    )


async def _assert_all_empty(db: AsyncSession) -> None:
    """B must be exactly as empty as the fresh-instance guard found it."""
    for model in (Workspace, User, Stream, StreamMember, Event, File):
        rows = (await db.execute(select(model).limit(1))).first()
        assert rows is None, f"{model.__tablename__} is not empty after a failed import"


# ---------------------------------------------------------------------------
# Round trip + invariants 4/6
# ---------------------------------------------------------------------------


async def test_round_trip_restores_projections_membership_blobs_and_users(
    db_session: AsyncSession, tmp_path: Path, settings: Settings
) -> None:
    seeded = await _seed_and_export(db_session, tmp_path)
    a = seeded.state

    # The export captured A while A's projections were INCREMENTAL (live
    # ingest) — the round-trip equality below is therefore also a
    # rebuild ≡ incremental proof across instances.
    await db_session.execute(text(_RESET))

    b_store = LocalDiskBlobStore(tmp_path / "b-blobs")
    owner_hash = hash_password(settings, OWNER_PASSWORD)
    result = await import_workspace(
        db_session, b_store, seeded.bundle_dir, owner_password_hash=owner_hash
    )

    b = await _capture_state(
        db_session,
        workspace_id=seeded.workspace_id,
        guest_id=seeded.guest_id,
        member_id=seeded.member_id,
    )

    # --- §12 invariant 6 surface: projection dumps byte-equal -----------------
    assert b.dumps == a.dumps
    for name, dump in b.dumps.items():
        assert result.dump_digests[name] == hashlib.sha256(dump.encode("utf-8")).hexdigest()

    # --- log/stream state: head_seqs, membership, stream rows -----------------
    assert b.head_seqs == a.head_seqs
    assert result.head_seqs == a.head_seqs
    assert b.stream_members == a.stream_members
    assert b.streams == a.streams  # kind/name/visibility/archived_at (ms) preserved
    assert b.streams[seeded.private_id][3] is not None  # archive time restored
    assert b.streams[seeded.general_id][1] == "town-square"  # rename replayed
    assert result.events == sum(a.head_seqs.values())
    assert result.streams == len(a.head_seqs)

    # --- §12 invariant 4: no readable-stream set widened by import ------------
    assert b.guest_readable == a.guest_readable == {seeded.general_id}
    assert b.member_readable == a.member_readable
    assert seeded.private_id not in b.guest_readable
    assert seeded.dm_id not in b.guest_readable

    # --- blobs: every one restored, content-addressed, byte-exact -------------
    assert result.blobs == len(seeded.blob_shas) == 3
    for sha, content in seeded.blob_shas.items():
        restored = (tmp_path / "b-blobs" / sha[:2] / sha).read_bytes()
        assert restored == content
        assert hashlib.sha256(restored).hexdigest() == sha

    # --- users: snapshot fields verbatim; credentials re-minted ---------------
    # ENG-164: the OWNER carries a full richer profile (title/description/status
    # with a future expiry); the other two carry nulls — all round-trip verbatim.
    def _profile(role: str) -> tuple[str | None, str | None, str | None, str | None, str | None]:
        if role == "owner":
            return ("Founder", "Runs Acme.", "🚀", "shipping", "2099-01-01T00:00:00.000Z")
        return (None, None, None, None, None)

    assert (
        b.users
        == a.users
        == [
            (uid, email, name, role, False, None, *_profile(role))
            for uid, email, name, role in sorted(
                [
                    (seeded.owner_id, "alice@example.com", "Alice", "owner"),
                    (seeded.member_id, "bob@example.com", "Bob", "member"),
                    (seeded.guest_id, "gina@example.com", "Gina", "guest"),
                ]
            )
        ]
    )
    hashes = {
        u.user_id: u.password_hash for u in (await db_session.execute(select(User))).scalars().all()
    }
    assert SECRET_HASH not in hashes.values()  # A's hashes never cross the bundle
    assert hashes[seeded.owner_id] == owner_hash
    assert hashes[seeded.member_id] == hashes[seeded.guest_id] == UNUSABLE_PASSWORD_HASH

    # Owner can log in with the new password; nobody can with the sentinel.
    assert await verify_password(settings, hashes[seeded.owner_id], OWNER_PASSWORD)
    assert not await verify_password(settings, hashes[seeded.owner_id], "wrong-password")
    for probe in (OWNER_PASSWORD, "", "password", SECRET_HASH):
        assert not await verify_password(settings, UNUSABLE_PASSWORD_HASH, probe)

    # --- files: PRESENT rows with thumbnails preserved -------------------------
    assert b.files == a.files
    assert result.files == 2

    # --- workspace row ----------------------------------------------------------
    ws_row = (await db_session.execute(select(Workspace))).scalars().one()
    assert ws_row.workspace_id == seeded.workspace_id == result.workspace_id
    assert ws_row.name == "Acme"
    assert ws_row.file_quota_bytes == 1234567890


async def test_invariant6_rebuild_fixed_point_and_new_send_sequences_from_head(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """After import: rebuild again => dumps unchanged; a NEW send sequences from
    the restored head_seq (not 1) and diverges the dump by exactly itself —
    the ENG-150 head_seq failure class, guarded on the import path."""
    seeded = await _seed_and_export(db_session, tmp_path)
    await db_session.execute(text(_RESET))
    await import_workspace(db_session, LocalDiskBlobStore(tmp_path / "b-blobs"), seeded.bundle_dir)

    imported = {
        "messages_proj": await dump_messages_proj(db_session),
        "reactions_proj": await dump_reactions_proj(db_session),
        "thread_participants_proj": await dump_thread_participants_proj(db_session),
    }
    assert imported == seeded.state.dumps

    # Fixed point: the imported instance is already in "rebuild" state.
    await rebuild_projections(db_session)
    assert await dump_messages_proj(db_session) == imported["messages_proj"]
    assert await dump_reactions_proj(db_session) == imported["reactions_proj"]
    assert await dump_thread_participants_proj(db_session) == imported["thread_participants_proj"]

    # A NEW message on B sequences from the restored head, applies incrementally.
    general_head = seeded.state.head_seqs[seeded.general_id]
    body = build_message_created_body(
        workspace_id=seeded.workspace_id,
        stream_id=seeded.general_id,
        author_user_id=seeded.owner_id,
        author_device_id=ids.new_device_id(),
        client_created_at=now_rfc3339(),
        text="first post-import message",
    ).model_dump(mode="json")
    envelope = await insert_event(db_session, stream_id=seeded.general_id, body=body)
    assert envelope.server is not None
    assert envelope.server.server_sequence == general_head + 1

    new_head = await db_session.scalar(
        select(Stream.head_seq).where(Stream.stream_id == seeded.general_id)
    )
    assert new_head == general_head + 1

    # The dump diverges by EXACTLY the new message's row.
    old_lines = set(imported["messages_proj"].splitlines())
    new_lines = set((await dump_messages_proj(db_session)).splitlines())
    assert old_lines < new_lines
    (added,) = new_lines - old_lines
    added_row = json.loads(added)
    assert added_row["message_id"] == body["payload"]["message_id"]
    assert added_row["created_seq"] == general_head + 1
    assert await dump_reactions_proj(db_session) == imported["reactions_proj"]

    # And rebuild ≡ incremental still holds with the new event in the log.
    await rebuild_projections(db_session)
    assert set((await dump_messages_proj(db_session)).splitlines()) == new_lines


# ---------------------------------------------------------------------------
# Fresh-instance guard + idempotency
# ---------------------------------------------------------------------------


async def test_refuses_non_empty_instance(db_session: AsyncSession, tmp_path: Path) -> None:
    seeded = await _seed_and_export(db_session, tmp_path)
    events_before = len((await db_session.execute(select(Event))).scalars().all())

    with pytest.raises(RestoreError, match="not empty"):
        await import_workspace(
            db_session, LocalDiskBlobStore(tmp_path / "b-blobs"), seeded.bundle_dir
        )

    # Nothing changed: the guard fires before any write (blobs included).
    events_after = len((await db_session.execute(select(Event))).scalars().all())
    assert events_after == events_before
    assert len((await db_session.execute(select(Workspace))).scalars().all()) == 1
    assert not (tmp_path / "b-blobs").exists()


async def test_refuses_when_invites_table_not_empty(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """A leftover `invites` row makes the target NOT fresh — import must refuse.

    `invites` carries no FK back to the tables the guard already checks (its
    `workspace_id` / `created_by` are bare Text), so a stray invite can survive
    an otherwise-empty database. The hardened guard rejects it before any write,
    so an imported workspace can never inherit an orphaned join token.
    """
    seeded = await _seed_and_export(db_session, tmp_path)
    await db_session.execute(text(_RESET))
    # A stray, un-anchored invite is the ONLY row in an otherwise-empty instance.
    db_session.add(
        Invite(
            token_hash="leftover-token-hash",
            workspace_id=ids.new_workspace_id(),
            created_by=ids.new_user_id(),
            role="member",
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
    )
    await db_session.flush()

    with pytest.raises(RestoreError, match="invites has rows"):
        await import_workspace(
            db_session, LocalDiskBlobStore(tmp_path / "b-blobs"), seeded.bundle_dir
        )

    # The guard fired before any write (blobs included) — nothing but the invite.
    await db_session.rollback()
    assert not (tmp_path / "b-blobs").exists()


async def test_imports_bundle_with_zero_event_channel(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """A PUBLIC channel with no messages exports as an empty `streams/<id>/` dir
    (head_seq 0, no month files) whose stream row is bootstrapped by the
    meta-homed `channel.created`; import must accept the zero-event stream and
    restore it as a live, empty channel."""
    await db_session.execute(text(_RESET))
    ws = ids.new_workspace_id()
    db_session.add(Workspace(workspace_id=ws, name="Acme", file_quota_bytes=1))
    await db_session.flush()
    owner = ids.new_user_id()
    db_session.add(
        User(
            user_id=owner,
            workspace_id=ws,
            email="alice@example.com",
            password_hash=SECRET_HASH,
            display_name="Alice",
            role="owner",
            is_bot=False,
        )
    )
    await db_session.flush()
    a_owner = _auth(ws, owner)

    meta = ids.new_stream_id()
    await emit_event(
        db_session,
        home_stream_id=meta,
        body=build_workspace_created_body(
            workspace_id=ws,
            stream_id=meta,
            author_user_id=owner,
            author_device_id=a_owner["device_id"],
            client_created_at=now_rfc3339(),
            name="Acme",
        ),
    )
    await emit_event(
        db_session,
        home_stream_id=meta,
        body=build_user_joined_body(
            workspace_id=ws,
            stream_id=meta,
            author_user_id=owner,
            author_device_id=a_owner["device_id"],
            client_created_at=now_rfc3339(),
            user_id=owner,
            display_name="Alice",
        ),
    )
    # A public channel created but NEVER posted to: its own stream stays at
    # head_seq 0 (the genesis event homes in workspace-meta, §2.2).
    empty = ids.new_stream_id()
    await emit_event(
        db_session,
        home_stream_id=meta,
        body=channel_created_body(
            auth=a_owner, home_stream_id=meta, channel_stream_id=empty, name="empty-room"
        ),
    )
    await db_session.flush()

    store = LocalDiskBlobStore(tmp_path / "a-blobs")
    bundle = tmp_path / "bundle"
    await export_workspace(db_session, store, bundle, exported_at=EXPORTED_AT, tool=TOOL)

    # The zero-event channel exported as a dir with NO month files, head_seq 0.
    empty_dir = bundle / "streams" / empty
    assert empty_dir.is_dir()
    assert list(empty_dir.glob("*.ndjson")) == []
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["streams"][empty]["head_seq"] == 0
    assert manifest["streams"][empty]["event_count"] == 0
    assert manifest["streams"][empty]["files"] == {}

    await db_session.execute(text(_RESET))
    result = await import_workspace(db_session, LocalDiskBlobStore(tmp_path / "b-blobs"), bundle)
    assert result.head_seqs[empty] == 0

    row = (
        (await db_session.execute(select(Stream).where(Stream.stream_id == empty))).scalars().one()
    )
    assert row.head_seq == 0
    assert row.name == "empty-room"
    assert row.visibility == "public"
    assert row.archived_at is None


async def test_rerun_of_completed_import_fails_cleanly(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    seeded = await _seed_and_export(db_session, tmp_path)
    await db_session.execute(text(_RESET))
    store = LocalDiskBlobStore(tmp_path / "b-blobs")
    await import_workspace(db_session, store, seeded.bundle_dir)

    with pytest.raises(RestoreError, match="not empty"):
        await import_workspace(db_session, store, seeded.bundle_dir)

    # The completed import is untouched by the refused re-run.
    assert await dump_messages_proj(db_session) == seeded.state.dumps["messages_proj"]


async def test_crash_before_commit_leaves_nothing_and_retry_succeeds(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """A crash AFTER blob restore but BEFORE the single commit leaves the
    database empty (blobs are content-addressed no-ops on retry), and a re-run
    then succeeds — the §12 invariant-1 idempotency shape for import."""
    seeded = await _seed_and_export(db_session, tmp_path)
    await db_session.execute(text(_RESET))
    store = LocalDiskBlobStore(tmp_path / "b-blobs")

    async def _boom(session: AsyncSession) -> Any:
        raise RuntimeError("simulated crash before commit")

    with pytest.MonkeyPatch.context() as mp:
        # The trailing rebuild carries THE one commit; dying there means every
        # DB write of the import is still uncommitted.
        mp.setattr("msgd.export.restore.rebuild_projections", _boom)
        with pytest.raises(RuntimeError, match="simulated crash"):
            await import_workspace(db_session, store, seeded.bundle_dir)

    await db_session.rollback()
    await _assert_all_empty(db_session)
    # Blobs survived (content-addressed, verified) — harmless and reusable.
    for sha in seeded.blob_shas:
        assert (tmp_path / "b-blobs" / sha[:2] / sha).is_file()

    result = await import_workspace(db_session, store, seeded.bundle_dir)
    assert result.events == sum(seeded.state.head_seqs.values())
    assert await dump_messages_proj(db_session) == seeded.state.dumps["messages_proj"]


# ---------------------------------------------------------------------------
# Fail-closed
# ---------------------------------------------------------------------------


def _tamper_one_event_text(bundle_dir: Path, stream_id: str) -> None:
    """Flip one message body's text WITHOUT re-hashing (the D1 tamper class)."""
    stream_dir = bundle_dir / "streams" / stream_id
    month_path = sorted(stream_dir.glob("*.ndjson"))[0]
    lines = month_path.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        evt = json.loads(line)
        if evt["body"]["type"] == "message.created":
            evt["body"]["payload"]["text"] = "TAMPERED"
            lines[i] = json.dumps(evt, ensure_ascii=False, separators=(",", ":"))
            break
    else:  # pragma: no cover - seed always has messages
        raise AssertionError("no message.created to tamper with")
    month_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


async def test_tampered_event_hash_aborts_and_rolls_back_everything(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    seeded = await _seed_and_export(db_session, tmp_path)
    _tamper_one_event_text(seeded.bundle_dir, seeded.general_id)
    await db_session.execute(text(_RESET))

    with pytest.raises(RestoreError, match="event_hash"):
        await import_workspace(
            db_session, LocalDiskBlobStore(tmp_path / "b-blobs"), seeded.bundle_dir
        )

    await db_session.rollback()
    await _assert_all_empty(db_session)


async def test_manifest_head_seq_disagreement_aborts(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    seeded = await _seed_and_export(db_session, tmp_path)
    manifest_path = seeded.bundle_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["streams"][seeded.general_id]["head_seq"] += 5
    manifest["streams"][seeded.general_id]["event_count"] += 5
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    await db_session.execute(text(_RESET))

    with pytest.raises(RestoreError, match="event_count|head_seq"):
        await import_workspace(
            db_session, LocalDiskBlobStore(tmp_path / "b-blobs"), seeded.bundle_dir
        )
    await db_session.rollback()
    await _assert_all_empty(db_session)


async def test_resealed_manifest_flipping_archive_state_aborts(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """A manifest that clears a truly-archived stream's `archived_at` is refused.

    The reducer can only stamp `now()` on `channel.archived`, so import trusts
    the manifest's operational `archived_at` timestamp — but the archive STATE
    (archived vs live) is reducer-derived and must agree, or a resealed manifest
    could silently un-archive a channel. The private channel in the seed is
    archived; blanking its `archived_at` in the manifest must abort.
    """
    seeded = await _seed_and_export(db_session, tmp_path)
    manifest_path = seeded.bundle_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["streams"][seeded.private_id]["archived_at"] is not None
    manifest["streams"][seeded.private_id]["archived_at"] = None
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    await db_session.execute(text(_RESET))

    with pytest.raises(RestoreError, match="archive state"):
        await import_workspace(
            db_session, LocalDiskBlobStore(tmp_path / "b-blobs"), seeded.bundle_dir
        )
    await db_session.rollback()
    await _assert_all_empty(db_session)


async def test_rehashed_foreign_workspace_event_aborts(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """A tampered event whose body was RE-hashed (hash check passes) but points
    at a foreign workspace_id is still refused — the binding checks are
    independent of the hash proof."""
    seeded = await _seed_and_export(db_session, tmp_path)
    month_path = sorted((seeded.bundle_dir / "streams" / seeded.general_id).glob("*.ndjson"))[0]
    lines = month_path.read_text(encoding="utf-8").splitlines()
    evt = json.loads(lines[0])
    evt["body"]["workspace_id"] = ids.new_workspace_id()
    evt["event_hash"] = hash_event(evt["body"])  # honest re-hash of the tamper
    lines[0] = json.dumps(evt, ensure_ascii=False, separators=(",", ":"))
    month_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    await db_session.execute(text(_RESET))

    with pytest.raises(RestoreError, match="workspace_id"):
        await import_workspace(
            db_session, LocalDiskBlobStore(tmp_path / "b-blobs"), seeded.bundle_dir
        )
    await db_session.rollback()
    await _assert_all_empty(db_session)


async def test_tampered_blob_is_rejected_by_verified_restore(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    seeded = await _seed_and_export(db_session, tmp_path)
    sha = sorted(seeded.blob_shas)[0]
    (seeded.bundle_dir / "blobs" / sha[:2] / sha).write_bytes(b"not the promised bytes")
    await db_session.execute(text(_RESET))

    with pytest.raises(RestoreError, match="verified restore"):
        await import_workspace(
            db_session, LocalDiskBlobStore(tmp_path / "b-blobs"), seeded.bundle_dir
        )
    await db_session.rollback()
    await _assert_all_empty(db_session)
    # The tampered bytes were never promoted into the store.
    assert not (tmp_path / "b-blobs" / sha[:2] / sha).exists()


async def test_owner_recredential_requires_exactly_one_match(
    db_session: AsyncSession, tmp_path: Path, settings: Settings
) -> None:
    seeded = await _seed_and_export(db_session, tmp_path)
    await db_session.execute(text(_RESET))
    store = LocalDiskBlobStore(tmp_path / "b-blobs")
    owner_hash = hash_password(settings, OWNER_PASSWORD)

    with pytest.raises(RestoreError, match="0 owner row"):
        await import_workspace(
            db_session,
            store,
            seeded.bundle_dir,
            owner_password_hash=owner_hash,
            owner_email="nobody@example.com",
        )
    await db_session.rollback()
    await _assert_all_empty(db_session)

    # Selecting the real owner by email works.
    await import_workspace(
        db_session,
        store,
        seeded.bundle_dir,
        owner_password_hash=owner_hash,
        owner_email="alice@example.com",
    )
    row = (
        (await db_session.execute(select(User).where(User.user_id == seeded.owner_id)))
        .scalars()
        .one()
    )
    assert row.password_hash == owner_hash


# ---------------------------------------------------------------------------
# The import_event primitive
# ---------------------------------------------------------------------------


async def _bootstrap_stream(db: AsyncSession) -> tuple[str, str]:
    await db.execute(text(_RESET))
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    db.add(Workspace(workspace_id=ws, name="Acme"))
    await db.flush()
    db.add(Stream(stream_id=stream, workspace_id=ws, kind="channel", name="c", visibility="public"))
    await db.flush()
    return ws, stream


def _envelope(body: dict[str, Any], *, seq: int, received_at: str) -> dict[str, Any]:
    return {
        "body": body,
        "event_hash": hash_event(body),
        "signature": None,
        "server": {
            "server_sequence": seq,
            "server_received_at": received_at,
            "payload_redacted": False,
        },
    }


async def test_import_event_preserves_sequence_timestamp_hash_and_body(
    db_session: AsyncSession,
) -> None:
    """The verbatim primitive: NOTHING is re-minted — no head_seq bump, no
    now() stamp — and the stored row round-trips the envelope exactly."""
    ws, stream = await _bootstrap_stream(db_session)
    body = build_message_created_body(
        workspace_id=ws,
        stream_id=stream,
        author_user_id=ids.new_user_id(),
        author_device_id=ids.new_device_id(),
        client_created_at="2026-01-02T03:04:05.678Z",
        text="hello wörld 🌍",
    ).model_dump(mode="json")
    received = "2025-11-30T23:59:59.999Z"
    seq = await import_event(
        db_session, stream_id=stream, envelope=_envelope(body, seq=41, received_at=received)
    )
    assert seq == 41
    await db_session.flush()

    row = (await db_session.execute(select(Event))).scalars().one()
    assert row.server_sequence == 41  # preserved, never head_seq+1
    assert to_rfc3339(row.server_received_at) == received  # preserved, never now()
    assert row.event_hash == hash_event(row.body)
    assert row.body == body  # verbatim JSONB
    assert row.payload_redacted is False
    # And head_seq was NOT consumed: the live sequencer still starts at 0.
    head = await db_session.scalar(select(Stream.head_seq).where(Stream.stream_id == stream))
    assert head == 0
    # The incremental projection landed in the same transaction (§4.2 ordering).
    assert body["payload"]["message_id"] in await dump_messages_proj(db_session)


async def test_import_event_fails_closed_on_hash_mismatch_and_redaction(
    db_session: AsyncSession,
) -> None:
    ws, stream = await _bootstrap_stream(db_session)
    body = message_body(
        auth={"workspace_id": ws, "user_id": ids.new_user_id(), "device_id": ids.new_device_id()},
        stream_id=stream,
    )
    good = _envelope(body, seq=1, received_at="2026-07-09T00:00:00.000Z")

    tampered = json.loads(json.dumps(good))
    tampered["body"]["payload"]["text"] = "TAMPERED"
    with pytest.raises(RestoreError, match="event_hash"):
        await import_event(db_session, stream_id=stream, envelope=tampered)

    redacted = json.loads(json.dumps(good))
    redacted["server"]["payload_redacted"] = True
    with pytest.raises(RestoreError, match="redaction authority"):
        await import_event(db_session, stream_id=stream, envelope=redacted)

    # Neither attempt stored anything.
    assert (await db_session.execute(select(Event).limit(1))).first() is None
