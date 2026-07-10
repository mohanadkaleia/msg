"""Portable workspace bundle writer (TDD §9 / D11, ENG-155 — M4-1).

:func:`export_workspace` streams a whole workspace out of Postgres + the blob
store into a bundle DIRECTORY::

    <dest>/
      manifest.json            # format_version, workspace meta, stream/blob
                               # index, sidecar digests, bundle_digest
      streams/
        <stream_id>/
          <YYYY-MM>.ndjson     # full envelopes, ascending server_sequence
      blobs/
        <ab>/<sha256hex>       # content-addressed, mirrors the BlobStore layout
      users.json               # user snapshot (NO password hashes / sessions)
      files.json               # PRESENT file rows

Design pins (each locked by a test):

* **One serialization.** Every NDJSON line is
  :func:`msgd.events.serialize.serialize_stored_event` through
  :func:`~msgd.events.serialize.event_ndjson_line` — the exact bytes the pull
  endpoint serves and ``msgctl pull`` writes to disk (§9: "one NDJSON line = one
  full envelope exactly as served by the API"). A fully-pulled client's
  ``streams/<id>/`` tree and an export's are byte-identical.
* **Memory-bounded.** Events are iterated per stream via keyset pagination
  (``server_sequence > last`` ascending, ``LIMIT page_size``) and the ORM
  identity map is expunged after every page — a huge stream is never
  materialized in memory. Blobs are copied chunk-streamed via
  :meth:`~msgd.blobs.store.BlobStore.get`.
* **Deterministic body.** Everything except ``exported_at`` (stamped by the
  CALLER — the CLI — never ``datetime.now()`` in here) and the derived
  ``bundle_digest`` is a pure function of DB + blob-store state: streams, users,
  files, and blob indexes are iterated in sorted key order, JSONB bodies
  round-trip verbatim, and two exports of the same workspace differ only in
  those two manifest fields.
* **Secrets never leave.** ``users.json`` carries the download-authz/UI fields
  only; ``password_hash``, ``sessions``, ``devices``, ``invites``,
  ``read_state``, and ``prefs`` are never queried. Private streams and DMs ARE
  exported — export is a whole-workspace server-admin operation (§9).
* **Missing-blob policy.** A PRESENT ``files`` row whose content (or thumbnail)
  blob is absent from the store is a HARD FAIL (:class:`MissingBlobsError`)
  unless ``allow_missing_blobs``, which records the digests in
  ``manifest.missing_blobs`` instead of copying them.
* **Sealed manifest.** ``bundle_digest`` = ``sha256:`` over the RFC 8785 (JCS)
  canonicalization of the manifest dict *without* the ``bundle_digest`` key —
  the same canonicalization discipline as ``event_hash`` (D1).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, Final

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.blobs.store import BlobNotFoundError, BlobStore
from msgd.core.jcs import canonicalize
from msgd.core.time import to_rfc3339
from msgd.db.models import Event, File, Stream, User, Workspace
from msgd.events.serialize import event_ndjson_line, serialize_stored_event
from msgd.projections.apply import PROJECTION_VERSION

__all__ = [
    "BUNDLE_FORMAT_VERSION",
    "DEFAULT_PAGE_SIZE",
    "ExportError",
    "ExportResult",
    "MissingBlobsError",
    "export_workspace",
]

#: ``manifest.json`` ``format_version`` (§9). Bump only with a migration story.
BUNDLE_FORMAT_VERSION: Final = 1

#: The one hash algorithm the bundle uses (D1) — file/blob digests are bare
#: lowercase hex; the JCS-canonicalized ``bundle_digest`` carries the
#: ``sha256:`` prefix like ``event_hash``.
_HASH_ALGORITHM: Final = "sha256"

#: Keyset page size for the per-stream event walk. Matches the pull endpoint's
#: ``MAX_LIMIT`` scale; overridable per call so tests can force page boundaries.
DEFAULT_PAGE_SIZE: Final = 500


class ExportError(Exception):
    """An export failed for an operator-explainable reason.

    Messages are safe to print verbatim: they name paths, counts, and content
    digests — never a DSN or credential.
    """


class MissingBlobsError(ExportError):
    """PRESENT ``files`` rows reference blobs absent from the store (hard fail).

    Raised only when ``allow_missing_blobs`` is false; the flag downgrades this
    to a ``manifest.missing_blobs`` record.
    """

    def __init__(self, missing: list[str]) -> None:
        preview = ", ".join(missing[:5]) + (", …" if len(missing) > 5 else "")
        super().__init__(
            f"{len(missing)} referenced blob(s) missing from the blob store: {preview} "
            "(re-run with --allow-missing-blobs to export anyway and record them "
            "in manifest.missing_blobs)"
        )
        self.missing = missing


@dataclass(frozen=True)
class ExportResult:
    """Summary of a completed export (the CLI prints these fields)."""

    streams: int
    events: int
    blobs: int
    blob_bytes: int
    missing_blobs: list[str]
    bundle_digest: str


class _MonthLog:
    """One open ``<YYYY-MM>.ndjson`` with incremental digest/size/seq stats.

    Hashing happens WHILE writing so a month file is never re-read to build its
    manifest entry (single pass, memory- and IO-bounded).
    """

    def __init__(self, path: Path) -> None:
        # "xb": the destination is a fresh bundle dir, so every month file must
        # be new — an existing file means the emptiness guard was bypassed.
        self.file: IO[bytes] = open(path, "xb")
        self.hasher = hashlib.sha256()
        self.bytes = 0
        self.event_count = 0
        self.first_seq = 0
        self.last_seq = 0

    def write(self, line: bytes, server_sequence: int) -> None:
        self.file.write(line)
        self.hasher.update(line)
        self.bytes += len(line)
        if self.event_count == 0:
            self.first_seq = server_sequence
        self.last_seq = server_sequence
        self.event_count += 1

    def close(self) -> dict[str, Any]:
        self.file.close()
        return {
            "sha256": self.hasher.hexdigest(),
            "bytes": self.bytes,
            "event_count": self.event_count,
            "first_seq": self.first_seq,
            "last_seq": self.last_seq,
        }


def _prepare_dest(dest: Path) -> None:
    """Refuse to write into anything but a new or empty directory."""
    if dest.exists():
        if not dest.is_dir():
            raise ExportError(f"export target exists and is not a directory: {dest}")
        if any(dest.iterdir()):
            raise ExportError(f"export target directory is not empty: {dest}")
    else:
        dest.mkdir(parents=True)


def _dump_json(obj: Any) -> bytes:
    """Deterministic human-readable JSON bytes for the manifest + sidecars.

    Key order is the (fixed) insertion order of the dicts built here — sorted
    queries in, deterministic bytes out. ``ensure_ascii=False`` matches the
    NDJSON discipline (UTF-8 on disk, not ``\\uXXXX`` escapes).
    """
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _write_sidecar(path: Path, obj: Any) -> str:
    """Write a JSON sidecar; return its bare-hex sha256 for the manifest."""
    data = _dump_json(obj)
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def _opt_rfc3339(moment: Any) -> str | None:
    """RFC 3339 for a nullable TIMESTAMPTZ column."""
    return None if moment is None else to_rfc3339(moment)


async def _load_workspace(session: AsyncSession) -> Workspace:
    rows = (await session.execute(select(Workspace))).scalars().all()
    if len(rows) != 1:
        raise ExportError(
            f"expected exactly one workspace row, found {len(rows)} "
            "(export is a whole-workspace, single-workspace-server operation)"
        )
    return rows[0]


async def _export_users(session: AsyncSession, path: Path) -> str:
    """Write ``users.json`` — the §9 user snapshot, secrets excluded.

    Exactly the fields download-authz / UI need from the ``users`` schema:
    ``password_hash`` is never selected into the output, and sessions / devices /
    invites are never queried at all. Sorted by ``user_id`` (determinism).
    """
    users = (await session.execute(select(User).order_by(User.user_id))).scalars().all()
    snapshot = [
        {
            "user_id": u.user_id,
            "email": u.email,
            "display_name": u.display_name,
            "role": u.role,
            "is_bot": u.is_bot,
            "deactivated_at": _opt_rfc3339(u.deactivated_at),
            # ENG-164 richer-profile columns (nullable). MUST round-trip: the
            # imported meta log's last ``user.profile_updated`` carries these,
            # so an empty row would diverge from the log — and because PATCH
            # /v1/me emits the RESULTING row state, the user's next edit would
            # then emit nulls that every client fold applies as "cleared",
            # destroying profile data workspace-wide.
            "title": u.title,
            "description": u.description,
            "status_emoji": u.status_emoji,
            "status_text": u.status_text,
            "status_expires_at": _opt_rfc3339(u.status_expires_at),
        }
        for u in users
    ]
    return _write_sidecar(path, snapshot)


async def _export_files(session: AsyncSession, path: Path) -> tuple[str, list[str]]:
    """Write ``files.json`` (PRESENT rows only); return (sha256, referenced blob shas).

    The referenced set is every present row's content ``sha256`` PLUS its
    ``thumbnail_sha256`` (thumbnails are first-class derived blobs, ENG-118).
    Not-present rows (initiated-never-uploaded) are invisible as content on every
    server surface, so they are invisible here too.
    """
    files = (
        (await session.execute(select(File).where(File.present).order_by(File.file_id)))
        .scalars()
        .all()
    )
    snapshot = []
    referenced: set[str] = set()
    for f in files:
        snapshot.append(
            {
                "file_id": f.file_id,
                "sha256": f.sha256,
                "name": f.name,
                "mime_type": f.mime_type,
                "size_bytes": f.size_bytes,
                "uploaded_by": f.uploaded_by,
                "stream_id": f.stream_id,
                "created_at": to_rfc3339(f.created_at),
                "thumbnail_sha256": f.thumbnail_sha256,
            }
        )
        referenced.add(f.sha256)
        if f.thumbnail_sha256 is not None:
            referenced.add(f.thumbnail_sha256)
    return _write_sidecar(path, snapshot), sorted(referenced)


async def _export_stream_events(
    session: AsyncSession,
    stream_id: str,
    stream_dir: Path,
    *,
    page_size: int,
) -> dict[str, Any]:
    """Stream one stream's log into month files; return the manifest ``files`` map.

    Keyset pagination (``server_sequence > last`` ascending) + per-page
    ``expunge_all`` keeps memory bounded regardless of stream size. Month split =
    the serialized envelope's ``server_received_at[:7]`` — the SAME string slice
    ``msgctl.sync._write_page`` uses, so the two trees agree byte-for-byte. A
    handle per month stays open for the stream's duration (clock regressions
    across a month boundary land in the right file, matching pull).
    """
    stream_dir.mkdir(parents=True)
    months: dict[str, _MonthLog] = {}
    last_seq = 0
    try:
        while True:
            rows = (
                (
                    await session.execute(
                        select(Event)
                        .where(Event.stream_id == stream_id, Event.server_sequence > last_seq)
                        .order_by(Event.server_sequence.asc())
                        .limit(page_size)
                    )
                )
                .scalars()
                .all()
            )
            if not rows:
                break
            for row in rows:
                event = serialize_stored_event(row)
                received_at: str = event["server"]["server_received_at"]
                month = received_at[:7]
                log = months.get(month)
                if log is None:
                    log = months[month] = _MonthLog(stream_dir / f"{month}.ndjson")
                log.write(event_ndjson_line(event).encode("utf-8"), row.server_sequence)
            last_seq = rows[-1].server_sequence
            # Memory bound: drop this page's ORM objects from the identity map.
            session.expunge_all()
            if len(rows) < page_size:
                break
    except BaseException:
        for log in months.values():
            log.file.close()
        raise
    return {f"{month}.ndjson": months[month].close() for month in sorted(months)}


async def _copy_blob(blob_store: BlobStore, sha256: str, blobs_dir: Path) -> int | None:
    """Copy one blob into ``blobs/<ab>/<hex>``; return its size, or None if absent."""
    target = blobs_dir / sha256[:2] / sha256
    target.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with open(target, "wb") as out:
            async for chunk in blob_store.get(sha256):
                out.write(chunk)
                size += len(chunk)
    except BlobNotFoundError:
        target.unlink(missing_ok=True)
        return None
    return size


async def export_workspace(
    session: AsyncSession,
    blob_store: BlobStore,
    dest: Path,
    *,
    exported_at: str,
    tool: str,
    allow_missing_blobs: bool = False,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> ExportResult:
    """Write the §9 workspace bundle into the new/empty directory ``dest``.

    ``exported_at`` is stamped by the CALLER (the CLI) so this function stays a
    deterministic transform of DB + blob-store state; ``tool`` names the writer
    (e.g. ``msgctl/0.1.0``) in the manifest.

    Raises:
        ExportError: ``dest`` unusable, or not exactly one workspace row.
        MissingBlobsError: a present file's blob (or thumbnail) is absent and
            ``allow_missing_blobs`` is false.
    """
    _prepare_dest(dest)

    workspace = await _load_workspace(session)

    users_sha = await _export_users(session, dest / "users.json")
    files_sha, referenced_blobs = await _export_files(session, dest / "files.json")

    # --- streams/<id>/<YYYY-MM>.ndjson, sorted by stream_id ------------------
    streams = (
        (
            await session.execute(
                select(Stream)
                .where(Stream.workspace_id == workspace.workspace_id)
                .order_by(Stream.stream_id)
            )
        )
        .scalars()
        .all()
    )
    streams_manifest: dict[str, Any] = {}
    event_count_total = 0
    for stream in streams:
        files_map = await _export_stream_events(
            session, stream.stream_id, dest / "streams" / stream.stream_id, page_size=page_size
        )
        stream_events = sum(entry["event_count"] for entry in files_map.values())
        event_count_total += stream_events
        streams_manifest[stream.stream_id] = {
            "kind": stream.kind,
            "name": stream.name,
            "visibility": stream.visibility,
            "archived_at": _opt_rfc3339(stream.archived_at),
            "head_seq": stream.head_seq,
            "event_count": stream_events,
            "files": files_map,
        }

    # --- blobs/<ab>/<hex> — content-addressed, thumbnails included -----------
    blob_index: dict[str, Any] = {}
    missing: list[str] = []
    total_blob_bytes = 0
    blobs_dir = dest / "blobs"
    for sha256 in referenced_blobs:  # already sorted + deduplicated
        size = await _copy_blob(blob_store, sha256, blobs_dir)
        if size is None:
            missing.append(sha256)
        else:
            blob_index[sha256] = {"bytes": size}
            total_blob_bytes += size
    if missing and not allow_missing_blobs:
        raise MissingBlobsError(missing)

    # --- manifest.json, sealed by bundle_digest ------------------------------
    manifest: dict[str, Any] = {
        "format_version": BUNDLE_FORMAT_VERSION,
        "exported_at": exported_at,
        "tool": tool,
        "hash_algorithm": _HASH_ALGORITHM,
        "projection_version": PROJECTION_VERSION,
        "workspace": {
            "workspace_id": workspace.workspace_id,
            "name": workspace.name,
            # ENG-152: null = never set; "" = explicitly cleared (row verbatim).
            "description": workspace.description,
            "created_at": to_rfc3339(workspace.created_at),
            "file_quota_bytes": workspace.file_quota_bytes,
        },
        "streams": streams_manifest,
        "event_count_total": event_count_total,
        "blobs": {
            "count": len(blob_index),
            "total_bytes": total_blob_bytes,
            "index": blob_index,
        },
        "sidecars": {"users.json": users_sha, "files.json": files_sha},
        "missing_blobs": missing,
    }
    # sha256: over RFC 8785 (JCS) of the manifest WITHOUT bundle_digest — the
    # same canonicalization discipline as event_hash (D1).
    bundle_digest = f"sha256:{hashlib.sha256(canonicalize(manifest)).hexdigest()}"
    manifest["bundle_digest"] = bundle_digest
    (dest / "manifest.json").write_bytes(_dump_json(manifest))

    return ExportResult(
        streams=len(streams),
        events=event_count_total,
        blobs=len(blob_index),
        blob_bytes=total_blob_bytes,
        missing_blobs=missing,
        bundle_digest=bundle_digest,
    )
