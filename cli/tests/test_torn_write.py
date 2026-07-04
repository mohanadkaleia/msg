"""Torn-write safety: a crashed partial trailing line is never accepted (Ruling 3)."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import assert_every_line_verifies, read_lines, run_cli


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
