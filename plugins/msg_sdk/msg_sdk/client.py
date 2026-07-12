"""``MsgClient`` — a tiny, correctness-first bot client for the msg API.

One import, one call to post a message: the client builds the ``message.created``
envelope, mints the ids, computes the frozen ``event_hash`` (``sha256`` over the
RFC 8785 canonicalization of the body — see :mod:`msg_sdk.hashing`), and uploads
it, so a bot author never touches hashing. It talks only to the public plugin
surface documented in ``docs/plugins.md`` and imports nothing from ``msgd``.

HTTP uses the standard library (``urllib``); the live event stream
(:meth:`MsgClient.events`) needs the ``websockets`` package, pulled in by the
optional ``ws`` extra (``pip install "msg-sdk[ws]"``) to keep the base install
dependency-light.
"""

from __future__ import annotations

import contextlib
import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from msg_sdk import ids
from msg_sdk.errors import MsgConfigError, MsgHTTPError, MsgRejectedError
from msg_sdk.hashing import hash_event
from msg_sdk.models import Event, Identity, Message

__all__ = ["MsgClient"]

_MAX_LIMIT = 500


def _now_rfc3339() -> str:
    """UTC now as ``YYYY-MM-DDTHH:MM:SS.mmmZ`` — the form the server emits."""
    now = datetime.now(UTC)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


class MsgClient:
    """A bot client for a single msg workspace, authenticated by a bot token.

    Args:
        base_url: The msg server root, e.g. ``https://msg.example.com``.
        token: A bot token (or any bearer credential). Sent as
            ``Authorization: Bearer <token>`` on HTTP and via
            ``Sec-WebSocket-Protocol: bearer, <token>`` on the WebSocket.
        timeout: Per-request timeout in seconds (default 30).

    On first use the client calls ``GET /v1/whoami`` to discover its own
    ``user_id`` / ``device_id`` / ``workspace_id`` (the server validates author
    binding against the credential on every upload). Access :attr:`identity` to
    trigger it eagerly.
    """

    def __init__(self, base_url: str, token: str, *, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token
        self.timeout = timeout
        self._identity: Identity | None = None

    # -- identity -------------------------------------------------------------

    @property
    def identity(self) -> Identity:
        """The caller's own identity, discovered lazily via ``GET /v1/whoami``."""
        if self._identity is None:
            self._identity = self.whoami()
        return self._identity

    def whoami(self) -> Identity:
        """Fetch (and cache) the caller's identity from ``GET /v1/whoami``."""
        data = self._request("GET", "/v1/whoami")
        self._identity = Identity(
            user_id=data["user_id"],
            device_id=data["device_id"],
            workspace_id=data["workspace_id"],
            is_bot=bool(data.get("is_bot", False)),
            role=data.get("role", ""),
        )
        return self._identity

    # -- writing --------------------------------------------------------------

    def post_message(
        self,
        channel_id: str,
        text: str,
        *,
        format: str = "markdown",
        thread_root_id: str | None = None,
        file_ids: list[str] | None = None,
        mentions: list[str] | None = None,
    ) -> Message:
        """Post a ``message.created`` message to ``channel_id`` and return it.

        Builds the envelope, mints ``event_id`` / ``message_id``, computes the
        ``event_hash`` the server will re-verify, and uploads via
        ``POST /v1/events/batch``. Requires the ``events:write`` scope and a
        membership grant on ``channel_id``.

        Raises:
            MsgRejectedError: the server rejected the event (e.g.
                ``permission_denied`` for a missing channel grant).
            MsgHTTPError: the request itself failed (non-2xx).
        """
        me = self.identity
        body = self.build_message_body(
            channel_id,
            text,
            format=format,
            thread_root_id=thread_root_id,
            file_ids=file_ids,
            mentions=mentions,
        )
        accepted = self.post_event(body)
        message = Message.from_event({"body": body})
        return Message(
            message_id=message.message_id,
            event_id=message.event_id,
            channel_id=channel_id,
            text=text,
            format=format,
            author_user_id=me.user_id,
            author_device_id=me.device_id,
            client_created_at=body["client_created_at"],
            thread_root_id=thread_root_id,
            mentions=list(mentions or []),
            file_ids=list(file_ids or []),
            server_sequence=accepted.get("server_sequence"),
            server_received_at=accepted.get("server_received_at"),
            raw={"body": body},
        )

    def build_message_body(
        self,
        channel_id: str,
        text: str,
        *,
        format: str = "markdown",
        thread_root_id: str | None = None,
        file_ids: list[str] | None = None,
        mentions: list[str] | None = None,
    ) -> dict[str, Any]:
        """Assemble a ``message.created`` body authored by this client.

        Exposed for callers that want the raw body (e.g. to inspect the hash via
        :func:`msg_sdk.hash_event` or to batch several events with
        :meth:`post_event`).
        """
        me = self.identity
        return {
            "event_id": ids.new_event_id(),
            "workspace_id": me.workspace_id,
            "stream_id": channel_id,
            "type": "message.created",
            "type_version": 1,
            "author_user_id": me.user_id,
            "author_device_id": me.device_id,
            "client_created_at": _now_rfc3339(),
            "payload": {
                "message_id": ids.new_message_id(),
                "text": text,
                "format": format,
                "thread_root_id": thread_root_id,
                "file_ids": list(file_ids or []),
                "mentions": list(mentions or []),
            },
        }

    def post_event(self, body: dict[str, Any]) -> dict[str, Any]:
        """Upload a single pre-built event ``body``; return its acceptance record.

        Low-level escape hatch beneath :meth:`post_message`: computes the
        ``event_hash`` over ``body`` and POSTs the ``{body, event_hash}`` item to
        ``POST /v1/events/batch``. Returns the server's ``accepted`` entry
        (``{event_id, stream_id, server_sequence, server_received_at}``).

        Raises:
            MsgRejectedError: if the event landed in the ``rejected`` partition.
        """
        item = {"body": body, "event_hash": hash_event(body)}
        result = self._request("POST", "/v1/events/batch", json_body={"events": [item]})
        rejected = result.get("rejected") or []
        if rejected:
            first = rejected[0]
            raise MsgRejectedError(
                first.get("code", "unknown"),
                first.get("detail", ""),
                event_id=first.get("event_id"),
            )
        accepted = result.get("accepted") or []
        return accepted[0] if accepted else {}

    # -- reading --------------------------------------------------------------

    def list_messages(
        self,
        channel_id: str,
        *,
        limit: int = 100,
        after: int | None = None,
        before: int | None = None,
    ) -> list[Message]:
        """Read ``message.created`` history for ``channel_id`` (needs ``events:read``).

        Pulls ``GET /v1/events`` and keeps only ``message.created`` events.
        ``after`` / ``before`` are ``server_sequence`` cursors (exclusive,
        mutually exclusive); ``limit`` is clamped to ``[1, 500]``. Non-message
        events in the range are skipped, so fewer than ``limit`` messages may be
        returned even when more history exists.
        """
        events = self.list_events(channel_id, limit=limit, after=after, before=before)
        return [
            Message.from_event(event)
            for event in events
            if event.get("body", {}).get("type") == "message.created"
        ]

    def list_events(
        self,
        channel_id: str,
        *,
        limit: int = 100,
        after: int | None = None,
        before: int | None = None,
    ) -> list[dict[str, Any]]:
        """Pull raw serialized events for ``channel_id`` via ``GET /v1/events``."""
        if after is not None and before is not None:
            raise ValueError("pass at most one of `after` / `before`")
        query: dict[str, Any] = {
            "stream_id": channel_id,
            "limit": max(1, min(limit, _MAX_LIMIT)),
        }
        if after is not None:
            query["after"] = after
        if before is not None:
            query["before"] = before
        data = self._request("GET", "/v1/events", query=query)
        events = data.get("events") or []
        return [event for event in events if isinstance(event, dict)]

    # -- live stream ----------------------------------------------------------

    def events(
        self, channels: list[str] | None = None, *, open_timeout: float = 10.0
    ) -> Iterator[Event]:
        """Yield live events over ``GET /v1/ws`` (needs ``events:read``).

        A blocking generator: it opens the WebSocket (bearer token in the
        subprotocol, per ``docs/plugins.md``), answers the server's heartbeat
        ``ping`` frames, and yields one :class:`Event` per ``{"t":"event"}``
        frame. If ``channels`` is given, only events whose ``stream_id`` is in it
        are yielded. Ephemeral signal frames (``read_state`` / ``prefs`` /
        ``presence`` / ``typing``) are skipped. Stop by breaking out of the loop
        or closing the generator — the socket is closed on exit.

        Requires the ``websockets`` package (``pip install "msg-sdk[ws]"``).
        """
        try:
            from websockets import Subprotocol
            from websockets.sync.client import connect
        except ImportError as exc:  # pragma: no cover - exercised via error path
            raise MsgConfigError(
                "live events() need the 'websockets' package; "
                'install the SDK with the ws extra: pip install "msg-sdk[ws]"'
            ) from exc

        wanted = set(channels) if channels else None
        ws_url = self._ws_url("/v1/ws")
        # Bearer token in the subprotocol list, per docs/plugins.md — the server
        # reads it from Sec-WebSocket-Protocol and echoes "bearer" on accept.
        subprotocols = [Subprotocol("bearer"), Subprotocol(self._token)]
        with connect(ws_url, subprotocols=subprotocols, open_timeout=open_timeout) as socket:
            while True:
                try:
                    raw = socket.recv()
                except Exception:  # ConnectionClosed and friends: stream ended
                    return
                frame = self._decode_frame(raw)
                if frame is None:
                    continue
                kind = frame.get("t")
                if kind == "ping":
                    with contextlib.suppress(Exception):
                        socket.send(json.dumps({"t": "pong"}))
                    continue
                if kind != "event":
                    continue
                event = frame.get("event")
                if not isinstance(event, dict):
                    continue
                if wanted is not None and event.get("body", {}).get("stream_id") not in wanted:
                    continue
                yield Event.from_frame(event)

    #: Alias for :meth:`events` — read as "listen for events".
    listen = events

    @staticmethod
    def _decode_frame(raw: str | bytes) -> dict[str, Any] | None:
        if isinstance(raw, bytes):
            return None  # the server speaks JSON text frames only
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return None
        return parsed if isinstance(parsed, dict) else None

    def _ws_url(self, path: str) -> str:
        if self.base_url.startswith("https://"):
            return "wss://" + self.base_url[len("https://") :] + path
        if self.base_url.startswith("http://"):
            return "ws://" + self.base_url[len("http://") :] + path
        return self.base_url + path

    # -- incoming webhook (surface 1) ----------------------------------------

    @staticmethod
    def post_webhook(hook_url: str, text: str, *, timeout: float = 30.0) -> None:
        """POST ``{"text": text}`` to an incoming-webhook capability URL.

        The trivial one-way notifier path (``docs/plugins.md`` §1): no auth
        header, the URL itself is the credential. Raises :class:`MsgHTTPError`
        on a non-2xx response.
        """
        payload = json.dumps({"text": text}).encode("utf-8")
        request = urllib.request.Request(
            hook_url, data=payload, method="POST", headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout):
                return
        except urllib.error.HTTPError as exc:
            raise MsgHTTPError(exc.code, exc.read(), url=hook_url) from exc

    # -- HTTP plumbing --------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(json_body).encode("utf-8") if json_body is not None else None
        headers = {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            raise MsgHTTPError(exc.code, exc.read(), url=url) from exc
        if not raw:
            return {}
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
