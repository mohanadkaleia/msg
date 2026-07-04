"""The crash-safe, idempotent NDJSON append engine (Rulings 2–4).

``msgctl send`` is the M0 stand-in for the M1 sync server's sequencer. This
module owns the critical section that makes that honest:

- **Scan-on-open** (Ruling 3): the log *is* the source of truth. On entering a
  stream's critical section we re-derive the next ``server_sequence`` and the set
  of accepted ``event_id``s by scanning every month file. There is no sidecar
  counter to drift across restarts.
- **Torn-write safety** (Ruling 3): a line is *accepted* only if newline-
  terminated. A crashed partial trailing write is truncated on open (with a
  stderr warning); its would-be sequence is simply reused, so no gap appears.
- **Idempotency** (§3.2): a repeated ``event_id`` is a no-op that returns the
  original stored line and consumes no sequence.
- **Locking** (Ruling 4): an ``fcntl.flock`` exclusive lock serializes the whole
  scan→check→append per stream so two racing processes never fork a sequence.

POSIX-only: ``fcntl.flock`` is unavailable on Windows, which is out of scope for
M0 (Linux server image + macOS dev). The ``.lock`` files are advisory and left
in place harmlessly.
"""

from __future__ import annotations

import fcntl
import json
import os
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from msgd.core.envelope import Envelope

from msgctl.errors import CorruptLogError
from msgctl.workspace import STREAM_LOCK, Workspace, now_rfc3339

__all__ = [
    "ScanResult",
    "AppendResult",
    "flock_exclusive",
    "append_event",
]


@dataclass(frozen=True)
class ScanResult:
    """The state derived by scanning a stream's log on open.

    ``event_ids`` maps each accepted ``event_id`` to its verbatim stored line
    (no trailing newline) so the idempotent path can return the original record.
    """

    last_seq: int
    event_ids: dict[str, str]


@dataclass(frozen=True)
class AppendResult:
    """Outcome of :func:`append_event`.

    ``line`` is the stored envelope JSON text (no trailing newline) — the newly
    appended line when ``appended`` is true, or the original stored line on an
    idempotent no-op.
    """

    line: str
    appended: bool


@contextmanager
def flock_exclusive(path: Path) -> Iterator[None]:
    """Hold an exclusive ``fcntl.flock`` on a dedicated lock file at ``path``.

    The lock file is created if absent and left in place (advisory, self-cleaning
    across runs). The lock is released by closing the fd in ``finally`` / on
    process exit, so a crash never leaves a stale lock.
    """
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _month_file(stream_dir: Path, server_received_at: str) -> Path:
    """Month-partition path for a timestamp: ``<YYYY-MM>.ndjson`` (§9)."""
    year_month = server_received_at[:7]  # "YYYY-MM" from an RFC 3339 ...Z string
    return stream_dir / f"{year_month}.ndjson"


def _repair_torn_line(path: Path, data: bytes) -> bytes:
    """Truncate a crashed partial trailing line; return the clean bytes.

    A non-empty file whose last byte is not ``\\n`` ends in a torn write. We
    truncate to just past the last complete line (or to empty if none) and warn
    on stderr. Truncation — not mere in-memory skipping — is required: leaving the
    partial bytes would fuse them with the next append into one corrupt line.
    """
    if not data or data.endswith(b"\n"):
        return data
    last_nl = data.rfind(b"\n")
    keep = last_nl + 1  # 0 when there is no complete line at all
    with open(path, "r+b") as fh:
        fh.truncate(keep)
    print(f"warning: dropped torn trailing line in {path}", file=sys.stderr)
    return data[:keep]


def _scan_file(path: Path, last_seq: int, event_ids: dict[str, str]) -> int:
    """Scan one month file, returning the running last accepted sequence.

    Repairs a torn trailing line, then validates every terminated line: JSON +
    :class:`Envelope`, strict per-stream contiguity (``seq == prev + 1``, first
    ``== 1``). A terminated line that fails to parse is corruption our writer
    never emits → :class:`CorruptLogError` (never silently skipped). An unknown
    event *type* is a real accepted event (D9): counted and preserved, not an
    error — M0 only sends ``message.created`` but the scan must not choke.
    """
    raw = path.read_bytes()
    raw = _repair_torn_line(path, raw)
    if not raw:
        return last_seq

    for line in raw.split(b"\n"):
        if not line:  # trailing element after the final "\n"
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CorruptLogError(f"corrupt terminated line in {path}: {exc}") from exc
        envelope = Envelope.model_validate(parsed)
        if envelope.server is None:
            raise CorruptLogError(f"stored line missing server metadata in {path}")
        seq = envelope.server.server_sequence
        if seq != last_seq + 1:
            raise CorruptLogError(f"sequence gap in {path}: expected {last_seq + 1}, found {seq}")
        last_seq = seq
        event_ids[envelope.body.event_id] = line.decode("utf-8")
    return last_seq


def _scan_stream(stream_dir: Path) -> ScanResult:
    """Derive ``(last_seq, event_ids)`` across all of a stream's month files.

    ``*.ndjson`` sorted lexically is chronological, so contiguity is checked
    across month boundaries by accumulating one running sequence.
    """
    last_seq = 0
    event_ids: dict[str, str] = {}
    if stream_dir.is_dir():
        for path in sorted(stream_dir.glob("*.ndjson")):
            last_seq = _scan_file(path, last_seq, event_ids)
    return ScanResult(last_seq=last_seq, event_ids=event_ids)


def append_event(
    ws: Workspace,
    stream_id: str,
    *,
    build_envelope: Callable[[int, str], Envelope],
) -> AppendResult:
    """Idempotently append one event to a stream's log, crash-safely.

    Holds the per-stream lock across the whole scan→check→append so a concurrent
    process cannot mint the same sequence. ``build_envelope(next_seq, recv_at)``
    is invoked **inside** the lock so the sequence and ``server_received_at`` are
    minted from a fresh scan; if the built envelope's ``event_id`` is already
    present the call is a no-op returning the original line (§3.2).

    The line is written including its trailing ``\\n`` in one ``write``, then
    flushed and ``fsync``ed **before** returning — so the event is durable before
    it is acknowledged and a torn write can never be accepted.
    """
    stream_dir = ws.stream_dir(stream_id)
    stream_dir.mkdir(parents=True, exist_ok=True)

    with flock_exclusive(stream_dir / STREAM_LOCK):
        scan = _scan_stream(stream_dir)
        next_seq = scan.last_seq + 1
        recv_at = now_rfc3339()
        envelope = build_envelope(next_seq, recv_at)

        event_id = envelope.body.event_id
        if event_id in scan.event_ids:
            return AppendResult(line=scan.event_ids[event_id], appended=False)

        record = json.dumps(
            envelope.model_dump(mode="json"),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        month_path = _month_file(stream_dir, recv_at)
        with open(month_path, "ab") as fh:
            fh.write((record + "\n").encode("utf-8"))
            fh.flush()
            os.fsync(fh.fileno())
        return AppendResult(line=record, appended=True)
