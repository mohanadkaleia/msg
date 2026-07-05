"""POST /v1/auth/login — argon2id verify, enumeration shape, rolling expiry."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest
from authutil import OWNER, auth_header, do_login, do_setup
from httpx import AsyncClient
from msgd.api.routers import auth as auth_router
from msgd.auth.sessions import utcnow
from msgd.auth.tokens import hash_token
from msgd.db.models import Session
from msgd.settings import Settings
from sqlalchemy.ext.asyncio import AsyncSession


async def test_login_success(client: AsyncClient) -> None:
    """Valid credentials return a token plus the principal fields."""
    await do_setup(client)
    resp = await do_login(client, email=OWNER["email"], password=OWNER["password"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["token"]
    assert body["role"] == "owner"
    assert body["device_id"].startswith("d_")


async def test_wrong_password_generic_401(client: AsyncClient) -> None:
    """A wrong password returns a generic 401 problem+json."""
    await do_setup(client)
    resp = await do_login(client, email=OWNER["email"], password="wrong-password-x")
    assert resp.status_code == 401
    assert resp.headers["content-type"] == "application/problem+json"
    assert resp.json()["type"] == "/problems/invalid-credentials"


async def test_unknown_email_identical_to_wrong_password(client: AsyncClient) -> None:
    """Unknown email and wrong password produce byte-identical 401 bodies (D2)."""
    await do_setup(client)
    wrong = await do_login(client, email=OWNER["email"], password="wrong-password-x")
    unknown = await do_login(client, email="nobody@example.com", password="wrong-password-x")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


async def test_unknown_email_runs_dummy_verify(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The unknown-email path burns a dummy argon2 verify (timing equalization)."""
    from msgd.auth.passwords import dummy_verify as original

    await do_setup(client)
    calls: list[str] = []

    async def _spy(settings: Settings, password: str) -> None:
        calls.append(password)
        await original(settings, password)

    monkeypatch.setattr(auth_router, "dummy_verify", _spy)
    resp = await do_login(client, email="ghost@example.com", password="whatever-1234")
    assert resp.status_code == 401
    assert calls == ["whatever-1234"]


async def test_deactivated_user_401(client: AsyncClient, db_session: AsyncSession) -> None:
    """A deactivated user cannot log in (uniform 401)."""
    from msgd.db.models import User

    body = await do_setup(client)
    user = await db_session.get(User, body["user_id"])
    assert user is not None
    user.deactivated_at = utcnow()
    await db_session.flush()

    resp = await do_login(client, email=OWNER["email"], password=OWNER["password"])
    assert resp.status_code == 401
    assert resp.json()["type"] == "/problems/invalid-credentials"


async def test_device_reuse_and_rejection(client: AsyncClient) -> None:
    """A known owned device is reused; an unknown device_id is rejected 400."""
    await do_setup(client)
    first = await do_login(client, email=OWNER["email"], password=OWNER["password"])
    device_id = first.json()["device_id"]

    # Reuse the same device on a second login → same device_id.
    reuse = await do_login(
        client, email=OWNER["email"], password=OWNER["password"], device_id=device_id
    )
    assert reuse.status_code == 200
    assert reuse.json()["device_id"] == device_id

    # An unknown device_id → 400 invalid-device (only reached after auth).
    bad = await do_login(
        client, email=OWNER["email"], password=OWNER["password"], device_id="d_unknown"
    )
    assert bad.status_code == 400
    assert bad.json()["type"] == "/problems/invalid-device"


async def _get_session(db: AsyncSession, token: str) -> Session:
    row = await db.get(Session, hash_token(token))
    assert row is not None
    return row


async def test_rolling_bump_advances_after_interval(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stale session (last_seen past the bump interval) rolls expiry on use."""
    body = await do_setup(client)
    token = body["token"]
    session = await _get_session(db_session, token)
    # Age last_seen_at 2h into the past (interval default is 1h) so the next
    # authed request triggers the throttled bump.
    session.last_seen_at = utcnow() - timedelta(hours=2)
    old_expiry = session.expires_at
    await db_session.flush()

    resp = await client.get("/v1/auth/sessions", headers=auth_header(token))
    assert resp.status_code == 200
    refreshed = await _get_session(db_session, token)
    assert refreshed.expires_at > old_expiry


async def test_rolling_bump_throttled_within_interval(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Within the bump interval the session row is left untouched (no write)."""
    body = await do_setup(client)
    token = body["token"]
    session = await _get_session(db_session, token)
    old_expiry = session.expires_at
    old_seen = session.last_seen_at

    resp = await client.get("/v1/auth/sessions", headers=auth_header(token))
    assert resp.status_code == 200
    refreshed = await _get_session(db_session, token)
    assert refreshed.expires_at == old_expiry
    assert refreshed.last_seen_at == old_seen


async def test_expired_session_401(client: AsyncClient, db_session: AsyncSession) -> None:
    """A session past its expiry is rejected 401."""
    body = await do_setup(client)
    token = body["token"]
    session = await _get_session(db_session, token)
    session.expires_at = utcnow() - timedelta(seconds=1)
    await db_session.flush()

    resp = await client.get("/v1/auth/sessions", headers=auth_header(token))
    assert resp.status_code == 401


def test_production_argon2_defaults() -> None:
    """The pinned production argon2id parameters are t=3 / 64 MiB / p=4 (D8).

    Pure unit test (no container): the harness weakens these for speed, so this
    asserts the class defaults never silently drift from the audited profile.
    """
    s = Settings(
        database_url="postgresql+asyncpg://u:p@localhost/db",
        data_dir=Path("/tmp"),
        secret_key="k",
    )
    assert s.argon2_time_cost == 3
    assert s.argon2_memory_cost_kib == 65536
    assert s.argon2_parallelism == 4
    assert s.password_min_length == 12
