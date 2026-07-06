"""The locally-authored-event outbox (ENG-70 §3, the two-store model).

In a remote workspace the server is the sole sequencer, so the synced log
(``streams/<id>/*.ndjson``) holds **only** server-served envelopes, written
**only** by ``pull``. Locally-authored events cannot go there — they have no
authoritative ``server_sequence`` yet, and appending a local provisional line
would collide (duplicate seq / ``event_id``) with the server's copy when it comes
down via ``pull``, failing ``verify``.

Instead authoring (``send``) enqueues ``{body, event_hash}`` items — **no**
``server`` metadata, **no** sequence — to ``.msgctl/outbox.ndjson``, FIFO.
``push`` drains it: each accepted (or permanently rejected) item is removed; the
accepted event re-enters the log through ``pull`` as the server's authoritative
copy. The outbox never writes the log.

Durability: ``enqueue`` fsyncs the append so an event authored before a crash is
not lost. ``read_all`` is torn-line safe (a crashed partial trailing line is
ignored, matching the log reader) and ``remove`` rewrites via temp + ``os.replace``
so a compaction crash leaves the prior outbox intact.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from msgctl.credentials import OUTBOX_NAME, msgctl_dir
from msgctl.errors import CorruptLogError
from msgctl.workspace import Workspace, _fsync_dir

__all__ = ["OutboxItem", "outbox_path", "enqueue", "read_all", "remove"]


@dataclass(frozen=True)
class OutboxItem:
    """One queued, locally-authored event awaiting upload.

    ``line`` is the verbatim stored NDJSON text (no trailing newline); ``body`` /
    ``event_hash`` are its parsed fields and ``event_id`` is ``body["event_id"]``.
    """

    body: dict[str, Any]
    event_hash: str
    event_id: str
    line: str


def outbox_path(ws: Workspace) -> Path:
    return msgctl_dir(ws) / OUTBOX_NAME


def _serialize(body: dict[str, Any], event_hash: str) -> str:
    """Compact one outbox item — the same serialization as the batch wire item."""
    return json.dumps(
        {"body": body, "event_hash": event_hash},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def enqueue(ws: Workspace, body: dict[str, Any], event_hash: str) -> None:
    """Atomically append one ``{body, event_hash}`` item to the outbox (durable).

    The ``.msgctl/`` dir is created on first use. The line (with its trailing
    ``\\n``) is written in one ``write`` then fsynced before returning, so an
    authored event survives a crash between ``send`` and ``push``.
    """
    path = outbox_path(ws)
    if not path.parent.is_dir():
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        _fsync_dir(path.parent.parent)
    is_new = not path.exists()
    record = _serialize(body, event_hash)
    with open(path, "ab") as fh:
        fh.write((record + "\n").encode("utf-8"))
        fh.flush()
        os.fsync(fh.fileno())
    if is_new:
        _fsync_dir(path.parent)


def read_all(ws: Workspace) -> list[OutboxItem]:
    """Return every queued item in FIFO order (torn trailing line ignored).

    A terminated-but-unparseable line, or one missing ``body.event_id`` /
    ``event_hash``, is corruption our writer never emits →
    :class:`CorruptLogError`. A non-newline-terminated trailing chunk is a crashed
    partial ``enqueue`` (never acked) and is skipped without touching the file.
    """
    path = outbox_path(ws)
    if not path.is_file():
        return []
    raw = path.read_bytes()
    if not raw:
        return []
    items: list[OutboxItem] = []
    # The final split element after the last "\n" is "" for a terminated file, or
    # a torn partial line otherwise — either way it is not a complete item, so we
    # only parse the terminated lines (everything before the last "\n").
    terminated = raw if raw.endswith(b"\n") else raw[: raw.rfind(b"\n") + 1]
    for chunk in terminated.split(b"\n"):
        if not chunk:
            continue
        line = chunk.decode("utf-8")
        try:
            parsed = json.loads(line)
            body = parsed["body"]
            event_hash = parsed["event_hash"]
            event_id = body["event_id"]
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            raise CorruptLogError(f"corrupt outbox line in {path}: {exc}") from exc
        if (
            not isinstance(body, dict)
            or not isinstance(event_hash, str)
            or not isinstance(event_id, str)
        ):
            raise CorruptLogError(f"malformed outbox item in {path}")
        items.append(OutboxItem(body=body, event_hash=event_hash, event_id=event_id, line=line))
    return items


def remove(ws: Workspace, event_ids: set[str]) -> int:
    """Drain the given ``event_id``s from the outbox, preserving FIFO order.

    Compaction is a temp-file rewrite + ``os.replace`` (atomic; a crash leaves the
    prior outbox intact) of the items whose ``event_id`` is **not** in
    ``event_ids``. Returns the number of items removed. A now-empty outbox file is
    left in place (empty), which ``read_all`` treats as no items.
    """
    if not event_ids:
        return 0
    path = outbox_path(ws)
    current = read_all(ws)
    remaining = [item for item in current if item.event_id not in event_ids]
    removed = len(current) - len(remaining)
    payload = "".join(item.line + "\n" for item in remaining)
    tmp_path = path.parent / f".{OUTBOX_NAME}.tmp.{os.getpid()}"
    fd = os.open(tmp_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o644)
    try:
        os.write(fd, payload.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp_path, path)
    _fsync_dir(path.parent)
    return removed
