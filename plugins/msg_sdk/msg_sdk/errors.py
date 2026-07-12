"""Typed errors raised by :class:`msg_sdk.MsgClient`."""

from __future__ import annotations

import json

__all__ = ["MsgError", "MsgHTTPError", "MsgRejectedError", "MsgConfigError"]


class MsgError(Exception):
    """Base class for every error the SDK raises."""


class MsgConfigError(MsgError):
    """The client is misconfigured (e.g. a missing optional dependency)."""


class MsgHTTPError(MsgError):
    """A msg API request returned a non-2xx status.

    Carries the HTTP ``status`` and, when the server sent an RFC 9457
    ``application/problem+json`` body, its parsed ``problem`` dict (with
    ``type`` / ``title`` / ``detail`` convenience attributes).
    """

    def __init__(self, status: int, body: bytes | str, *, url: str | None = None) -> None:
        self.status = status
        self.url = url
        self.raw_body = body.decode("utf-8", "replace") if isinstance(body, bytes) else body
        self.problem: dict[str, object] | None = None
        try:
            parsed = json.loads(self.raw_body)
            if isinstance(parsed, dict):
                self.problem = parsed
        except (ValueError, TypeError):
            self.problem = None
        detail = self._problem_str("detail") or self._problem_str("title") or self.raw_body
        where = f" for {url}" if url else ""
        super().__init__(f"msg API returned HTTP {status}{where}: {detail}".rstrip())

    def _problem_str(self, key: str) -> str | None:
        if self.problem is None:
            return None
        value = self.problem.get(key)
        return value if isinstance(value, str) else None

    @property
    def title(self) -> str | None:
        return self._problem_str("title")

    @property
    def detail(self) -> str | None:
        return self._problem_str("detail")

    @property
    def type(self) -> str | None:
        return self._problem_str("type")


class MsgRejectedError(MsgError):
    """The batch endpoint accepted the request (200) but rejected the event.

    ``POST /v1/events/batch`` always returns 200 for a well-formed request and
    partitions events into ``accepted`` / ``rejected``; a single-event upload
    that lands in ``rejected`` (e.g. ``permission_denied`` when the bot lacks a
    channel grant, or ``hash_mismatch``) surfaces here with the server's
    ``code`` and ``detail``.
    """

    def __init__(self, code: str, detail: str, *, event_id: str | None = None) -> None:
        self.code = code
        self.detail = detail
        self.event_id = event_id
        super().__init__(f"event rejected ({code}): {detail}")
