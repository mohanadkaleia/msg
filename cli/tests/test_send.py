"""``msgctl send`` — AC: verify_hash green + Envelope model round-trip."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import assert_every_line_verifies, only_stream_dir, read_lines
from msgctl.cli import main
from msgd.core.envelope import Envelope


def test_send_appends_one_verifiable_line(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0
    capsys.readouterr()  # drop init output

    assert main(["send", str(root), "--stream", "general", "--text", "hello everyone"]) == 0
    stdout = capsys.readouterr().out.strip()

    stream_dir = only_stream_dir(root)
    lines = read_lines(stream_dir)
    assert len(lines) == 1
    # stdout is byte-identical to the stored line.
    assert stdout == lines[0]

    # Headline hash AC: the stored line verifies.
    envelopes = assert_every_line_verifies(stream_dir)
    env = envelopes[0]
    assert env.server is not None
    assert env.server.server_sequence == 1
    assert env.server.payload_redacted is False
    assert env.signature is None
    assert env.body.type == "message.created"
    assert env.body.payload["text"] == "hello everyone"


def test_send_round_trips_through_envelope_model(tmp_path: Path) -> None:
    """AC: round-trip — parsed line re-dumps to the same JSON, and verifies."""
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0
    assert main(["send", str(root), "--stream", "general", "--text", "rt"]) == 0

    stream_dir = only_stream_dir(root)
    line = read_lines(stream_dir)[0]
    parsed = json.loads(line)
    env = Envelope.model_validate(parsed)
    # Structural round-trip: model_dump deep-equals the stored JSON (ENG-54 ruling).
    assert env.model_dump(mode="json") == parsed


def test_send_format_plain(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0
    assert main(["send", str(root), "--stream", "general", "--text", "x", "--format", "plain"]) == 0
    env = assert_every_line_verifies(only_stream_dir(root))[0]
    assert env.body.payload["format"] == "plain"


def test_send_on_uninitialized_workspace_errors(tmp_path: Path) -> None:
    root = tmp_path / "nope"
    assert main(["send", str(root), "--stream", "general", "--text", "x"]) == 1
