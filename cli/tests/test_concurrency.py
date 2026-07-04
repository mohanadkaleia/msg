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
import sys, time
from pathlib import Path
from msgctl.cli import main
root, label, k, go = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
# Start gate (review F5): spin until the go-file appears so both workers hit
# their FIRST send -- the maximal-contention scan->write window -- together,
# making the lock-guard collision deterministic rather than probabilistic.
deadline = time.monotonic() + 10.0
while not Path(go).exists():
    if time.monotonic() > deadline:
        sys.exit(3)  # gate never opened; fail loudly instead of hanging CI
    time.sleep(0.001)
rc = 0
for i in range(k):
    rc |= main(["send", root, "--stream", "general", "--text", f"{label}-{i}"])
sys.exit(rc)
"""


def test_two_processes_do_not_fork_the_sequence(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert run_cli("init", str(root)).returncode == 0

    k = 15
    go_file = tmp_path / "go"
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", _WORKER, str(root), label, str(k), str(go_file)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        for label in ("A", "B")
    ]
    go_file.touch()  # both workers spin on the gate: release them together
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
