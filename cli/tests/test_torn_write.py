"""Torn-write safety: a crashed partial trailing line is never accepted (Ruling 3).

Also pins the directory-fsync call sites (review round 1, F1): dirent durability
for new month files / stream dirs cannot be power-loss tested at M0, so the
guard asserts *where* ``_fsync_dir`` is called instead.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import assert_every_line_verifies, read_lines, run_cli
from msgctl import append as append_mod
from msgctl import workspace as workspace_mod
from msgctl.cli import main


def test_torn_trailing_line_is_dropped_and_its_sequence_reused(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert run_cli("init", str(root)).returncode == 0
    for i in range(3):
        assert run_cli("send", str(root), "--stream", "general", "--text", f"m{i}").returncode == 0

    stream_dir = next((root / "streams").iterdir())
    (month_file,) = list(stream_dir.glob("*.ndjson"))

    lines = read_lines(stream_dir)
    assert len(lines) == 3
    torn_event_id = json.loads(lines[2])["body"]["event_id"]

    # Simulate a crash mid-write of line 3: keep lines 1-2 whole, then a partial
    # of line 3 with no terminating newline.
    data = month_file.read_bytes()
    newline_positions = [i for i, byte in enumerate(data) if byte == 0x0A]
    line3_start = newline_positions[1] + 1
    torn = data[: line3_start + 10]  # first 10 bytes of line 3, no trailing "\n"
    assert not torn.endswith(b"\n")
    month_file.write_bytes(torn)

    # The next send scans, repairs the torn line, and reuses sequence 3 — no gap,
    # no CorruptLogError.
    proc = run_cli("send", str(root), "--stream", "general", "--text", "recovered")
    assert proc.returncode == 0, proc.stderr
    assert "dropped torn trailing line" in proc.stderr

    new_seq = json.loads(proc.stdout)["server"]["server_sequence"]
    assert new_seq == 3  # reused, not 4 — no gap

    surviving = read_lines(stream_dir)
    assert len(surviving) == 3
    seqs = [json.loads(line)["server"]["server_sequence"] for line in surviving]
    assert seqs == [1, 2, 3]

    # The torn partial was never acknowledged, so its event_id is absent.
    stored_event_ids = {json.loads(line)["body"]["event_id"] for line in surviving}
    assert torn_event_id not in stored_event_ids

    assert_every_line_verifies(stream_dir)


def test_fsync_dir_called_on_creation_not_on_plain_append(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """F1 guard: dir fsync fires on new-file/new-dir creation, not plain appends."""
    root = tmp_path / "ws"
    append_calls: list[Path] = []
    workspace_calls: list[Path] = []
    monkeypatch.setattr(append_mod, "_fsync_dir", lambda p: append_calls.append(Path(p)))
    monkeypatch.setattr(workspace_mod, "_fsync_dir", lambda p: workspace_calls.append(Path(p)))

    assert main(["init", str(root)]) == 0
    # init: streams/ creation + manifest os.replace, both fsync the root dir.
    assert workspace_calls == [root, root]

    workspace_calls.clear()
    assert main(["send", str(root), "--stream", "general", "--text", "first"]) == 0
    # First send: stream-dir creation fsyncs streams/, the manifest rewrite
    # fsyncs root, and the brand-new month file fsyncs the stream dir.
    assert root / "streams" in workspace_calls
    assert root in workspace_calls
    assert len(append_calls) == 1
    assert append_calls[0].parent == root / "streams"  # the stream dir itself

    workspace_calls.clear()
    append_calls.clear()
    assert main(["send", str(root), "--stream", "general", "--text", "second"]) == 0
    # Second append to the same month file: no dirent changes, no dir fsyncs.
    assert append_calls == []
    assert workspace_calls == []
    capsys.readouterr()
