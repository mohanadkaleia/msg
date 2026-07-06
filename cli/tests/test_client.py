"""Unit tests for :class:`msgctl.client.MsgClient` against ``httpx.MockTransport``.

Covers bearer-header injection, retry-on-transient (5xx/429), no-retry-on-4xx,
problem+json → typed error mapping, and the security invariant that the raw token
never appears in an error message.
"""

from __future__ import annotations

import httpx
import pytest
from msgctl.client import AuthError, MsgClient, NotFoundError, RemoteError, TransientError

_TOKEN = "sk_secret_bearer_do_not_leak"


def _client(handler: httpx.MockTransport, *, token: str | None = _TOKEN) -> MsgClient:
    return MsgClient(
        "http://test",
        token=token,
        transport=handler,
        backoff_base=0.0,  # instant retries in tests
        max_retries=4,
    )


def test_bearer_header_on_authed_call() -> None:
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("authorization"))
        return httpx.Response(200, json={"streams": []})

    with _client(httpx.MockTransport(handler)) as c:
        c.get_sync()
    assert seen == [f"Bearer {_TOKEN}"]


def test_no_bearer_on_unauthed_call() -> None:
    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("authorization"))
        return httpx.Response(200, json={"token": "t", "user_id": "u_1"})

    with _client(httpx.MockTransport(handler), token=None) as c:
        c.setup(workspace_name="W", email="a@b.com", password="x" * 12, display_name="A")
    assert seen == [None]


def test_retry_on_5xx_then_success() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(503, json={"detail": "unavailable"})
        return httpx.Response(200, json={"accepted": [], "rejected": []})

    with _client(httpx.MockTransport(handler)) as c:
        resp = c.post_batch([])
    assert calls["n"] == 3
    assert resp == {"accepted": [], "rejected": []}


def test_retry_on_429() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 2:
            return httpx.Response(429, json={"detail": "slow down"})
        return httpx.Response(200, json={"streams": []})

    with _client(httpx.MockTransport(handler)) as c:
        c.get_sync()
    assert calls["n"] == 2


def test_transient_exhausted_raises_transient_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"detail": "boom"})

    with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(TransientError):
            c.get_sync()


def test_no_retry_on_4xx() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(422, json={"detail": "bad"})

    with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(RemoteError):
            c.get_sync()
    assert calls["n"] == 1  # permanent — exactly one attempt


def test_401_maps_to_auth_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "invalid token"})

    with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(AuthError):
            c.get_sync()


def test_404_maps_to_not_found() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "not found"})

    with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(NotFoundError):
            c.get_events(stream_id="s_x", after=0, limit=500)


def test_token_never_in_error_message() -> None:
    """A 401 carrying the token in headers must not surface the token in the error."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "invalid"})

    with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(RemoteError) as exc_info:
            c.get_sync()
    assert _TOKEN not in str(exc_info.value)


def test_transport_error_retried_then_raised() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("connection refused")

    with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(TransientError):
            c.get_sync()
    assert calls["n"] == 5  # max_retries(4) + 1 initial attempt


def test_get_events_sends_query_params() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"events": [], "has_more": False})

    with _client(httpx.MockTransport(handler)) as c:
        c.get_events(stream_id="s_abc", after=7, limit=500)
    assert seen == {"stream_id": "s_abc", "after": "7", "limit": "500"}
