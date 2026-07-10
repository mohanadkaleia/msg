"""Unit tests for the §9 workspace-bundle writer (ENG-155, M4-1).

Runs :func:`msgd.export.bundle.export_workspace` directly against the harness's
rolled-back ``db_session`` (the function is a pure read of DB + blob-store
state, so the savepoint transaction is exactly the right isolation): bundle
layout, canonical NDJSON lines, month split, sidecars, blob copy, manifest
fields + ``bundle_digest`` recompute, determinism, the missing-blob policy, the
keyset-pagination path, and the empty-destination guard.

The end-to-end path (real uvicorn + real ``msgctl export``) lives in
``cli/tests/test_export_e2e.py``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from msgd.blobs.store import LocalDiskBlobStore
from msgd.core import ids
from msgd.core.hashing import hash_event
from msgd.core.jcs import canonicalize
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.models import Event, File, Stream, User, Workspace
from msgd.export.bundle import (
    BUNDLE_FORMAT_VERSION,
    ExportError,
    MissingBlobsError,
    export_workspace,
)
from msgd.projections.apply import PROJECTION_VERSION
from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import AsyncSession

EXPORTED_AT = "2026-07-04T12:00:00.000Z"
TOOL = "msgctl/test"

#: A recognizable secret marker: if these bytes ever appear anywhere in a
#: bundle, users.json (or something else) leaked the ``password_hash`` column.
SECRET_HASH = "argon2id$super-secret-password-hash-marker"

_RESET = (
    "TRUNCATE messages_proj, reactions_proj, thread_participants_proj, events, "
    "read_state, prefs, files, stream_members, streams, sessions, devices, "
    "invites, users, workspaces CASCADE"
)

_JUNE = datetime(2026, 6, 15, 10, 0, 0, tzinfo=UTC)
_JULY = datetime(2026, 7, 1, 9, 30, 0, tzinfo=UTC)


async def _bytes_stream(data: bytes) -> AsyncIterator[bytes]:
    yield data


@dataclass
class Seeded:
    """Everything the assertions need to know about the seeded workspace."""

    workspace_id: str
    meta_stream_id: str
    public_stream_id: str
    private_stream_id: str
    dm_stream_id: str
    user_ids: list[str]
    blob_root: Path
    content_sha: str = ""
    thumb_sha: str = ""
    dedup_sha: str = ""
    events_per_stream: dict[str, int] = field(default_factory=dict)


async def _add_message(
    db: AsyncSession,
    *,
    workspace_id: str,
    stream_id: str,
    seq: int,
    text_: str,
    received_at: datetime,
    author_user_id: str,
) -> None:
    """Insert one honest ``message.created`` event row directly (full control)."""
    body: dict[str, Any] = build_message_created_body(
        workspace_id=workspace_id,
        stream_id=stream_id,
        author_user_id=author_user_id,
        author_device_id=ids.new_device_id(),
        client_created_at=now_rfc3339(),
        text=text_,
    ).model_dump(mode="json")
    db.add(
        Event(
            workspace_id=workspace_id,
            event_id=body["event_id"],
            stream_id=stream_id,
            server_sequence=seq,
            type=body["type"],
            type_version=body["type_version"],
            author_user_id=body["author_user_id"],
            author_device_id=body["author_device_id"],
            client_created_at=datetime.fromisoformat(
                body["client_created_at"].replace("Z", "+00:00")
            ),
            server_received_at=received_at,
            event_hash=hash_event(body),
            payload_redacted=False,
            body=body,
        )
    )
    await db.flush()


async def _seed(db: AsyncSession, tmp_path: Path) -> Seeded:
    """One workspace: meta + public + private + dm streams, 2 users, 3 files."""
    await db.execute(text(_RESET))

    ws = ids.new_workspace_id()
    db.add(Workspace(workspace_id=ws, name="Acme"))
    await db.flush()

    alice, bob = sorted([ids.new_user_id(), ids.new_user_id()])
    db.add(
        User(
            user_id=alice,
            workspace_id=ws,
            email="alice@example.com",
            password_hash=SECRET_HASH,
            display_name="Alice",
            role="owner",
            is_bot=False,
            # ENG-164 richer-profile columns must round-trip through the bundle.
            title="Founder",
            description="Runs Acme.",
            status_emoji="🚀",
            status_text="shipping",
            status_expires_at=_JULY,
        )
    )
    db.add(
        User(
            user_id=bob,
            workspace_id=ws,
            email="bob@example.com",
            password_hash=SECRET_HASH,
            display_name="Bob",
            role="member",
            is_bot=False,
            deactivated_at=_JULY,
        )
    )

    meta, public, private, dm = sorted(ids.new_stream_id() for _ in range(4))
    db.add(Stream(stream_id=meta, workspace_id=ws, kind="workspace-meta", head_seq=0))
    db.add(
        Stream(
            stream_id=public,
            workspace_id=ws,
            kind="channel",
            name="general",
            visibility="public",
            head_seq=3,
        )
    )
    db.add(
        Stream(
            stream_id=private,
            workspace_id=ws,
            kind="channel",
            name="secret-plans",
            visibility="private",
            head_seq=2,
            archived_at=_JULY,
        )
    )
    db.add(Stream(stream_id=dm, workspace_id=ws, kind="dm", head_seq=1))
    await db.flush()

    # public: 2 June events + 1 July event (month split); private: 2; dm: 1.
    await _add_message(
        db,
        workspace_id=ws,
        stream_id=public,
        seq=1,
        text_="hello wörld 🌍",
        received_at=_JUNE,
        author_user_id=alice,
    )
    await _add_message(
        db,
        workspace_id=ws,
        stream_id=public,
        seq=2,
        text_="second",
        received_at=_JUNE,
        author_user_id=bob,
    )
    await _add_message(
        db,
        workspace_id=ws,
        stream_id=public,
        seq=3,
        text_="july!",
        received_at=_JULY,
        author_user_id=alice,
    )
    for seq, text_ in ((1, "private one"), (2, "private two")):
        await _add_message(
            db,
            workspace_id=ws,
            stream_id=private,
            seq=seq,
            text_=text_,
            received_at=_JULY,
            author_user_id=alice,
        )
    await _add_message(
        db,
        workspace_id=ws,
        stream_id=dm,
        seq=1,
        text_="dm hi",
        received_at=_JULY,
        author_user_id=bob,
    )

    # Blobs: one image-ish content blob with a thumbnail, and one content blob
    # shared by TWO present rows (content-addressed dedup). Plus a NOT-present
    # row whose blob deliberately does not exist (must be ignored entirely).
    blob_root = tmp_path / "server-blobs"
    store = LocalDiskBlobStore(blob_root)
    content = b"PNG-ish bytes \x89PNG..." * 10
    thumb = b"WEBP-thumb-bytes" * 4
    shared = b"shared text attachment bytes"
    content_sha = await store.put(_bytes_stream(content))
    thumb_sha = await store.put(_bytes_stream(thumb))
    dedup_sha = await store.put(_bytes_stream(shared))

    f1, f2, f3, f4 = sorted(ids.new_file_id() for _ in range(4))
    db.add(
        File(
            file_id=f1,
            workspace_id=ws,
            sha256=content_sha,
            name="diagram.png",
            mime_type="image/png",
            size_bytes=len(content),
            uploaded_by=alice,
            stream_id=public,
            present=True,
            thumbnail_sha256=thumb_sha,
        )
    )
    db.add(
        File(
            file_id=f2,
            workspace_id=ws,
            sha256=dedup_sha,
            name="notes.txt",
            mime_type="text/plain",
            size_bytes=len(shared),
            uploaded_by=bob,
            stream_id=dm,
            present=True,
        )
    )
    db.add(
        File(
            file_id=f3,
            workspace_id=ws,
            sha256=dedup_sha,
            name="notes-copy.txt",
            mime_type="text/plain",
            size_bytes=len(shared),
            uploaded_by=alice,
            stream_id=private,
            present=True,
        )
    )
    # Initiated-never-uploaded: not present, blob absent — must not be exported
    # and must not trip the missing-blob check.
    db.add(
        File(
            file_id=f4,
            workspace_id=ws,
            sha256="ab" * 32,
            name="ghost.bin",
            mime_type="application/octet-stream",
            size_bytes=1,
            uploaded_by=alice,
            stream_id=public,
            present=False,
        )
    )
    await db.flush()

    return Seeded(
        workspace_id=ws,
        meta_stream_id=meta,
        public_stream_id=public,
        private_stream_id=private,
        dm_stream_id=dm,
        user_ids=[alice, bob],
        blob_root=blob_root,
        content_sha=content_sha,
        thumb_sha=thumb_sha,
        dedup_sha=dedup_sha,
        events_per_stream={meta: 0, public: 3, private: 2, dm: 1},
    )


def _canonical_line(evt: dict[str, Any]) -> str:
    return json.dumps(evt, ensure_ascii=False, separators=(",", ":")) + "\n"


async def test_bundle_layout_manifest_and_canonical_lines(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    seeded = await _seed(db_session, tmp_path)
    dest = tmp_path / "bundle"
    result = await export_workspace(
        db_session,
        LocalDiskBlobStore(seeded.blob_root),
        dest,
        exported_at=EXPORTED_AT,
        tool=TOOL,
    )

    # --- layout ---------------------------------------------------------------
    assert (dest / "manifest.json").is_file()
    assert (dest / "users.json").is_file()
    assert (dest / "files.json").is_file()
    stream_dirs = sorted(p.name for p in (dest / "streams").iterdir())
    assert stream_dirs == sorted(seeded.events_per_stream)
    # Month split: public has June + July files, private/dm July only, meta none.
    assert sorted(p.name for p in (dest / "streams" / seeded.public_stream_id).iterdir()) == [
        "2026-06.ndjson",
        "2026-07.ndjson",
    ]
    assert [p.name for p in (dest / "streams" / seeded.meta_stream_id).iterdir()] == []

    # --- every NDJSON line is THE canonical serialization ----------------------
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    for stream_id, expected_count in seeded.events_per_stream.items():
        seqs: list[int] = []
        for month_file in sorted((dest / "streams" / stream_id).glob("*.ndjson")):
            month = month_file.name.removesuffix(".ndjson")
            for line in month_file.read_text(encoding="utf-8").splitlines(keepends=True):
                evt = json.loads(line)
                assert line == _canonical_line(evt)  # compact, ensure_ascii=False, \n
                assert hash_event(evt["body"]) == evt["event_hash"]
                assert evt["signature"] is None
                assert evt["server"]["payload_redacted"] is False
                assert evt["server"]["server_received_at"][:7] == month
                assert evt["body"]["stream_id"] == stream_id
                seqs.append(evt["server"]["server_sequence"])
        assert seqs == sorted(seqs)
        assert len(seqs) == expected_count
        assert manifest["streams"][stream_id]["event_count"] == expected_count

    # --- users.json: snapshot fields only, secrets excluded --------------------
    users = json.loads((dest / "users.json").read_text(encoding="utf-8"))
    assert [u["user_id"] for u in users] == seeded.user_ids
    assert users[0] == {
        "user_id": seeded.user_ids[0],
        "email": "alice@example.com",
        "display_name": "Alice",
        "role": "owner",
        "is_bot": False,
        "deactivated_at": None,
        # ENG-164 richer profile — snapshotted verbatim (timestamp via _opt_rfc3339).
        "title": "Founder",
        "description": "Runs Acme.",
        "status_emoji": "🚀",
        "status_text": "shipping",
        "status_expires_at": "2026-07-01T09:30:00.000Z",
    }
    # Bob has no profile set → the new columns snapshot as null.
    assert users[1]["deactivated_at"] == "2026-07-01T09:30:00.000Z"
    assert users[1]["title"] is None
    assert users[1]["status_emoji"] is None
    assert users[1]["status_expires_at"] is None

    # No secret material anywhere in the bundle (password hashes, key names).
    for path in dest.rglob("*"):
        if path.is_file():
            data = path.read_bytes()
            assert SECRET_HASH.encode() not in data, path
            assert b"password_hash" not in data, path

    # --- files.json: PRESENT rows only -----------------------------------------
    files = json.loads((dest / "files.json").read_text(encoding="utf-8"))
    assert [f["name"] for f in files] == ["diagram.png", "notes.txt", "notes-copy.txt"]
    assert files[0]["sha256"] == seeded.content_sha
    assert files[0]["thumbnail_sha256"] == seeded.thumb_sha
    assert all(f["name"] != "ghost.bin" for f in files)

    # --- blobs: content + thumbnail, deduped, byte-exact ------------------------
    expected_shas = sorted({seeded.content_sha, seeded.thumb_sha, seeded.dedup_sha})
    on_disk = sorted(p.name for p in (dest / "blobs").rglob("*") if p.is_file())
    assert on_disk == expected_shas
    for sha in expected_shas:
        data = (dest / "blobs" / sha[:2] / sha).read_bytes()
        assert hashlib.sha256(data).hexdigest() == sha
        assert manifest["blobs"]["index"][sha]["bytes"] == len(data)
    assert manifest["blobs"]["count"] == 3 == result.blobs
    assert manifest["blobs"]["total_bytes"] == result.blob_bytes

    # --- manifest fields ---------------------------------------------------------
    assert manifest["format_version"] == BUNDLE_FORMAT_VERSION
    assert manifest["exported_at"] == EXPORTED_AT
    assert manifest["tool"] == TOOL
    assert manifest["hash_algorithm"] == "sha256"
    assert manifest["projection_version"] == PROJECTION_VERSION
    assert manifest["workspace"]["workspace_id"] == seeded.workspace_id
    assert manifest["workspace"]["name"] == "Acme"
    assert manifest["workspace"]["file_quota_bytes"] == 10737418240
    assert manifest["event_count_total"] == 6 == result.events
    assert manifest["missing_blobs"] == []
    assert manifest["sidecars"] == {
        "users.json": hashlib.sha256((dest / "users.json").read_bytes()).hexdigest(),
        "files.json": hashlib.sha256((dest / "files.json").read_bytes()).hexdigest(),
    }

    public = manifest["streams"][seeded.public_stream_id]
    assert public["kind"] == "channel"
    assert public["name"] == "general"
    assert public["visibility"] == "public"
    assert public["archived_at"] is None
    assert public["head_seq"] == 3
    june = public["files"]["2026-06.ndjson"]
    june_path = dest / "streams" / seeded.public_stream_id / "2026-06.ndjson"
    assert june["sha256"] == hashlib.sha256(june_path.read_bytes()).hexdigest()
    assert june["bytes"] == june_path.stat().st_size
    assert (june["event_count"], june["first_seq"], june["last_seq"]) == (2, 1, 2)
    assert public["files"]["2026-07.ndjson"]["first_seq"] == 3
    private = manifest["streams"][seeded.private_stream_id]
    assert private["visibility"] == "private"
    assert private["archived_at"] == "2026-07-01T09:30:00.000Z"
    meta = manifest["streams"][seeded.meta_stream_id]
    assert (meta["kind"], meta["event_count"], meta["files"]) == ("workspace-meta", 0, {})

    # --- bundle_digest recomputes over JCS(manifest without the digest) ---------
    digest = manifest.pop("bundle_digest")
    assert digest == f"sha256:{hashlib.sha256(canonicalize(manifest)).hexdigest()}"
    assert digest == result.bundle_digest


async def test_two_exports_differ_only_in_exported_at(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """Determinism: same workspace, two exports → identical bytes everywhere but
    ``manifest.json``, whose dicts differ ONLY in ``exported_at``/``bundle_digest``
    (this also pins the JSONB body round-trip as deterministic)."""
    seeded = await _seed(db_session, tmp_path)
    store = LocalDiskBlobStore(seeded.blob_root)
    a, b = tmp_path / "bundle-a", tmp_path / "bundle-b"
    await export_workspace(db_session, store, a, exported_at=EXPORTED_AT, tool=TOOL)
    await export_workspace(db_session, store, b, exported_at="2026-07-05T00:00:00.000Z", tool=TOOL)

    rel_a = sorted(p.relative_to(a) for p in a.rglob("*") if p.is_file())
    rel_b = sorted(p.relative_to(b) for p in b.rglob("*") if p.is_file())
    assert rel_a == rel_b
    for rel in rel_a:
        if rel.name == "manifest.json":
            continue
        assert (a / rel).read_bytes() == (b / rel).read_bytes(), rel

    ma = json.loads((a / "manifest.json").read_text(encoding="utf-8"))
    mb = json.loads((b / "manifest.json").read_text(encoding="utf-8"))
    assert ma.pop("exported_at") != mb.pop("exported_at")
    assert ma.pop("bundle_digest") != mb.pop("bundle_digest")
    assert ma == mb


async def test_missing_blob_hard_fails_unless_allowed(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    seeded = await _seed(db_session, tmp_path)
    store = LocalDiskBlobStore(seeded.blob_root)
    await store.delete(seeded.dedup_sha)

    with pytest.raises(MissingBlobsError) as excinfo:
        await export_workspace(
            db_session, store, tmp_path / "fails", exported_at=EXPORTED_AT, tool=TOOL
        )
    assert excinfo.value.missing == [seeded.dedup_sha]

    dest = tmp_path / "allowed"
    result = await export_workspace(
        db_session,
        store,
        dest,
        exported_at=EXPORTED_AT,
        tool=TOOL,
        allow_missing_blobs=True,
    )
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["missing_blobs"] == [seeded.dedup_sha] == result.missing_blobs
    assert seeded.dedup_sha not in manifest["blobs"]["index"]
    assert manifest["blobs"]["count"] == 2
    assert not (dest / "blobs" / seeded.dedup_sha[:2] / seeded.dedup_sha).exists()
    # The digest still seals the (missing-blob-recording) manifest.
    digest = manifest.pop("bundle_digest")
    assert digest == f"sha256:{hashlib.sha256(canonicalize(manifest)).hexdigest()}"


async def test_keyset_pagination_is_correct_across_page_boundaries(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """25 events walked with page_size=10 (2 full pages + a remainder): complete,
    ordered, gapless — the memory-bounded path never drops or duplicates a page
    edge. (Memory-boundedness itself is by construction: LIMITed keyset SELECTs +
    per-page ``expunge_all``.)"""
    seeded = await _seed(db_session, tmp_path)
    n = 25
    for seq in range(1, n + 1):
        await _add_message(
            db_session,
            workspace_id=seeded.workspace_id,
            stream_id=seeded.meta_stream_id,
            seq=seq,
            text_=f"bulk {seq}",
            received_at=_JULY,
            author_user_id=seeded.user_ids[0],
        )
    await db_session.execute(
        update(Stream).where(Stream.stream_id == seeded.meta_stream_id).values(head_seq=n)
    )

    dest = tmp_path / "paged"
    result = await export_workspace(
        db_session,
        LocalDiskBlobStore(seeded.blob_root),
        dest,
        exported_at=EXPORTED_AT,
        tool=TOOL,
        page_size=10,
    )
    lines = (
        (dest / "streams" / seeded.meta_stream_id / "2026-07.ndjson")
        .read_text(encoding="utf-8")
        .splitlines()
    )
    assert [json.loads(ln)["server"]["server_sequence"] for ln in lines] == list(range(1, n + 1))
    assert result.events == 6 + n


async def test_refuses_non_empty_destination(db_session: AsyncSession, tmp_path: Path) -> None:
    dest = tmp_path / "occupied"
    dest.mkdir()
    (dest / "keep.txt").write_text("do not clobber me")
    store = LocalDiskBlobStore(tmp_path / "no-blobs")
    with pytest.raises(ExportError, match="not empty"):
        await export_workspace(db_session, store, dest, exported_at=EXPORTED_AT, tool=TOOL)
    assert (dest / "keep.txt").read_text() == "do not clobber me"

    not_a_dir = tmp_path / "a-file"
    not_a_dir.write_text("x")
    with pytest.raises(ExportError, match="not a directory"):
        await export_workspace(db_session, store, not_a_dir, exported_at=EXPORTED_AT, tool=TOOL)
