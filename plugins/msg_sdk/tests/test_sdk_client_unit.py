"""Unit tests for MsgClient's HTTP behaviour against a local stub server.

No real msgd here (that's the e2e) — a stdlib ``http.server`` records requests
and returns canned JSON, so these run fast and offline while still exercising the
real ``urllib`` path, the envelope the SDK puts on the wire, and error handling.
"""

from __future__ import annotations

import json
import re
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest
from msg_sdk import MsgClient, MsgHTTPError, MsgRejectedError, hash_event
from msg_sdk.client import _now_rfc3339

_WHOAMI = {
    "user_id": "u_01JZ7N6A4M6Y8W5K2H7DGKX4PD",
    "device_id": "d_01JZ7N6A4M6Y8W5K2H7DGKX4PE",
    "workspace_id": "w_01JZ7N6A4M6Y8W5K2H7DGKX4PB",
    "is_bot": True,
    "role": "guest",
}


class _Stub:
    """Captures requests and serves per-path canned responses."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.responses: dict[tuple[str, str], tuple[int, dict[str, Any]]] = {
            ("GET", "/v1/whoami"): (200, _WHOAMI),
        }


@pytest.fixture()
def server() -> Iterator[tuple[str, _Stub]]:
    stub = _Stub()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # silence stderr
            pass

        def _handle(self, method: str) -> None:
            path = self.path.split("?", 1)[0]
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b""
            stub.requests.append(
                {
                    "method": method,
                    "path": path,
                    "full_path": self.path,
                    "headers": dict(self.headers),
                    "body": json.loads(raw) if raw else None,
                }
            )
            status, payload = stub.responses.get((method, path), (404, {"title": "not found"}))
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            self._handle("GET")

        def do_POST(self) -> None:
            self._handle("POST")

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host = str(httpd.server_address[0])
    port = int(httpd.server_address[1])
    try:
        yield f"http://{host}:{port}", stub
    finally:
        httpd.shutdown()
        thread.join()


def test_now_rfc3339_shape() -> None:
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", _now_rfc3339())


def test_whoami_discovers_identity(server: tuple[str, _Stub]) -> None:
    base_url, _ = server
    client = MsgClient(base_url, "tok")
    ident = client.identity
    assert ident.user_id == _WHOAMI["user_id"]
    assert ident.device_id == _WHOAMI["device_id"]
    assert ident.workspace_id == _WHOAMI["workspace_id"]
    assert ident.is_bot is True


def test_post_message_wire_shape_and_hash(server: tuple[str, _Stub]) -> None:
    base_url, stub = server
    stub.responses[("POST", "/v1/events/batch")] = (
        200,
        {
            "accepted": [
                {
                    "event_id": "x",
                    "stream_id": "s_01JZ7N6A4M6Y8W5K2H7DGKX4PC",
                    "server_sequence": 17,
                    "server_received_at": "2026-07-04T12:00:00.123Z",
                }
            ],
            "rejected": [],
        },
    )
    client = MsgClient(base_url, "tok")
    msg = client.post_message("s_01JZ7N6A4M6Y8W5K2H7DGKX4PC", "hello", mentions=["u_x"])

    upload = next(r for r in stub.requests if r["path"] == "/v1/events/batch")
    assert upload["headers"]["Authorization"] == "Bearer tok"
    item = upload["body"]["events"][0]
    body = item["body"]
    # The nine required top-level fields, authored as the discovered identity.
    assert set(body) == {
        "event_id",
        "workspace_id",
        "stream_id",
        "type",
        "type_version",
        "author_user_id",
        "author_device_id",
        "client_created_at",
        "payload",
    }
    assert body["type"] == "message.created"
    assert body["type_version"] == 1
    assert body["author_user_id"] == _WHOAMI["user_id"]
    assert body["author_device_id"] == _WHOAMI["device_id"]
    assert body["workspace_id"] == _WHOAMI["workspace_id"]
    assert body["stream_id"] == "s_01JZ7N6A4M6Y8W5K2H7DGKX4PC"
    assert body["payload"]["text"] == "hello"
    assert body["payload"]["mentions"] == ["u_x"]
    assert body["payload"]["message_id"].startswith("m_")
    assert "_" not in body["event_id"]  # bare ULID
    # The event_hash the SDK put on the wire is an honest hash of the body.
    assert item["event_hash"] == hash_event(body)
    # The returned Message reflects the server acceptance.
    assert msg.server_sequence == 17
    assert msg.text == "hello"


def test_post_message_rejected_raises(server: tuple[str, _Stub]) -> None:
    base_url, stub = server
    stub.responses[("POST", "/v1/events/batch")] = (
        200,
        {
            "accepted": [],
            "rejected": [{"event_id": "e", "code": "permission_denied", "detail": "no grant"}],
        },
    )
    client = MsgClient(base_url, "tok")
    with pytest.raises(MsgRejectedError) as exc:
        client.post_message("s_01JZ7N6A4M6Y8W5K2H7DGKX4PC", "hi")
    assert exc.value.code == "permission_denied"
    assert "no grant" in exc.value.detail


def test_list_messages_filters_and_queries(server: tuple[str, _Stub]) -> None:
    base_url, stub = server
    stub.responses[("GET", "/v1/events")] = (
        200,
        {
            "events": [
                {
                    "body": {
                        "type": "message.created",
                        "stream_id": "s_c",
                        "payload": {"message_id": "m_1", "text": "one"},
                    },
                    "event_hash": "sha256:x",
                    "server": {"server_sequence": 1},
                },
                {"body": {"type": "channel.member_added", "payload": {}}, "server": {}},
            ],
            "has_more": False,
        },
    )
    client = MsgClient(base_url, "tok")
    messages = client.list_messages("s_c", after=5, limit=10)
    assert [m.text for m in messages] == ["one"]  # non-message event filtered out
    q = next(r for r in stub.requests if r["path"] == "/v1/events")["full_path"]
    assert "stream_id=s_c" in q and "after=5" in q and "limit=10" in q


def test_http_error_surfaces_problem_detail(server: tuple[str, _Stub]) -> None:
    base_url, stub = server
    stub.responses[("GET", "/v1/whoami")] = (
        401,
        {"type": "/problems/unauthorized", "title": "Unauthorized", "detail": "bad token"},
    )
    client = MsgClient(base_url, "tok")
    with pytest.raises(MsgHTTPError) as exc:
        client.whoami()
    assert exc.value.status == 401
    assert exc.value.detail == "bad token"
    assert exc.value.title == "Unauthorized"


def test_list_messages_rejects_both_cursors(server: tuple[str, _Stub]) -> None:
    base_url, _ = server
    client = MsgClient(base_url, "tok")
    with pytest.raises(ValueError):
        client.list_messages("s_c", after=1, before=2)


def test_post_webhook(server: tuple[str, _Stub]) -> None:
    base_url, stub = server
    stub.responses[("POST", "/v1/hooks/abc")] = (200, {"ok": True})
    MsgClient.post_webhook(f"{base_url}/v1/hooks/abc", "ping")
    hook = next(r for r in stub.requests if r["path"] == "/v1/hooks/abc")
    assert hook["body"] == {"text": "ping"}
    assert "Authorization" not in hook["headers"]  # URL is the credential


def test_ws_url_scheme() -> None:
    assert MsgClient("https://x.example", "t")._ws_url("/v1/ws") == "wss://x.example/v1/ws"
    assert MsgClient("http://x.example", "t")._ws_url("/v1/ws") == "ws://x.example/v1/ws"


def test_sdk_hash_matches_server_hasher() -> None:
    """The SDK's hash equals msgd's on a body the SDK builds (real ULIDs)."""
    msgd_hashing = pytest.importorskip("msgd.core.hashing")
    from msg_sdk import Identity

    client = MsgClient("http://unused", "tok")
    client._identity = Identity(  # skip the network whoami
        user_id="u_01JZ7N6A4M6Y8W5K2H7DGKX4PD",
        device_id="d_01JZ7N6A4M6Y8W5K2H7DGKX4PE",
        workspace_id="w_01JZ7N6A4M6Y8W5K2H7DGKX4PB",
        is_bot=True,
        role="guest",
    )
    body = client.build_message_body(
        "s_01JZ7N6A4M6Y8W5K2H7DGKX4PC", "cross-check", mentions=["u_a"]
    )
    assert hash_event(body) == msgd_hashing.hash_event(body)
