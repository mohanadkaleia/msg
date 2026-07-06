"""The ``push`` and ``pull`` sync engines (ENG-70 §3/§4).

``push`` drains the outbox to the server in ordered batches; ``pull`` mirrors
every readable stream from sequence 1 into the synced log, verbatim, advancing a
per-stream cursor in lockstep with fsynced pages.

The two together realize the two-store model: locally-authored events go up via
``push`` (POST /v1/events/batch), come back down via ``pull`` as the server's
authoritative copy, and land in ``streams/<id>/*.ndjson`` — which therefore holds
**only** server-served envelopes and stays byte-equal across clients and green
under ``verify``/``project``/``rebuild``.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import IO, Any, Final

from msgctl.append import _repair_torn_line, flock_exclusive
from msgctl.client import MsgClient
from msgctl.credentials import META_STREAM_NAME, read_cursors, write_cursors
from msgctl.outbox import OutboxItem, read_all, remove
from msgctl.workspace import STREAM_LOCK, StreamInfo, Workspace, _fsync_dir, now_rfc3339

__all__ = ["PushResult", "PullResult", "push", "pull"]

#: Batch caps mirroring the server (``events_upload``): ≤100 events per batch and
#: a whole-request body well under the 1 MB cap (margin for the ``{"events":[…]}``
#: wrapper + separators).
_MAX_BATCH_ITEMS: Final = 100
_MAX_BATCH_BYTES: Final = 1024 * 1024 - 8192

#: Pull page size — the server clamps ``limit`` into ``[1, 500]``; ask for the max.
_PULL_LIMIT: Final = 500


@dataclass(frozen=True)
class RejectedItem:
    """One permanently rejected outbox item (reported, then drained)."""

    event_id: str
    code: str
    detail: str


@dataclass
class PushResult:
    """Outcome of a :func:`push`: accepted count + any permanent rejections."""

    accepted: int = 0
    rejected: list[RejectedItem] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.rejected


@dataclass
class PullResult:
    """Outcome of a :func:`pull`: streams seen, events written, streams newly registered."""

    streams: int = 0
    events: int = 0
    registered: list[str] = field(default_factory=list)


# --- push -------------------------------------------------------------------


def _batches(items: list[OutboxItem]) -> Iterator[list[OutboxItem]]:
    """Yield FIFO batches of ≤100 items and ≤~1 MB (each item's wire line size)."""
    batch: list[OutboxItem] = []
    size = 0
    for item in items:
        item_bytes = len(item.line.encode("utf-8")) + 1  # +1 for the array separator
        if batch and (len(batch) >= _MAX_BATCH_ITEMS or size + item_bytes > _MAX_BATCH_BYTES):
            yield batch
            batch, size = [], 0
        batch.append(item)
        size += item_bytes
    if batch:
        yield batch


def push(ws: Workspace, client: MsgClient) -> PushResult:
    """Drain the outbox to the server in ordered batches (idempotent retry).

    Each batch is POSTed via :meth:`MsgClient.post_batch`, whose retry loop re-
    sends the SAME ``event_id``s on a transient fault so server idempotency
    (``UNIQUE(workspace_id, event_id)``) yields the original record — no
    duplicate. Both accepted and permanently-rejected items are drained from the
    outbox **after** the response (crash-safe order: a crash before the drain
    leaves the items queued, and the retry re-accepts idempotently). A rejection
    makes :attr:`PushResult.ok` false so the CLI exits nonzero.
    """
    result = PushResult()
    for batch in _batches(read_all(ws)):
        resp = client.post_batch([{"body": it.body, "event_hash": it.event_hash} for it in batch])
        accepted = resp.get("accepted", [])
        rejected = resp.get("rejected", [])
        result.accepted += len(accepted)
        for rej in rejected:
            result.rejected.append(
                RejectedItem(
                    event_id=str(rej.get("event_id", "")),
                    code=str(rej.get("code", "")),
                    detail=str(rej.get("detail", "")),
                )
            )
        # Both outcomes are terminal for the outbox: accepted events return via
        # pull; rejected events are permanent faults the client must stop retrying.
        drain = {str(a["event_id"]) for a in accepted} | {
            str(r.get("event_id", "")) for r in rejected
        }
        remove(ws, drain)
    return result


# --- pull -------------------------------------------------------------------


def _register_streams(ws: Workspace, streams: list[dict[str, Any]]) -> list[str]:
    """Register every synced stream in ``workspace.json`` if absent (§4.6).

    A pulled stream dir with events but no manifest entry fails ``verify``
    (``unregistered_stream_dir``), so registration must precede writing any page.
    ``workspace-meta`` gets the reserved name (its server ``name`` may be null and
    the manifest's unique-name index needs a non-null name); a channel with a null
    name (private) falls back to its stream id. Runs under the workspace lock and
    re-reads the manifest fresh, matching ``resolve_or_create_stream``.
    """
    registered: list[str] = []
    with flock_exclusive(ws.lock_path):
        fresh = Workspace.open(ws.root)
        for s in streams:
            sid = str(s["stream_id"])
            if sid in fresh.streams:
                continue
            kind = str(s.get("kind", "channel"))
            if kind == "workspace-meta":
                name = META_STREAM_NAME
            else:
                name = s.get("name") or sid
            fresh.streams[sid] = StreamInfo(
                stream_id=sid, name=str(name), kind=kind, created_at=now_rfc3339()
            )
            registered.append(sid)
        if registered:
            fresh.write_manifest()
        ws.streams = fresh.streams
    return registered


def _write_page(ws: Workspace, stream_id: str, events: list[dict[str, Any]]) -> int:
    """Append a page verbatim to the stream's month files; return the new cursor.

    Each event is written with the **same** compact serialization the M0 log
    writer uses (``json.dumps(evt, ensure_ascii=False, separators=(",",":"))`` +
    ``"\\n"``) into ``<server_received_at[:7]>.ndjson`` — so both clients derive
    the same month split from the same server-supplied timestamp and their logs
    are byte-identical. Before the first append to a month file, any torn trailing
    line from an interrupted prior write is repaired (same semantics as
    ``append.py``) so it cannot fuse with this page. All touched files are fsynced
    before returning; the caller advances + persists the cursor only after.
    Held under the per-stream ``flock``.
    """
    stream_dir = ws.stream_dir(stream_id)
    created_dir = not stream_dir.exists()
    stream_dir.mkdir(parents=True, exist_ok=True)
    if created_dir:
        _fsync_dir(ws.streams_dir)

    with flock_exclusive(stream_dir / STREAM_LOCK):
        open_files: dict[str, IO[bytes]] = {}
        new_files: set[str] = set()
        try:
            for evt in events:
                month = str(evt["server"]["server_received_at"])[:7]
                path = stream_dir / f"{month}.ndjson"
                key = str(path)
                if key not in open_files:
                    if path.exists():
                        _repair_torn_line(path, path.read_bytes())
                    else:
                        new_files.add(key)
                    open_files[key] = open(path, "ab")
                line = json.dumps(evt, ensure_ascii=False, separators=(",", ":")) + "\n"
                open_files[key].write(line.encode("utf-8"))
            for fh in open_files.values():
                fh.flush()
                os.fsync(fh.fileno())
        finally:
            for fh in open_files.values():
                fh.close()
        if new_files:
            _fsync_dir(stream_dir)

    return int(events[-1]["server"]["server_sequence"])


def pull(ws: Workspace, client: MsgClient) -> PullResult:
    """Mirror every readable stream from sequence 1 into the synced log (§4).

    ``GET /v1/sync`` lists the readable streams; each is registered, then paged
    from its cursor (0 ≡ from seq 1) forward via ``GET /v1/events?after=<cursor>``,
    appended verbatim, with the cursor advanced + durably persisted **after** each
    page's bytes are fsynced. On resume, ``after=cursor`` re-fetches nothing
    already written (``seq ≤ cursor``), so there is no double-append.
    """
    result = PullResult()
    sync = client.get_sync()
    streams = sorted(sync.get("streams", []), key=lambda s: str(s["stream_id"]))
    result.streams = len(streams)
    result.registered = _register_streams(ws, streams)

    cursors = read_cursors(ws)
    for s in streams:
        sid = str(s["stream_id"])
        cursor = cursors.get(sid, 0)
        while True:
            page = client.get_events(stream_id=sid, after=cursor, limit=_PULL_LIMIT)
            events = page.get("events", [])
            if not events:
                break
            cursor = _write_page(ws, sid, events)
            cursors[sid] = cursor
            write_cursors(ws, cursors)  # durable, only after the page is fsynced
            result.events += len(events)
            if not page.get("has_more"):
                break
    return result
