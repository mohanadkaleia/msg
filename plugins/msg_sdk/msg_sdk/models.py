"""Lightweight return types for the SDK — plain, typed dataclasses."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

__all__ = ["Identity", "Message", "Event"]


@dataclass(frozen=True)
class Identity:
    """The authenticated caller's own identity (from ``GET /v1/whoami``)."""

    user_id: str
    device_id: str
    workspace_id: str
    is_bot: bool
    role: str


@dataclass(frozen=True)
class Message:
    """A ``message.created`` event, projected to the fields a bot usually wants.

    ``raw`` is the full serialized event (``{body, event_hash, signature,
    server}``) for anything not surfaced here.
    """

    message_id: str
    event_id: str
    channel_id: str
    text: str
    format: str
    author_user_id: str
    author_device_id: str
    client_created_at: str
    thread_root_id: str | None = None
    mentions: list[str] = field(default_factory=list)
    file_ids: list[str] = field(default_factory=list)
    server_sequence: int | None = None
    server_received_at: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_event(cls, event: dict[str, Any]) -> Message:
        """Build a :class:`Message` from a serialized ``message.created`` event."""
        body = event.get("body", {})
        payload = body.get("payload", {})
        server = event.get("server") or {}
        return cls(
            message_id=payload.get("message_id", ""),
            event_id=body.get("event_id", ""),
            channel_id=body.get("stream_id", ""),
            text=payload.get("text", ""),
            format=payload.get("format", ""),
            author_user_id=body.get("author_user_id", ""),
            author_device_id=body.get("author_device_id", ""),
            client_created_at=body.get("client_created_at", ""),
            thread_root_id=payload.get("thread_root_id"),
            mentions=list(payload.get("mentions", [])),
            file_ids=list(payload.get("file_ids", [])),
            server_sequence=server.get("server_sequence"),
            server_received_at=server.get("server_received_at"),
            raw=event,
        )


@dataclass(frozen=True)
class Event:
    """A live event from the WebSocket stream (``events()`` / ``listen()``).

    ``type``/``stream_id`` are lifted from ``body`` for convenient filtering;
    ``payload`` is the event-type-specific dict; ``raw`` is the whole serialized
    event. Unknown event types round-trip untouched — inspect ``type`` and skip
    what you do not handle (D9).
    """

    type: str
    stream_id: str
    event_id: str
    payload: dict[str, Any]
    body: dict[str, Any]
    event_hash: str
    server_sequence: int | None
    server_received_at: str | None
    raw: dict[str, Any]

    @classmethod
    def from_frame(cls, event: dict[str, Any]) -> Event:
        """Build an :class:`Event` from a serialized WS/pull event dict."""
        body = event.get("body", {})
        server = event.get("server") or {}
        return cls(
            type=body.get("type", ""),
            stream_id=body.get("stream_id", ""),
            event_id=body.get("event_id", ""),
            payload=body.get("payload", {}),
            body=body,
            event_hash=event.get("event_hash", ""),
            server_sequence=server.get("server_sequence"),
            server_received_at=server.get("server_received_at"),
            raw=event,
        )

    def as_message(self) -> Message:
        """View this event as a :class:`Message` (use when ``type`` is a message)."""
        return Message.from_event(self.raw)
