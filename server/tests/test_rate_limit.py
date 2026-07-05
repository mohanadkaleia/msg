"""Auth rate limiting — per-IP and per-email 10/min, 429 + Retry-After (D6).

Uses an injected clock so windows advance without sleeping.
"""

from __future__ import annotations

from authutil import do_login, make_app, make_client
from fastapi import FastAPI
from msgd.auth.ratelimit import RateLimiter
from msgd.settings import Settings
from sqlalchemy.ext.asyncio import AsyncSession


class Clock:
    """A manually-advanced monotonic clock for the limiter."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _install(app: FastAPI, clock: Clock, limit: int = 10) -> None:
    app.state.auth_limiter = RateLimiter(limit, 60, now=clock)


async def test_per_ip_limit_and_retry_after(settings: Settings, db_session: AsyncSession) -> None:
    """From one IP: 10 attempts allowed, the 11th → 429 with Retry-After."""
    clock = Clock()
    app = make_app(settings, db_session, configure=lambda a: _install(a, clock))
    async with make_client(app) as client:
        for i in range(10):
            # Vary the email so only the shared per-IP bucket accumulates.
            resp = await do_login(client, email=f"u{i}@example.com", password="pw-abcdefghij")
            assert resp.status_code == 401, resp.text
        resp = await do_login(client, email="u10@example.com", password="pw-abcdefghij")
        assert resp.status_code == 429
        assert resp.json()["type"] == "/problems/rate-limited"
        retry_after = int(resp.headers["retry-after"])
        assert retry_after > 0


async def test_per_email_limit_across_ips(settings: Settings, db_session: AsyncSession) -> None:
    """Same email from many distinct IPs still trips the per-email bucket."""
    # trust_proxy on → each request's X-Forwarded-For is its client IP, so the
    # per-IP bucket never accumulates and only the per-email bucket can trip.
    proxy_settings = settings.model_copy(update={"trust_proxy": True})
    clock = Clock()
    app = make_app(proxy_settings, db_session, configure=lambda a: _install(a, clock))

    async with make_client(app) as client:
        for i in range(10):
            resp = await client.post(
                "/v1/auth/login",
                json={
                    "email": "victim@example.com",
                    "password": "pw-abcdefghij",
                    "device_label": "d",
                },
                headers={"X-Forwarded-For": f"10.0.0.{i}"},
            )
            assert resp.status_code == 401, resp.text
        resp = await client.post(
            "/v1/auth/login",
            json={
                "email": "victim@example.com",
                "password": "pw-abcdefghij",
                "device_label": "d",
            },
            headers={"X-Forwarded-For": "10.0.0.250"},
        )
        assert resp.status_code == 429


async def test_window_advance_resets(settings: Settings, db_session: AsyncSession) -> None:
    """Advancing the clock past the window lets a blocked caller through again."""
    clock = Clock()
    app = make_app(settings, db_session, configure=lambda a: _install(a, clock))
    async with make_client(app) as client:
        for _ in range(10):
            await do_login(client, email="same@example.com", password="pw-abcdefghij")
        blocked = await do_login(client, email="same@example.com", password="pw-abcdefghij")
        assert blocked.status_code == 429

        clock.now += 61  # advance past the 60s window
        allowed = await do_login(client, email="same@example.com", password="pw-abcdefghij")
        assert allowed.status_code == 401  # limiter reset → back to normal auth path


def test_evicts_elapsed_buckets() -> None:
    """Elapsed windows are swept, bounding memory to ~one window of keys.

    Pure unit test (no container): fill distinct buckets, advance the injected
    clock past the window, and confirm the next check drops all stale entries.
    """
    clock = Clock()
    limiter = RateLimiter(10, 60, now=clock)
    for i in range(50):
        limiter.check(f"ip:10.0.0.{i}")
    assert limiter.bucket_count == 50

    clock.now += 61  # every window has ended; the next check triggers the sweep
    limiter.check("ip:fresh")
    assert limiter.bucket_count == 1  # only the fresh bucket survives


def test_eviction_keeps_live_buckets() -> None:
    """The sweep drops only elapsed windows; an active bucket keeps its count."""
    clock = Clock()
    limiter = RateLimiter(10, 60, now=clock)
    limiter.check("old")  # window [1000, 1060)
    clock.now += 45
    limiter.check("young")  # window [1045, 1105)
    clock.now += 20  # now=1065: "old" elapsed, "young" still live

    limiter.check("young")
    assert limiter.bucket_count == 1  # "old" swept, "young" retained
    # "young" kept its count across the sweep: 2 hits so far, 8 more allowed.
    for _ in range(8):
        assert limiter.check("young").allowed
    assert not limiter.check("young").allowed
