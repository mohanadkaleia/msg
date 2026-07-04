"""``msgctl rebuild`` — drop the projection and replay the whole log (ENG-59).

Covers the ticket's ACs and stated test plan:

- **complete-correct-table + rebuild ≡ incremental** — a rebuilt projection's
  ``dump_messages`` is byte-equal to an incrementally built one over the same
  multi-stream log (``test_rebuild_matches_incremental_multistream``);
- **interrupted rebuild leaves the previous projection intact** — an exception
  mid-replay leaves the live ``projections.sqlite3`` byte-for-byte unchanged and
  the stale ``.rebuild`` is cleaned on the next successful run
  (``test_interrupt_leaves_previous_projection_intact`` +
  ``test_rebuild_corrupt_log_hard_errors_and_preserves_live``);
- **read-only over the log** — every ``streams/**/*.ndjson`` is byte-identical
  before/after, torn trailing lines left in place
  (``test_rebuild_is_read_only_over_log``).

Plus: idempotent re-run, version normalization to the current
``PROJECTION_VERSION``, empty workspace, and workspace-lock serialization
(rebuild-vs-rebuild safety).

Sends go through the real ``msgctl`` subprocess; rebuild is driven in-process
(``rebuild_projection(ws)``) where a DB handle is needed for assertions, and via
the real subprocess for the CLI-contract paths.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import msgctl.projection as projection
import pytest
from conftest import only_stream_dir, run_cli
from msgctl.append import flock_exclusive
from msgctl.projection import (
    PROJECTION_DB_NAME,
    PROJECTION_VERSION,
    dump_messages,
    open_db,
    project,
)
from msgctl.rebuild import PROJECTION_REBUILD_DB_NAME, rebuild_projection
from msgctl.workspace import Workspace
from msgd.core.envelope import Envelope

# fcntl.flock is POSIX-only; the whole locking guarantee is unavailable elsewhere.
pytest.importorskip("fcntl")

# --- helpers ----------------------------------------------------------------


def _init(root: Path) -> None:
    assert run_cli("init", str(root)).returncode == 0


def _send(root: Path, stream: str, text: str) -> dict[str, Any]:
    """Send one message via the real CLI; return the stored envelope dict."""
    proc = run_cli("send", str(root), "--stream", stream, "--text", text)
    assert proc.returncode == 0, proc.stderr

    envelope: dict[str, Any] = json.loads(proc.stdout)
    return envelope


def _incremental_dump(root: Path) -> str:
    """Open + incrementally project + dump in-process (fresh connection)."""
    ws = Workspace.open(root)
    conn = open_db(root / PROJECTION_DB_NAME)
    try:
        project(ws, conn)
        return dump_messages(conn)
    finally:
        conn.close()


def _live_dump(root: Path) -> str:
    """Dump the live projection DB as-is (no projection run)."""
    conn = sqlite3.connect(root / PROJECTION_DB_NAME)
    try:
        return dump_messages(conn)
    finally:
        conn.close()


def _live_version(root: Path) -> int:
    conn = sqlite3.connect(root / PROJECTION_DB_NAME)
    try:
        return int(
            conn.execute("SELECT value FROM meta WHERE key = 'projection_version'").fetchone()[0]
        )
    finally:
        conn.close()


def _count(root: Path) -> int:
    conn = sqlite3.connect(root / PROJECTION_DB_NAME)
    try:
        return int(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0])
    finally:
        conn.close()


def _no_temp_leftover(root: Path) -> bool:
    """No stale rebuild temp (nor its rollback journal) between runs."""
    return (
        not (root / PROJECTION_REBUILD_DB_NAME).exists()
        and not (root / (PROJECTION_REBUILD_DB_NAME + "-journal")).exists()
    )


def _snapshot_logs(root: Path) -> dict[Path, bytes]:
    return {p: p.read_bytes() for p in (root / "streams").rglob("*.ndjson")}


# --- tests ------------------------------------------------------------------


def test_rebuild_matches_incremental_multistream(tmp_path: Path) -> None:
    """AC: complete correct table + the local ``rebuild ≡ incremental`` stand-in.

    Interleaved sends across two streams; the rebuilt dump is byte-equal to an
    incrementally built one both within one workspace and across a byte-identical
    log copy, and every sent message is present with the right fields.
    """
    root = tmp_path / "ws"
    _init(root)
    sent = []
    for i in range(3):
        sent.append(_send(root, "general", f"g{i}"))
        sent.append(_send(root, "random", f"r{i}"))

    # Incremental baseline in-process.
    incremental = _incremental_dump(root)
    assert incremental != ""  # meaningful only with rows present

    # rebuild in the SAME workspace → dump must be byte-identical (rebuild ≡ incremental).
    ws = Workspace.open(root)
    result = rebuild_projection(ws)
    assert result.applied == 6
    assert result.skipped == 0
    rebuilt = _live_dump(root)
    assert rebuilt == incremental
    assert _no_temp_leftover(root)

    # Every sent message is present with the correct projected columns.
    conn = sqlite3.connect(root / PROJECTION_DB_NAME)
    try:
        rows = {
            r[0]: r
            for r in conn.execute(
                "SELECT message_id, text, format, stream_id, server_sequence, author_user_id "
                "FROM messages"
            )
        }
    finally:
        conn.close()
    assert len(rows) == 6
    for env in sent:
        body = env["body"]
        mid = body["payload"]["message_id"]
        assert mid in rows
        _, text, fmt, stream_id, seq, author = rows[mid]
        assert text == body["payload"]["text"]
        assert fmt == body["payload"]["format"]
        assert stream_id == body["stream_id"]
        assert seq == env["server"]["server_sequence"]
        assert author == body["author_user_id"]

    # Cross-workspace determinism: a byte-identical log copy rebuilds to the same dump.
    root_b = tmp_path / "wb"
    shutil.copytree(root, root_b)
    (root_b / PROJECTION_DB_NAME).unlink()  # start B with no projection DB
    rebuild_projection(Workspace.open(root_b))
    assert _live_dump(root_b) == incremental


def test_interrupt_leaves_previous_projection_intact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC: an interrupted rebuild leaves the previous projection byte-for-byte intact.

    A good live projection exists; a fault injected mid-replay (after the
    first-visited stream has written into the *temp* DB) makes rebuild raise. The
    live ``projections.sqlite3`` is byte-identical to its pre-rebuild snapshot
    (the live file is never written — a valid raw-byte compare per Ruling 5). A
    ``.rebuild`` leftover may exist; the next successful rebuild cleans it and
    converges.
    """
    root = tmp_path / "ws"
    _init(root)
    alpha = _send(root, "alpha", "a1")["body"]["stream_id"]
    beta = _send(root, "beta", "b1")["body"]["stream_id"]
    # rebuild → project visits streams in sorted stream_id order; fail the LAST so
    # the first has already committed into the temp DB when the fault strikes.
    _, last_visited = sorted([alpha, beta])

    # A clean live projection to protect.
    _incremental_dump(root)
    live_snapshot = (root / PROJECTION_DB_NAME).read_bytes()

    original = projection._apply_message_created

    def failing(conn: sqlite3.Connection, env: Envelope) -> None:
        if env.body.stream_id == last_visited:
            raise RuntimeError("injected crash mid-replay")
        original(conn, env)

    monkeypatch.setitem(projection._HANDLERS, ("message.created", 1), failing)

    with pytest.raises(RuntimeError, match="injected crash"):
        rebuild_projection(Workspace.open(root))

    # The live projection was never touched — byte-identical to the snapshot.
    assert (root / PROJECTION_DB_NAME).read_bytes() == live_snapshot

    # Remove the fault and re-run → succeeds, stale .rebuild cleaned, DB converged.
    monkeypatch.undo()
    rebuild_projection(Workspace.open(root))
    assert _no_temp_leftover(root)

    clean = open_db(tmp_path / "clean.sqlite3")
    try:
        project(Workspace.open(root), clean)
        assert dump_messages(clean) == _live_dump(root)
    finally:
        clean.close()


def test_rebuild_is_read_only_over_log(tmp_path: Path) -> None:
    """AC: rebuild never writes, truncates, or repairs the log."""
    root = tmp_path / "ws"
    _init(root)
    for i in range(3):
        _send(root, "general", f"g{i}")
        _send(root, "random", f"r{i}")

    before = _snapshot_logs(root)
    rebuild_projection(Workspace.open(root))
    assert _snapshot_logs(root) == before  # every log byte-identical

    # Torn-trailing-line variant: a partial (no-\n) write is invisible to rebuild
    # AND left in place (rebuild never repairs — inherited from _read_stream_events).
    month_file = next(iter(sorted((root / "streams").rglob("*.ndjson"))))
    torn = b'{"body":{"event_id":"m_partial'  # crashed mid-write, no newline
    with open(month_file, "ab") as fh:
        fh.write(torn)
    with_torn = month_file.read_bytes()

    rebuild_projection(Workspace.open(root))
    assert month_file.read_bytes() == with_torn  # torn bytes untouched
    # The torn message never became a row.
    conn = sqlite3.connect(root / PROJECTION_DB_NAME)
    try:
        ids = {r[0] for r in conn.execute("SELECT message_id FROM messages")}
    finally:
        conn.close()
    assert "m_partial" not in ids


def test_rebuild_idempotent_rerun(tmp_path: Path) -> None:
    """Rebuild twice → identical dumps, no leftover; then send+project adds one row."""
    root = tmp_path / "ws"
    _init(root)
    for i in range(2):
        _send(root, "general", f"g{i}")
        _send(root, "random", f"r{i}")

    rebuild_projection(Workspace.open(root))
    dump1 = _live_dump(root)
    assert _no_temp_leftover(root)

    rebuild_projection(Workspace.open(root))
    dump2 = _live_dump(root)
    assert _no_temp_leftover(root)
    assert dump2 == dump1
    assert _count(root) == 4

    # Rebuild left a sane cursor state: an incremental project on top of a rebuilt
    # DB applies exactly the one new event, not a re-replay.
    _send(root, "general", "g2")
    ws = Workspace.open(root)
    conn = open_db(root / PROJECTION_DB_NAME)
    try:
        result = project(ws, conn)
    finally:
        conn.close()
    assert result.applied == 1
    assert _count(root) == 5


def test_rebuild_normalizes_stale_version(tmp_path: Path) -> None:
    """A live DB at an old version is rebuilt to the current ``PROJECTION_VERSION``."""
    root = tmp_path / "ws"
    _init(root)
    for i in range(3):
        _send(root, "general", f"m{i}")

    # Expected post-rebuild dump = a from-scratch projection of the same log.
    scratch = open_db(tmp_path / "scratch.sqlite3")
    try:
        project(Workspace.open(root), scratch)
        expected = dump_messages(scratch)
    finally:
        scratch.close()

    # Build the live DB, then stamp a stale version onto it.
    _incremental_dump(root)
    raw = sqlite3.connect(root / PROJECTION_DB_NAME)
    try:
        with raw:
            raw.execute("UPDATE meta SET value = '0' WHERE key = 'projection_version'")
    finally:
        raw.close()
    assert _live_version(root) == 0

    rebuild_projection(Workspace.open(root))
    assert _live_version(root) == PROJECTION_VERSION
    assert _live_dump(root) == expected


def test_rebuild_empty_workspace(tmp_path: Path) -> None:
    """init, no sends → exit 0, empty streams map, valid empty projection, no leftover."""
    root = tmp_path / "ws"
    _init(root)

    proc = run_cli("rebuild", str(root))
    assert proc.returncode == 0, proc.stderr

    assert json.loads(proc.stdout) == {
        "rebuilt": True,
        "applied": 0,
        "skipped": 0,
        "streams": {},
    }
    assert (root / PROJECTION_DB_NAME).is_file()
    assert _count(root) == 0
    assert _live_version(root) == PROJECTION_VERSION
    assert _no_temp_leftover(root)


def test_rebuild_corrupt_log_hard_errors_and_preserves_live(tmp_path: Path) -> None:
    """A corrupt terminated line → exit 1, clean ``msgctl:`` stderr, live DB intact.

    The sibling of ENG-58's ``test_corrupt_terminated_line_hard_errors`` at the
    rebuild layer: the failure happens before the swap, so the previously-good
    live projection is byte-identical afterward.
    """
    root = tmp_path / "ws"
    _init(root)
    _send(root, "general", "good")

    # A good live projection to protect.
    _incremental_dump(root)
    live_snapshot = (root / PROJECTION_DB_NAME).read_bytes()

    month_file = next(only_stream_dir(root).glob("*.ndjson"))
    with open(month_file, "ab") as fh:
        fh.write(b"this is not json\n")  # terminated corruption
    log_before = month_file.read_bytes()

    proc = run_cli("rebuild", str(root))
    assert proc.returncode == 1
    assert proc.stderr.startswith("msgctl:")
    assert "Traceback" not in proc.stderr
    # Failure before the swap: the live projection is byte-identical (untouched).
    assert (root / PROJECTION_DB_NAME).read_bytes() == live_snapshot
    # Read-only even on the error path: the log is byte-identical.
    assert month_file.read_bytes() == log_before


def test_rebuild_holds_workspace_lock(tmp_path: Path) -> None:
    """Rebuild serializes on the workspace lock (rebuild-vs-rebuild safety).

    The test process holds ``flock_exclusive(ws.lock_path)`` and launches a
    ``msgctl rebuild`` subprocess; the subprocess must block (not complete within
    a short window). Releasing the lock lets it complete 0 with a correct DB.
    """
    root = tmp_path / "ws"
    _init(root)
    for i in range(3):
        _send(root, "general", f"m{i}")

    ws = Workspace.open(root)
    with flock_exclusive(ws.lock_path):
        proc = subprocess.Popen(
            [sys.executable, "-m", "msgctl.cli", "rebuild", str(root)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        # Held lock ⇒ rebuild is blocked before its build+swap.
        with pytest.raises(subprocess.TimeoutExpired):
            proc.wait(timeout=1.5)
        # The live DB is still absent (rebuild never reached its swap).
        assert not (root / PROJECTION_DB_NAME).exists()
        time.sleep(0.05)  # small grace; the subprocess is still blocking on flock

    # Lock released → the subprocess acquires it and completes.
    out, err = proc.communicate(timeout=15)
    assert proc.returncode == 0, err
    assert (root / PROJECTION_DB_NAME).is_file()
    assert _count(root) == 3
    assert _no_temp_leftover(root)
