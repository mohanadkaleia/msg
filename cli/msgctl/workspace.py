"""Workspace layout, manifest, and stream registry for ``msgctl`` (Ruling 1).

A *workspace* is a directory ``msgctl init`` materializes::

    <root>/
      workspace.json          # manifest + stream registry (keyed by stream_id)
      .lock                    # workspace-level advisory lock (registry mutations)
      streams/
        <stream_id>/           # keyed by id, never by name (rename-safe, §9)
          .lock                # per-stream advisory lock (append critical section)
          <YYYY-MM>.ndjson      # month-partitioned log; month = server_received_at

The manifest is deliberately ``workspace.json``, **not** the §9 export
``manifest.json``: a live workspace is not an export. It omits ``head_seq`` and
event counts on purpose — the log is the single source of truth for sequence
(Ruling 1), so no denormalized head can drift. The ``streams/`` subtree is
byte-for-byte the §9 export shape.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from msgd.core import ids

from msgctl.errors import CorruptLogError, WorkspaceError

__all__ = [
    "MANIFEST_NAME",
    "STREAMS_DIR",
    "WORKSPACE_LOCK",
    "STREAM_LOCK",
    "FORMAT_VERSION",
    "LocalAuthor",
    "StreamInfo",
    "Workspace",
    "now_rfc3339",
    "init_workspace",
    "resolve_or_create_stream",
]

MANIFEST_NAME: Final = "workspace.json"
STREAMS_DIR: Final = "streams"
WORKSPACE_LOCK: Final = ".lock"
STREAM_LOCK: Final = ".lock"
FORMAT_VERSION: Final = 1


def _fsync_dir(path: Path) -> None:
    """fsync a directory so a just-created/renamed dirent survives power loss.

    ``os.fsync`` on a file fd makes the file's *data* durable, but a newly
    created file's directory entry is not durable until the parent directory is
    fsync'd — without this, power loss can vanish a whole new month file
    including an already-acknowledged ``server_sequence`` (a lost *acked* event,
    not a torn one). Called after new-file/new-dir creation and after the
    manifest ``os.replace``.

    Platform nuance (explicitly waived for M0, alongside the flock/Windows
    note): on macOS ``fsync`` does not force a media flush — only ``F_FULLFSYNC``
    does, at large latency cost. Plain ``os.fsync(dirfd)`` is the correct
    baseline; macOS is dev-only, Linux (the §11 deployment target) has honest
    ``fsync``.
    """
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def now_rfc3339() -> str:
    """Current UTC time as an RFC 3339 ``…Z`` string, millisecond precision.

    Matches the §2.1 example shape (``2026-07-04T18:22:10.123Z``). The envelope's
    ``_validate_rfc3339`` is shape-only, so millisecond precision is a free (and
    stable) choice for ``server_received_at`` and ``client_created_at``.
    """
    dt = datetime.now(UTC)
    return f"{dt:%Y-%m-%dT%H:%M:%S}.{dt.microsecond // 1000:03d}Z"


@dataclass(frozen=True)
class LocalAuthor:
    """The single local identity every ``send`` authors as in M0 (no auth yet)."""

    user_id: str
    device_id: str


@dataclass(frozen=True)
class StreamInfo:
    """One registry entry: a stream's stable id plus its display metadata."""

    stream_id: str
    name: str
    kind: str
    created_at: str


@dataclass
class Workspace:
    """An opened workspace: its root, identity, and the loaded stream registry.

    ``streams`` is keyed by ``stream_id``; ``name_index`` inverts it (stream
    names are unique within a workspace) for name→id resolution on ``send``.
    """

    root: Path
    workspace_id: str
    name: str
    created_at: str
    local_author: LocalAuthor
    streams: dict[str, StreamInfo]

    @property
    def manifest_path(self) -> Path:
        return self.root / MANIFEST_NAME

    @property
    def streams_dir(self) -> Path:
        return self.root / STREAMS_DIR

    @property
    def lock_path(self) -> Path:
        return self.root / WORKSPACE_LOCK

    @property
    def name_index(self) -> dict[str, str]:
        """Derived name→stream_id map (rebuilt from ``streams`` on each access)."""
        return {info.name: sid for sid, info in self.streams.items()}

    def stream_dir(self, stream_id: str) -> Path:
        return self.streams_dir / stream_id

    @classmethod
    def open(cls, root: Path | str) -> Workspace:
        """Load ``<root>/workspace.json`` into a :class:`Workspace`.

        Raises:
            WorkspaceError: the directory is not an initialized workspace.
            CorruptLogError: the manifest is malformed or has a duplicate
                stream name (which would make name→id resolution ambiguous).
        """
        root = Path(root)
        manifest_path = root / MANIFEST_NAME
        if not manifest_path.is_file():
            raise WorkspaceError(f"not an msgctl workspace (no {MANIFEST_NAME}): {root}")
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CorruptLogError(f"cannot read {manifest_path}: {exc}") from exc
        if not isinstance(raw, dict):
            raise CorruptLogError(f"malformed manifest (not an object): {manifest_path}")

        try:
            author_raw = raw["local_author"]
            local_author = LocalAuthor(
                user_id=author_raw["user_id"],
                device_id=author_raw["device_id"],
            )
            streams_raw: dict[str, Any] = raw["streams"]
        except (KeyError, TypeError) as exc:
            raise CorruptLogError(f"malformed manifest (missing field): {manifest_path}") from exc

        streams: dict[str, StreamInfo] = {}
        seen_names: dict[str, str] = {}
        for stream_id, info in streams_raw.items():
            name = info["name"]
            if name in seen_names:
                raise CorruptLogError(
                    f"duplicate stream name {name!r} in manifest "
                    f"({seen_names[name]} and {stream_id}): {manifest_path}"
                )
            seen_names[name] = stream_id
            streams[stream_id] = StreamInfo(
                stream_id=stream_id,
                name=name,
                kind=info.get("kind", "channel"),
                created_at=info.get("created_at", ""),
            )

        return cls(
            root=root,
            workspace_id=raw["workspace_id"],
            name=raw.get("name", root.name),
            created_at=raw.get("created_at", ""),
            local_author=local_author,
            streams=streams,
        )

    def to_manifest(self) -> dict[str, Any]:
        """Serialize this workspace to the ``workspace.json`` manifest dict."""
        return {
            "format_version": FORMAT_VERSION,
            "workspace_id": self.workspace_id,
            "name": self.name,
            "created_at": self.created_at,
            "local_author": {
                "user_id": self.local_author.user_id,
                "device_id": self.local_author.device_id,
            },
            "streams": {
                sid: {
                    "name": info.name,
                    "kind": info.kind,
                    "created_at": info.created_at,
                }
                for sid, info in self.streams.items()
            },
        }

    def write_manifest(self) -> None:
        """Atomically (over)write ``workspace.json``.

        Temp file in ``root`` → ``flush`` + :func:`os.fsync` → :func:`os.replace`
        (atomic rename on POSIX) → fsync of ``root`` (the rename is atomic
        w.r.t. readers but not *durable* until the containing directory is
        fsync'd), so a crashed write leaves the prior manifest intact. The
        caller MUST hold the workspace lock (Ruling 4).
        """
        payload = json.dumps(self.to_manifest(), ensure_ascii=False, indent=2) + "\n"
        tmp_path = self.root / f".{MANIFEST_NAME}.tmp.{os.getpid()}"
        fd = os.open(tmp_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o644)
        try:
            os.write(fd, payload.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp_path, self.manifest_path)
        _fsync_dir(self.root)


def init_workspace(root: Path | str, *, name: str | None = None) -> Workspace:
    """Materialize a new workspace at ``root``.

    Mints a workspace ULID and a single local author identity, lays down the
    empty ``streams/`` tree, and writes the manifest.

    Raises:
        WorkspaceError: ``root`` already contains a ``workspace.json`` (never
            re-mint a ``workspace_id`` — Ruling 5, "refuse to clobber").
    """
    root = Path(root)
    manifest_path = root / MANIFEST_NAME
    if manifest_path.exists():
        raise WorkspaceError(f"workspace already initialized: {root}")

    (root / STREAMS_DIR).mkdir(parents=True, exist_ok=True)
    _fsync_dir(root)  # make the fresh streams/ dirent durable
    ws = Workspace(
        root=root,
        workspace_id=ids.new_workspace_id(),
        name=name if name is not None else root.resolve().name,
        created_at=now_rfc3339(),
        local_author=LocalAuthor(
            user_id=ids.new_user_id(),
            device_id=ids.new_device_id(),
        ),
        streams={},
    )
    # No concurrent process can hold a lock on a workspace that does not exist
    # yet, so the workspace lock is unnecessary for the initial write.
    ws.write_manifest()
    return ws


def resolve_or_create_stream(ws: Workspace, name: str, *, kind: str = "channel") -> str:
    """Return the ``stream_id`` for ``name``, creating the stream if absent.

    Auto-create is an **M0 convenience**: in M1 a stream is born from a
    ``channel.created`` / ``dm.created`` ``workspace-meta`` event (§2.2). The
    registry mutation (mint ``s_`` id, insert, atomic manifest rewrite, ``mkdir``)
    runs under the **workspace lock** and re-reads the manifest fresh so two
    racing processes agree on one id for a name.
    """
    # Fast path: already known in the in-memory registry.
    existing = ws.name_index.get(name)
    if existing is not None:
        return existing

    # Lazy import avoids a workspace<->append import cycle (append imports us).
    from msgctl.append import flock_exclusive

    with flock_exclusive(ws.lock_path):
        # Re-read under the lock: another process may have created it since.
        fresh = Workspace.open(ws.root)
        stream_id = fresh.name_index.get(name)
        if stream_id is None:
            stream_id = ids.new_stream_id()
            fresh.streams[stream_id] = StreamInfo(
                stream_id=stream_id,
                name=name,
                kind=kind,
                created_at=now_rfc3339(),
            )
            fresh.stream_dir(stream_id).mkdir(parents=True, exist_ok=True)
            _fsync_dir(fresh.streams_dir)  # make the new stream dirent durable
            fresh.write_manifest()
        # Reflect the freshly loaded registry back into the caller's handle.
        ws.streams = fresh.streams
    return stream_id
