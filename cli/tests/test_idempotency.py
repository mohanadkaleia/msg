"""AC: a duplicate ``event_id`` is a no-op — never a second line (§3.2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import assert_every_line_verifies, only_stream_dir, read_lines
from msgctl.cli import main
from msgd.core import ids


def _send(root: Path, capsys: pytest.CaptureFixture[str], *extra: str) -> tuple[int, str, str]:
    code = main(["send", str(root), "--stream", "general", "--text", "hi", *extra])
    captured = capsys.readouterr()
    return code, captured.out.strip(), captured.err


def test_duplicate_event_id_is_noop(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0
    capsys.readouterr()

    event_id = ids.new_event_id()
    code1, out1, _ = _send(root, capsys, "--event-id", event_id)
    assert code1 == 0

    code2, out2, err2 = _send(root, capsys, "--event-id", event_id)
    assert code2 == 0

    stream_dir = only_stream_dir(root)
    lines = read_lines(stream_dir)
    assert len(lines) == 1  # exactly one line for E

    # Second call reprints the original record byte-for-byte + a stderr note.
    assert out2 == out1
    assert out2 == lines[0]
    assert "idempotent" in err2
    assert event_id in err2

    # The sequence did not advance: a following default send is the next number.
    code3, out3, _ = _send(root, capsys)
    assert code3 == 0
    assert json.loads(out3)["server"]["server_sequence"] == 2  # not 3 — no gap
    assert json.loads(out1)["server"]["server_sequence"] == 1

    assert_every_line_verifies(stream_dir)


def test_distinct_event_ids_produce_distinct_lines(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0
    capsys.readouterr()

    _send(root, capsys, "--event-id", ids.new_event_id())
    _send(root, capsys, "--event-id", ids.new_event_id())
    assert len(read_lines(only_stream_dir(root))) == 2
