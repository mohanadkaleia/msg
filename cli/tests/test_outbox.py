"""Unit tests for the outbox (ENG-70 §3): FIFO, atomic append, torn-safe, remove."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from msgctl import outbox
from msgctl.errors import CorruptLogError
from msgctl.workspace import Workspace, init_workspace


def _ws(tmp_path: Path) -> Workspace:
    init_workspace(tmp_path / "ws")
    return Workspace.open(tmp_path / "ws")


def _body(event_id: str) -> dict[str, Any]:
    return {"event_id": event_id, "type": "message.created", "payload": {"text": "hi"}}


def test_enqueue_read_fifo(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    for i in range(3):
        outbox.enqueue(ws, _body(f"e{i}"), f"sha256:{i}")
    items = outbox.read_all(ws)
    assert [it.event_id for it in items] == ["e0", "e1", "e2"]
    assert items[0].event_hash == "sha256:0"
    assert items[0].body["payload"]["text"] == "hi"


def test_read_all_empty(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert outbox.read_all(ws) == []


def test_remove_preserves_order(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    for i in range(4):
        outbox.enqueue(ws, _body(f"e{i}"), f"sha256:{i}")
    removed = outbox.remove(ws, {"e1", "e3"})
    assert removed == 2
    assert [it.event_id for it in outbox.read_all(ws)] == ["e0", "e2"]


def test_remove_empty_set_is_noop(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    outbox.enqueue(ws, _body("e0"), "sha256:0")
    assert outbox.remove(ws, set()) == 0
    assert len(outbox.read_all(ws)) == 1


def test_remove_all_leaves_empty_outbox(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    outbox.enqueue(ws, _body("e0"), "sha256:0")
    outbox.enqueue(ws, _body("e1"), "sha256:1")
    outbox.remove(ws, {"e0", "e1"})
    assert outbox.read_all(ws) == []


def test_torn_trailing_line_ignored(tmp_path: Path) -> None:
    """A crashed partial append (no trailing newline) is skipped, not fatal."""
    ws = _ws(tmp_path)
    outbox.enqueue(ws, _body("e0"), "sha256:0")
    path = outbox.outbox_path(ws)
    with open(path, "ab") as fh:
        fh.write(b'{"body": {"event_id": "e1"')  # torn, no newline
    items = outbox.read_all(ws)
    assert [it.event_id for it in items] == ["e0"]


def test_corrupt_terminated_line_raises(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    path = outbox.outbox_path(ws)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_bytes(b"not json at all\n")
    with pytest.raises(CorruptLogError):
        outbox.read_all(ws)


def test_line_is_compact_wire_shape(tmp_path: Path) -> None:
    """The stored line must equal the batch wire item byte-for-byte."""
    ws = _ws(tmp_path)
    outbox.enqueue(ws, _body("e0"), "sha256:abc")
    line = outbox.read_all(ws)[0].line
    expected = (
        '{"body":{"event_id":"e0","type":"message.created",'
        '"payload":{"text":"hi"}},"event_hash":"sha256:abc"}'
    )
    assert line == expected
