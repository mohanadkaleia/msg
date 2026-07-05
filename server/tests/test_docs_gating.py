"""Docs gating — /docs, /redoc, /openapi.json follow settings.docs_enabled.

PR #12 security-review carryover: secure prod default OFF. No DB access, so these
run without the container.
"""

from __future__ import annotations

from pathlib import Path

from httpx import ASGITransport, AsyncClient
from msgd.api.app import create_app
from msgd.settings import Settings

_PATHS = ("/docs", "/redoc", "/openapi.json")


def _settings(docs_enabled: bool) -> Settings:
    return Settings(
        database_url="postgresql+asyncpg://u:p@localhost/db",
        data_dir=Path("/tmp"),
        secret_key="k",
        docs_enabled=docs_enabled,
    )


async def test_docs_disabled_returns_404() -> None:
    app = create_app(_settings(docs_enabled=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        for path in _PATHS:
            resp = await client.get(path)
            assert resp.status_code == 404, path


async def test_docs_enabled_returns_200() -> None:
    app = create_app(_settings(docs_enabled=True))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        for path in _PATHS:
            resp = await client.get(path)
            assert resp.status_code == 200, path
