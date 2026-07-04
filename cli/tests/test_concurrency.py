"""flock concurrency: two racing processes never fork a sequence (Ruling 4)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import assert_every_line_verifies, read_lines, run_cli

# fcntl.flock is POSIX-only; the whole locking guarantee is unavailable elsewhere.
pytest.importorskip("fcntl")

_WORKER = """
import sys
from msgctl.cli import main
root, label, k = sys.argv[1], sys.argv[2], int(sys.argv[3])
rc = 0
for i in range(k):
    rc |= main(["send", root, "--stream", "general", "--text", f"{label}-{i}"])
sys.exit(rc)
"""


def test_two_processes_do_not_fork_the_sequence(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert run_cli("init", str(root)).returncode == 0

    k = 15
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", _WORKER, str(root), label, str(k)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        for label in ("A", "B")
    ]
    for proc in procs:
        _, err = proc.communicate()
        assert proc.returncode == 0, err

    stream_dir = next((root / "streams").iterdir())
    lines = read_lines(stream_dir)
    seqs = sorted(json.loads(line)["server"]["server_sequence"] for line in lines)
    event_ids = {json.loads(line)["body"]["event_id"] for line in lines}

    # Exactly 1..2K, no duplicates, no gaps, 2K distinct event_ids.
    assert seqs == list(range(1, 2 * k + 1))
    assert len(event_ids) == 2 * k
    assert len(lines) == 2 * k
    assert_every_line_verifies(stream_dir)
