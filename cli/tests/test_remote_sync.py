"""Unit tests for the push/pull engines (ENG-70 §3/§4) against a fake in-memory server.

Drives :func:`msgctl.sync.push` / :func:`msgctl.sync.pull` through a real
:class:`msgctl.client.MsgClient` wired to an ``httpx.MockTransport`` that models
the server's sequencing + idempotency. Asserts the verbatim writer shape, month
partitioning, cursor resume, and idempotent push retry — no live server needed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
from msgctl import credentials, outbox, sync
from msgctl.client import MsgClient
from msgctl.workspace import Workspace, init_workspace
from msgd.core import ids
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body

WS_ID = ids.new_workspace_id()
USER_ID = ids.new_user_id()
DEVICE_ID = ids.new_device_id()
CHAN_ID = ids.new_stream_id()
META_ID = ids.new_stream_id()


def _ws(tmp_path: Path) -> Workspace:
    init_workspace(tmp_path / "ws")
    ws = Workspace.open(tmp_path / "ws")
    ws.workspace_id = WS_ID
    from msgctl.workspace import LocalAuthor

    ws.local_author = LocalAuthor(user_id=USER_ID, device_id=DEVICE_ID)
    ws.write_manifest()
    return Workspace.open(tmp_path / "ws")


def _server_event(stream_id: str, seq: int, received_at: str, text: str) -> dict[str, Any]:
    """A fully-formed served event dict: {body, event_hash, signature, server}."""
    body = build_message_created_body(
        workspace_id=WS_ID,
        stream_id=stream_id,
        author_user_id=USER_ID,
        author_device_id=DEVICE_ID,
        client_created_at="2026-07-04T00:00:00.000Z",
        text=text,
    ).model_dump(mode="json")
    return {
        "body": body,
        "event_hash": hash_event(body),
        "signature": None,
        "server": {
            "server_sequence": seq,
            "server_received_at": received_at,
            "payload_redacted": False,
        },
    }


class FakeServer:
    """A minimal stateful msg server for sync/pull/push over MockTransport."""

    def __init__(self) -> None:
        # stream_id -> {kind, name, events: [served event dicts ascending by seq]}
        self.streams: dict[str, dict[str, Any]] = {}
        self.accepted_event_ids: set[str] = set()
        self.fail_next_batch = 0  # emit N transient 503s before accepting

    def add_stream(self, stream_id: str, *, kind: str, name: str | None) -> None:
        self.streams[stream_id] = {"kind": kind, "name": name, "events": []}

    def add_event(self, stream_id: str, event: dict[str, Any]) -> None:
        self.streams[stream_id]["events"].append(event)
        self.accepted_event_ids.add(event["body"]["event_id"])

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/sync":
            return httpx.Response(
                200,
                json={
                    "streams": [
                        {
                            "stream_id": sid,
                            "kind": s["kind"],
                            "name": s["name"],
                            "visibility": "public" if s["kind"] == "channel" else None,
                            "head_seq": len(s["events"]),
                            "member": s["kind"] == "channel",
                        }
                        for sid, s in self.streams.items()
                    ]
                },
            )
        if path == "/v1/events":
            sid = request.url.params["stream_id"]
            after = int(request.url.params.get("after", "0"))
            limit = int(request.url.params.get("limit", "500"))
            evs = [e for e in self.streams[sid]["events"] if e["server"]["server_sequence"] > after]
            page = evs[:limit]
            return httpx.Response(200, json={"events": page, "has_more": len(evs) > limit})
        if path == "/v1/events/batch":
            if self.fail_next_batch > 0:
                self.fail_next_batch -= 1
                return httpx.Response(503, json={"detail": "unavailable"})
            payload = json.loads(request.content)
            accepted = []
            for item in payload["events"]:
                eid = item["body"]["event_id"]
                sid = item["body"]["stream_id"]
                is_new = eid not in self.accepted_event_ids
                if is_new:
                    seq = (
                        len(
                            self.streams.setdefault(
                                sid, {"kind": "channel", "name": sid, "events": []}
                            )["events"]
                        )
                        + 1
                    )
                    ev = {
                        "body": item["body"],
                        "event_hash": item["event_hash"],
                        "signature": None,
                        "server": {
                            "server_sequence": seq,
                            "server_received_at": "2026-07-04T00:00:00.000Z",
                            "payload_redacted": False,
                        },
                    }
                    self.add_event(sid, ev)
                accepted.append(
                    {
                        "event_id": eid,
                        "stream_id": sid,
                        "server_sequence": self._seq_of(sid, eid),
                        "server_received_at": "2026-07-04T00:00:00.000Z",
                    }
                )
            return httpx.Response(200, json={"accepted": accepted, "rejected": []})
        return httpx.Response(404, json={"detail": "no route"})

    def _seq_of(self, stream_id: str, event_id: str) -> int:
        for e in self.streams[stream_id]["events"]:
            if e["body"]["event_id"] == event_id:
                return int(e["server"]["server_sequence"])
        raise AssertionError("event not found")


def _client(server: FakeServer) -> MsgClient:
    return MsgClient("http://test", token="tok", transport=server.transport(), backoff_base=0.0)


# --- pull -------------------------------------------------------------------


def test_pull_writes_verbatim_compact_line(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    server = FakeServer()
    server.add_stream(CHAN_ID, kind="channel", name="general")
    ev = _server_event(CHAN_ID, 1, "2026-07-04T00:00:00.000Z", "hello")
    server.add_event(CHAN_ID, ev)

    with _client(server) as c:
        result = sync.pull(ws, c)

    assert result.events == 1
    month_file = ws.stream_dir(CHAN_ID) / "2026-07.ndjson"
    written = month_file.read_text(encoding="utf-8")
    expected = json.dumps(ev, ensure_ascii=False, separators=(",", ":")) + "\n"
    assert written == expected


def test_pull_month_partition_matches_received_at(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    server = FakeServer()
    sid = CHAN_ID
    server.add_stream(sid, kind="channel", name="general")
    server.add_event(sid, _server_event(sid, 1, "2026-07-31T23:59:59.000Z", "july"))
    server.add_event(sid, _server_event(sid, 2, "2026-08-01T00:00:00.000Z", "august"))

    with _client(server) as c:
        sync.pull(ws, c)

    assert (ws.stream_dir(sid) / "2026-07.ndjson").is_file()
    assert (ws.stream_dir(sid) / "2026-08.ndjson").is_file()


def test_pull_registers_streams_including_meta(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    server = FakeServer()
    server.add_stream(META_ID, kind="workspace-meta", name=None)
    server.add_event(
        META_ID,
        _server_event(META_ID, 1, "2026-07-04T00:00:00.000Z", "m"),
    )
    with _client(server) as c:
        sync.pull(ws, c)
    reopened = Workspace.open(ws.root)
    assert META_ID in reopened.streams
    assert reopened.streams[META_ID].name == credentials.META_STREAM_NAME


def test_pull_cursor_resume_no_double_append(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    server = FakeServer()
    sid = CHAN_ID
    server.add_stream(sid, kind="channel", name="general")
    server.add_event(sid, _server_event(sid, 1, "2026-07-04T00:00:00.000Z", "one"))

    with _client(server) as c:
        sync.pull(ws, c)
    # A second pull with no new server events must append nothing.
    with _client(server) as c:
        result2 = sync.pull(ws, c)
    assert result2.events == 0
    lines = (ws.stream_dir(sid) / "2026-07.ndjson").read_text().strip().split("\n")
    assert len(lines) == 1
    assert credentials.read_cursors(ws)[sid] == 1


def test_pull_advances_cursor_incrementally(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    server = FakeServer()
    sid = CHAN_ID
    server.add_stream(sid, kind="channel", name="general")
    server.add_event(sid, _server_event(sid, 1, "2026-07-04T00:00:00.000Z", "one"))
    with _client(server) as c:
        sync.pull(ws, c)
    # New event appears; second pull picks up only the new one.
    server.add_event(sid, _server_event(sid, 2, "2026-07-04T00:00:00.000Z", "two"))
    with _client(server) as c:
        result = sync.pull(ws, c)
    assert result.events == 1
    assert credentials.read_cursors(ws)[sid] == 2


# --- push -------------------------------------------------------------------


def _enqueue_msg(ws: Workspace, stream_id: str, text: str) -> str:
    body = build_message_created_body(
        workspace_id=WS_ID,
        stream_id=stream_id,
        author_user_id=USER_ID,
        author_device_id=DEVICE_ID,
        client_created_at="2026-07-04T00:00:00.000Z",
        text=text,
    ).model_dump(mode="json")
    outbox.enqueue(ws, body, hash_event(body))
    return str(body["event_id"])


def test_push_drains_accepted(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    server = FakeServer()
    sid = CHAN_ID
    server.add_stream(sid, kind="channel", name="general")
    _enqueue_msg(ws, sid, "a")
    _enqueue_msg(ws, sid, "b")

    with _client(server) as c:
        result = sync.push(ws, c)
    assert result.accepted == 2
    assert result.ok
    assert outbox.read_all(ws) == []
    assert len(server.streams[sid]["events"]) == 2


def test_push_idempotent_retry_no_duplicate(tmp_path: Path) -> None:
    """A transient 503 before accept → same batch re-sent → no server-side dup."""
    ws = _ws(tmp_path)
    server = FakeServer()
    sid = CHAN_ID
    server.add_stream(sid, kind="channel", name="general")
    _enqueue_msg(ws, sid, "a")
    server.fail_next_batch = 2  # two transient failures, then accept

    with _client(server) as c:
        result = sync.push(ws, c)
    assert result.accepted == 1
    assert len(server.streams[sid]["events"]) == 1  # exactly one, not three
    assert outbox.read_all(ws) == []


def test_push_re_push_already_accepted_is_idempotent(tmp_path: Path) -> None:
    """Re-seeding an already-accepted item and re-pushing yields no duplicate."""
    ws = _ws(tmp_path)
    server = FakeServer()
    sid = CHAN_ID
    server.add_stream(sid, kind="channel", name="general")
    eid = _enqueue_msg(ws, sid, "a")
    with _client(server) as c:
        sync.push(ws, c)
    # Manually re-seed the same event (simulating an interrupted drain).
    body = build_message_created_body(
        workspace_id=WS_ID,
        stream_id=sid,
        author_user_id=USER_ID,
        author_device_id=DEVICE_ID,
        client_created_at="2026-07-04T00:00:00.000Z",
        text="a",
        event_id=eid,
    ).model_dump(mode="json")
    outbox.enqueue(ws, body, hash_event(body))
    with _client(server) as c:
        result = sync.push(ws, c)
    assert result.accepted == 1  # re-accepted idempotently
    assert len(server.streams[sid]["events"]) == 1  # still one on the server
    assert outbox.read_all(ws) == []
