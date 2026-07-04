"""Shared test helpers for the ``msgctl`` CLI suite."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from msgd.core.envelope import Envelope
from msgd.core.hashing import verify_hash


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    """Invoke ``msgctl`` as a real subprocess (real process boundary + flock).

    Restart / concurrency behavior only holds across process boundaries, so those
    tests must not call ``main`` in-process.
    """
    return subprocess.run(
        [sys.executable, "-m", "msgctl.cli", *args],
        capture_output=True,
        text=True,
    )


def read_lines(stream_dir: Path) -> list[str]:
    """All stored NDJSON lines across a stream's month files, in order."""
    lines: list[str] = []
    for path in sorted(stream_dir.glob("*.ndjson")):
        lines.extend(line for line in path.read_text(encoding="utf-8").split("\n") if line)
    return lines


def parse_envelopes(stream_dir: Path) -> list[Envelope]:
    """Every stored line parsed back through the :class:`Envelope` model."""
    return [Envelope.model_validate(json.loads(line)) for line in read_lines(stream_dir)]


def assert_every_line_verifies(stream_dir: Path) -> list[Envelope]:
    """Assert ``verify_hash`` is green for every stored line; return the envelopes.

    This is the headline hash acceptance criterion, reused by every test that
    produces sends.
    """
    envelopes = parse_envelopes(stream_dir)
    for env in envelopes:
        assert verify_hash(env) is True
    return envelopes


def only_stream_dir(workspace: Path) -> Path:
    """The single stream directory under ``<workspace>/streams`` (test convenience)."""
    stream_dirs = [p for p in (workspace / "streams").iterdir() if p.is_dir()]
    assert len(stream_dirs) == 1, f"expected exactly one stream, found {stream_dirs}"
    return stream_dirs[0]
