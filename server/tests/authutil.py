"""Typed helpers shared by the ENG-64 auth tests.

Keeps request round-trips (setup, login, header building) and custom-app
construction in one type-checked place so the test modules stay declarative.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from typing import Any

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from msgd.api.app import create_app
from msgd.db.engine import get_session
from msgd.settings import Settings
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# A valid owner payload (password ≥ 12 chars, no composition rules).
OWNER = {
    "workspace_name": "Acme",
    "email": "owner@example.com",
    "password": "correct-horse-battery-staple",
    "display_name": "The Owner",
}


def auth_header(token: str) -> dict[str, str]:
    """Bearer authorization header for ``token``."""
    return {"Authorization": f"Bearer {token}"}


async def do_setup(client: AsyncClient, **overrides: Any) -> dict[str, Any]:
    """POST /v1/setup with the default owner payload; return the JSON body."""
    payload = {**OWNER, **overrides}
    resp = await client.post("/v1/setup", json=payload)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


async def do_login(
    client: AsyncClient,
    *,
    email: str,
    password: str,
    device_label: str = "Test Device",
    device_id: str | None = None,
) -> Any:
    """POST /v1/auth/login; return the httpx response (caller asserts status)."""
    payload: dict[str, Any] = {
        "email": email,
        "password": password,
        "device_label": device_label,
    }
    if device_id is not None:
        payload["device_id"] = device_id
    return await client.post("/v1/auth/login", json=payload)


async def create_invite(
    client: AsyncClient,
    token: str,
    *,
    role: str = "member",
    ttl_seconds: int | None = None,
) -> Any:
    """POST /v1/admin/invites as the bearer of ``token``; return the response."""
    payload: dict[str, Any] = {"role": role}
    if ttl_seconds is not None:
        payload["ttl_seconds"] = ttl_seconds
    return await client.post("/v1/admin/invites", json=payload, headers=auth_header(token))


def join_token(url: str) -> str:
    """Extract the raw invite token from a ``.../join/<token>`` URL."""
    return url.rsplit("/join/", 1)[1]


async def accept_invite(
    client: AsyncClient,
    raw_token: str,
    *,
    email: str,
    display_name: str = "Invited User",
    password: str = "another-valid-password",
) -> Any:
    """POST /v1/auth/accept-invite; return the response."""
    return await client.post(
        "/v1/auth/accept-invite",
        json={
            "token": raw_token,
            "email": email,
            "display_name": display_name,
            "password": password,
        },
    )


def make_app(
    settings: Settings,
    db_session: AsyncSession,
    *,
    configure: Callable[[FastAPI], None] | None = None,
) -> FastAPI:
    """Build an app bound to the rolled-back ``db_session`` (as the harness does).

    ``configure`` runs after construction — used to swap the auth limiter for a
    clock-controlled one, or to mount a throwaway probe router.
    """
    app = create_app(settings)

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    if configure is not None:
        configure(app)
    return app


def make_client(app: FastAPI) -> AsyncClient:
    """Wrap ``app`` in an in-process ASGI client (caller uses ``async with``)."""
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# --- committing fixtures (true-concurrency tests only) -------------------------

AUTH_TABLES = "sessions, devices, invites, users, workspaces"


def committing_app(settings: Settings) -> tuple[AsyncClient, AsyncEngine]:
    """An app whose ``get_session`` yields real, independently-committing sessions.

    The shared harness ``client`` routes every request through one
    connection/session (rollback isolation), so it cannot exercise true DB
    concurrency — the advisory-lock setup race or a blocking unique-index race.
    This builds a throwaway app on its own engine: every request gets a fresh
    session (own pooled connection), and commits are real. Callers must
    ``truncate_auth_tables`` afterwards so committed rows don't leak.
    """
    engine = create_async_engine(settings.database_url)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    app = create_app(settings)

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        async with maker() as session:
            yield session

    app.dependency_overrides[get_session] = _override_get_session
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    return client, engine


async def truncate_auth_tables(engine: AsyncEngine) -> None:
    """Wipe the auth tables a committing test wrote (cleanup + preconditions)."""
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {AUTH_TABLES} RESTART IDENTITY CASCADE"))
