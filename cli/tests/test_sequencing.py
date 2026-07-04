"""AC: gapless + monotonic ``server_sequence`` across process restarts (§3.1, D2).

Each send runs in a **fresh subprocess** so the sequence is proven to be
re-derived from the log on every open, with no persisted counter.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from conftest import assert_every_line_verifies, read_lines, run_cli
from msgctl import append as append_mod
from msgctl.cli import main


def _send(root: Path, stream: str, text: str) -> dict[str, Any]:
    proc = run_cli("send", str(root), "--stream", stream, "--text", text)
    assert proc.returncode == 0, proc.stderr
    result: dict[str, Any] = json.loads(proc.stdout)
    return result


def test_sequences_are_gapless_across_restarts(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert run_cli("init", str(root)).returncode == 0

    n = 6
    seqs = [_send(root, "general", f"msg {i}")["server"]["server_sequence"] for i in range(n)]
    assert seqs == list(range(1, n + 1))  # exactly 1..N, strictly increasing, no gaps

    stream_dir = next((root / "streams").iterdir())
    lines = read_lines(stream_dir)
    assert len(lines) == n
    event_ids = {json.loads(line)["body"]["event_id"] for line in lines}
    assert len(event_ids) == n  # N distinct event_ids
    assert_every_line_verifies(stream_dir)

    # A further restart re-derives next == N+1.
    assert _send(root, "general", "one more")["server"]["server_sequence"] == n + 1


def test_streams_sequence_independently(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert run_cli("init", str(root)).returncode == 0

    assert _send(root, "alpha", "a1")["server"]["server_sequence"] == 1
    assert _send(root, "beta", "b1")["server"]["server_sequence"] == 1  # per-stream, D2
    assert _send(root, "alpha", "a2")["server"]["server_sequence"] == 2
    assert _send(root, "beta", "b2")["server"]["server_sequence"] == 2


def test_gapless_across_month_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Sequences stay gapless across two month files (Risks §6, month-boundary).

    ``server_received_at`` (which both stamps the envelope and picks the month
    file) is minted by ``append.now_rfc3339``; monkeypatching it forces two
    distinct month files while the scan still derives one contiguous sequence.
    """
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0

    def send_in_month(month_ts: str, text: str) -> int:
        monkeypatch.setattr(append_mod, "now_rfc3339", lambda: month_ts)
        capsys.readouterr()  # clear
        assert main(["send", str(root), "--stream", "general", "--text", text]) == 0
        out = json.loads(capsys.readouterr().out.strip())
        seq: int = out["server"]["server_sequence"]
        return seq

    assert send_in_month("2026-07-31T23:59:59.900Z", "july") == 1
    assert send_in_month("2026-08-01T00:00:00.100Z", "august") == 2  # no gap at boundary

    stream_dir = next((root / "streams").iterdir())
    months = sorted(p.name for p in stream_dir.glob("*.ndjson"))
    assert months == ["2026-07.ndjson", "2026-08.ndjson"]
    assert_every_line_verifies(stream_dir)
