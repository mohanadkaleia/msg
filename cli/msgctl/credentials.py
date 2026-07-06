"""Remote sidecar state: credentials, server binding, cursors, ``.gitignore`` (ENG-70 §2).

A *remote workspace* is a normal M0 workspace whose identity is bound to a live
server and which carries a gitignored ``.msgctl/`` sidecar dir — a sibling of
``workspace.json`` and ``streams/``, deliberately **outside** ``streams/`` so it
is invisible to ``verify``/``project``/``export`` (which enumerate
``streams/<id>/*.ndjson`` + named manifests only, never globbing the root):

===========================  =====  ======  ================================
file                         perms  secret  contents
===========================  =====  ======  ================================
``.msgctl/credentials.json`` 0600   yes     ``{token, expires_at}`` — raw bearer
``.msgctl/remote.json``      0644   no      server binding + server identity
``.msgctl/cursors.json``     0644   no      ``{stream_id: last_pulled_seq}``
``.msgctl/outbox.ndjson``    0644   no      one ``{body, event_hash}`` per line
===========================  =====  ======  ================================

**The raw token is stored, and that is correct (clarifying pin 6).** A bearer
client MUST hold the raw token — the *server* stores only ``sha256(token)``; the
client is the other half of the pair, with nothing to hash it against. The
acceptance intent is therefore **perms 0600, never logged, never printed, never
committed** — not "hashed on disk". 0600 is enforced *at create time* via
``os.open(..., O_CREAT|O_WRONLY|O_TRUNC, 0o600)`` (a later ``chmod`` would leave a
world-readable window), reusing the atomic temp-file + ``os.replace`` + dir-fsync
discipline of :meth:`msgctl.workspace.Workspace.write_manifest`.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Final

from msgctl.errors import UsageError
from msgctl.workspace import Workspace, _fsync_dir

__all__ = [
    "MSGCTL_DIR",
    "CREDENTIALS_NAME",
    "REMOTE_NAME",
    "CURSORS_NAME",
    "OUTBOX_NAME",
    "META_STREAM_NAME",
    "msgctl_dir",
    "is_remote",
    "write_credentials",
    "read_credentials",
    "write_remote_binding",
    "read_remote_binding",
    "read_cursors",
    "write_cursors",
    "ensure_gitignore",
    "require_remote",
]

#: The sidecar directory name (workspace root, outside ``streams/``).
MSGCTL_DIR: Final = ".msgctl"
CREDENTIALS_NAME: Final = "credentials.json"
REMOTE_NAME: Final = "remote.json"
CURSORS_NAME: Final = "cursors.json"
OUTBOX_NAME: Final = "outbox.ndjson"

#: The reserved registry name for the ``workspace-meta`` stream — the manifest's
#: unique-name index needs a non-null name (verify's ``unregistered_stream_dir``
#: cross-check, §4.6), and the meta stream's server ``name`` column may be null.
META_STREAM_NAME: Final = "workspace-meta"

#: Lines appended to the workspace-root ``.gitignore`` by ``login``. ``streams/``
#: and ``workspace.json`` stay tracked — the log is meant to be shareable.
_GITIGNORE_LINES: Final = (f"{MSGCTL_DIR}/", "projections.sqlite3*")


def msgctl_dir(ws: Workspace) -> Path:
    """The ``.msgctl/`` sidecar dir for ``ws`` (not created)."""
    return ws.root / MSGCTL_DIR


def _ensure_dir(path: Path) -> None:
    """Create ``.msgctl/`` if absent (0700) and make its dirent durable."""
    if not path.is_dir():
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        _fsync_dir(path.parent)


def _atomic_write(path: Path, data: bytes, *, mode: int) -> None:
    """Atomically (over)write ``path`` with ``data`` at file ``mode``.

    Temp file opened at ``mode`` (so a secret file is never briefly world-
    readable) → write → fsync → ``os.replace`` → fsync of the parent dir, the
    exact discipline :meth:`Workspace.write_manifest` uses. The temp file shares
    ``path``'s parent so ``os.replace`` is a same-filesystem atomic rename.
    """
    _ensure_dir(path.parent)
    tmp_path = path.parent / f".{path.name}.tmp.{os.getpid()}"
    fd = os.open(tmp_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, mode)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp_path, path)
    _fsync_dir(path.parent)


def _read_json(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise UsageError(f"malformed sidecar (not an object): {path}")
    return raw


def is_remote(ws: Workspace) -> bool:
    """True iff ``ws`` is a remote workspace (``.msgctl/remote.json`` exists)."""
    return (msgctl_dir(ws) / REMOTE_NAME).is_file()


def require_remote(ws: Workspace) -> dict[str, Any]:
    """Return the remote binding, or raise :class:`UsageError` if not remote.

    Guards ``push``/``pull``/``invite`` against a plain M0 workspace with a clean
    operator error rather than a confusing missing-file traceback.
    """
    if not is_remote(ws):
        raise UsageError(
            f"not a remote workspace (no {MSGCTL_DIR}/{REMOTE_NAME}); run `msgctl login` first: "
            f"{ws.root}"
        )
    return read_remote_binding(ws)


def write_credentials(ws: Workspace, *, token: str, expires_at: str) -> None:
    """Write ``credentials.json`` at 0600 (secret; enforced at create time)."""
    payload = json.dumps({"token": token, "expires_at": expires_at}, ensure_ascii=False) + "\n"
    _atomic_write(msgctl_dir(ws) / CREDENTIALS_NAME, payload.encode("utf-8"), mode=0o600)


def read_credentials(ws: Workspace) -> dict[str, Any]:
    """Read ``credentials.json`` (raises if missing/malformed)."""
    path = msgctl_dir(ws) / CREDENTIALS_NAME
    if not path.is_file():
        raise UsageError(f"no stored credentials; run `msgctl login`: {path}")
    return _read_json(path)


def write_remote_binding(ws: Workspace, binding: dict[str, Any]) -> None:
    """Write ``remote.json`` (0644; non-secret server binding + identity)."""
    payload = json.dumps(binding, ensure_ascii=False, indent=2) + "\n"
    _atomic_write(msgctl_dir(ws) / REMOTE_NAME, payload.encode("utf-8"), mode=0o644)


def read_remote_binding(ws: Workspace) -> dict[str, Any]:
    """Read ``remote.json`` (raises if missing/malformed)."""
    path = msgctl_dir(ws) / REMOTE_NAME
    if not path.is_file():
        raise UsageError(f"not a remote workspace: {path}")
    return _read_json(path)


def read_cursors(ws: Workspace) -> dict[str, int]:
    """Read the ``stream_id → last_pulled_seq`` cursor map (empty if absent)."""
    path = msgctl_dir(ws) / CURSORS_NAME
    if not path.is_file():
        return {}
    raw = _read_json(path)
    return {str(sid): int(seq) for sid, seq in raw.items()}


def write_cursors(ws: Workspace, cursors: dict[str, int]) -> None:
    """Durably (atomic 0644) persist the cursor map after a page is fsynced (§4.5)."""
    payload = json.dumps(cursors, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    _atomic_write(msgctl_dir(ws) / CURSORS_NAME, payload.encode("utf-8"), mode=0o644)


def ensure_gitignore(ws: Workspace) -> None:
    """Upsert ``.msgctl/`` + ``projections.sqlite3*`` into the workspace ``.gitignore``.

    Idempotent: only missing lines are appended, so re-running ``login`` never
    duplicates entries. ``streams/`` and ``workspace.json`` stay tracked.
    """
    path = ws.root / ".gitignore"
    existing = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    present = {line.strip() for line in existing}
    to_add = [line for line in _GITIGNORE_LINES if line not in present]
    if not to_add:
        return
    lines = list(existing)
    if lines and lines[-1].strip() != "":
        lines.append("")
    lines.append("# msgctl remote-mode sidecar (ENG-70) — never commit credentials")
    lines.extend(to_add)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
