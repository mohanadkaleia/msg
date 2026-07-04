"""Scan integrity: terminated corruption is a hard error; unknown types survive.

Pins the two Ruling 3 behaviors the initial suite missed (review round 1, F2/F3):

- a *terminated* line that fails to parse — bad JSON or valid-JSON-but-not-an-
  Envelope — is corruption our writer never emits: exit 1, clean ``msgctl:``
  stderr (no traceback), file untouched (never silently skipped, never truncated);
- a terminated line of an *unknown event type* is a real accepted event (D9):
  counted toward the sequence and preserved byte-identical.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import assert_every_line_verifies, only_stream_dir, read_lines, run_cli
from msgd.core import ids
from msgd.core.hashing import hash_event


def _init_and_send_one(root: Path) -> Path:
    """init + one good send; return the single month file."""
    assert run_cli("init", str(root)).returncode == 0
    proc = run_cli("send", str(root), "--stream", "general", "--text", "good")
    assert proc.returncode == 0, proc.stderr
    (month_file,) = list(only_stream_dir(root).glob("*.ndjson"))
    return month_file


@pytest.mark.parametrize(
    "bad_line",
    [
        pytest.param(b"this is not json\n", id="bad-json"),
        pytest.param(b'{"not": "an envelope"}\n', id="valid-json-bad-envelope"),
    ],
)
def test_corrupt_terminated_line_is_hard_error(tmp_path: Path, bad_line: bytes) -> None:
    root = tmp_path / "ws"
    month_file = _init_and_send_one(root)

    # A *terminated* garbage line (trailing \n — must NOT be treated as torn).
    with open(month_file, "ab") as fh:
        fh.write(bad_line)
    before = month_file.read_bytes()

    proc = run_cli("send", str(root), "--stream", "general", "--text", "after corruption")
    assert proc.returncode == 1
    assert proc.stderr.startswith("msgctl:")  # clean error, no traceback
    assert "Traceback" not in proc.stderr
    # Nothing appended, nothing truncated: the file is byte-identical.
    assert month_file.read_bytes() == before


def test_unknown_event_type_is_preserved_and_counted(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    month_file = _init_and_send_one(root)
    first = json.loads(read_lines(only_stream_dir(root))[0])

    # Hand-craft a terminated line of an unknown type at sequence 2 (D9: the
    # scan must count and preserve it, not choke — M0 only *sends* message.created).
    body = {
        "event_id": ids.new_event_id(),
        "workspace_id": first["body"]["workspace_id"],
        "stream_id": first["body"]["stream_id"],
        "type": "widget.exploded",
        "type_version": 7,
        "author_user_id": first["body"]["author_user_id"],
        "author_device_id": first["body"]["author_device_id"],
        "client_created_at": "2026-07-04T12:00:00.000Z",
        "payload": {"blast_radius": 3, "shards": ["a", "b"]},
    }
    unknown_envelope = {
        "body": body,
        "event_hash": hash_event(body),
        "signature": None,
        "server": {
            "server_sequence": 2,
            "server_received_at": first["server"]["server_received_at"],
            "payload_redacted": False,
        },
    }
    unknown_line = json.dumps(unknown_envelope, ensure_ascii=False, separators=(",", ":"))
    with open(month_file, "ab") as fh:
        fh.write((unknown_line + "\n").encode("utf-8"))

    # The next send counts the unknown event: it gets sequence 3, not 2.
    proc = run_cli("send", str(root), "--stream", "general", "--text", "after unknown")
    assert proc.returncode == 0, proc.stderr
    assert json.loads(proc.stdout)["server"]["server_sequence"] == 3

    lines = read_lines(only_stream_dir(root))
    assert len(lines) == 3
    # Preserved byte-identical (D9), and every line — unknown included — verifies.
    assert lines[1] == unknown_line
    assert_every_line_verifies(only_stream_dir(root))
