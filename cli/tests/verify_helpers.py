"""Fixture + file-manipulation helpers for the ``msgctl verify`` suite.

The discipline (§6): build the log with REAL ``msgctl`` sends via subprocess, then craft
each corruption by direct byte/line manipulation of the produced month file — so verify
is proven against genuinely-produced logs, not hand-built straw men.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from conftest import run_cli
from msgd.core import ids
from msgd.core.hashing import hash_event


def init_ws(root: Path, name: str = "test-ws") -> None:
    """``msgctl init`` a fresh workspace at ``root`` (asserts success)."""
    proc = run_cli("init", str(root), "--name", name)
    assert proc.returncode == 0, proc.stderr


def send(root: Path, stream: str, text: str, **flags: str) -> dict[str, Any]:
    """``msgctl send`` one message; return the stored envelope dict (asserts success)."""
    args = ["send", str(root), "--stream", stream, "--text", text]
    for key, value in flags.items():
        args += [f"--{key.replace('_', '-')}", value]
    proc = run_cli(*args)
    assert proc.returncode == 0, proc.stderr
    result: dict[str, Any] = json.loads(proc.stdout.splitlines()[0])
    return result


def stream_dirs(root: Path) -> list[Path]:
    return sorted(p for p in (root / "streams").iterdir() if p.is_dir())


def month_file(stream_dir: Path) -> Path:
    """The single month file of a stream (tests send within one month)."""
    files = sorted(stream_dir.glob("*.ndjson"))
    assert len(files) == 1, f"expected one month file, found {files}"
    return files[0]


def read_raw_lines(path: Path) -> list[str]:
    """Terminated lines of a month file, newline stripped (no trailing empty)."""
    return [line for line in path.read_text(encoding="utf-8").split("\n") if line]


def write_lines(path: Path, lines: list[str]) -> None:
    """Overwrite a month file with ``lines`` (each newline-terminated)."""
    path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")


def rehash(obj: dict[str, Any]) -> str:
    """The correct raw ``event_hash`` for ``obj``'s body (mirrors production)."""
    return hash_event(obj["body"])


def make_envelope_line(
    *,
    workspace_id: str,
    stream_id: str,
    server_sequence: int,
    type: str = "message.created",
    type_version: int = 1,
    payload: dict[str, Any] | None = None,
    event_id: str | None = None,
    event_hash: str | None = None,
) -> str:
    """Hand-build one stored envelope line with a CORRECT raw hash (unless overridden).

    Used for the unknown-type / schema-invalid cases where we need a specific ``type`` or
    a deliberately-bad payload but an otherwise-faithful line.
    """
    body: dict[str, Any] = {
        "event_id": event_id or ids.new_event_id(),
        "workspace_id": workspace_id,
        "stream_id": stream_id,
        "type": type,
        "type_version": type_version,
        "author_user_id": ids.new_user_id(),
        "author_device_id": ids.new_device_id(),
        "client_created_at": "2026-07-04T00:00:00.000Z",
        "payload": payload if payload is not None else {},
    }
    obj: dict[str, Any] = {
        "body": body,
        "event_hash": event_hash if event_hash is not None else hash_event(body),
        "signature": None,
        "server": {
            "server_sequence": server_sequence,
            "server_received_at": "2026-07-04T00:00:00.000Z",
            "payload_redacted": False,
        },
    }
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
