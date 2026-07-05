"""``msgctl send`` — AC: verify_hash green + Envelope model round-trip."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import assert_every_line_verifies, only_stream_dir, read_lines, run_cli
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


def test_send_malformed_event_id_clean_exit_1(tmp_path: Path) -> None:
    """A non-ULID --event-id fails a Body field validator → clean exit 1, no traceback.

    The ValidationError is raised while building the envelope, before append_event
    writes anything, so the send consumes no sequence and appends nothing.
    """
    root = tmp_path / "ws"
    assert run_cli("init", str(root)).returncode == 0

    proc = run_cli(
        "send", str(root), "--stream", "general", "--text", "x", "--event-id", "not-a-ulid"
    )
    assert proc.returncode == 1
    assert "msgctl: invalid event field" in proc.stderr
    assert "Traceback" not in proc.stderr

    # Nothing appended; a normal send still gets sequence 1.
    assert run_cli("send", str(root), "--stream", "general", "--text", "ok").returncode == 0
    env = assert_every_line_verifies(only_stream_dir(root))[0]
    assert env.server is not None
    assert env.server.server_sequence == 1


def test_send_malformed_author_user_id_clean_exit_1(tmp_path: Path) -> None:
    """A bogus --author-user-id (missing u_ prefix) → clean exit 1, no traceback."""
    root = tmp_path / "ws"
    assert run_cli("init", str(root)).returncode == 0

    proc = run_cli(
        "send", str(root), "--stream", "general", "--text", "x", "--author-user-id", "bogus"
    )
    assert proc.returncode == 1
    assert "msgctl: invalid event field" in proc.stderr
    assert "Traceback" not in proc.stderr

    # Nothing appended: the stream dir exists (resolved pre-build) but has no lines.
    assert read_lines(only_stream_dir(root)) == []


def test_oversized_send_rejected_without_burning_a_sequence(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    """The §2.1 64 KB cap is enforced locally; a rejection consumes no sequence."""
    root = tmp_path / "ws"
    assert main(["init", str(root)]) == 0
    capsys.readouterr()

    # ~66,000 chars > MAX_EVENT_SIZE_BYTES (65,536) on the {body, event_hash} wire form.
    assert main(["send", str(root), "--stream", "general", "--text", "x" * 66_000]) == 1
    captured = capsys.readouterr()
    assert captured.err.startswith("msgctl:")
    assert "exceeds" in captured.err  # mentions the cap

    # Nothing appended: no month file was ever written.
    stream_dir = only_stream_dir(root)
    assert read_lines(stream_dir) == []

    # A following normal send gets sequence 1 — the rejection burned no sequence.
    assert main(["send", str(root), "--stream", "general", "--text", "small"]) == 0
    out = json.loads(capsys.readouterr().out.strip())
    assert out["server"]["server_sequence"] == 1
    assert_every_line_verifies(stream_dir)
