"""Single-origin SPA serving tests (ENG-75, §5.1 D4).

Lightweight and **non-integration**: no Postgres container, no migrations. The
app is built with ``serve_spa=True`` pointed at a throwaway fixture ``dist/`` and
driven in-process via ``ASGITransport`` **without** running the lifespan (so no
DB connection is attempted). ``get_session`` is overridden with a trivial fake
purely so ``/healthz`` produces its real JSON response for the not-shadowed
assertion; every other assertion is route-level.

These prove the load-bearing contract: the SPA serves at ``/`` and at unknown
client routes (Vue Router history mode), but never shadows the API — ``/v1/*``,
``/healthz``, ``/metrics`` keep their real responses.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from msgd.api.app import create_app
from msgd.db import engine as engine_module
from msgd.settings import Settings

_INDEX_HTML = "<!doctype html><title>msg</title><div id=app></div>"


class _FakeSession:
    """Minimal stand-in so /healthz's ``SELECT 1`` succeeds without a real DB."""

    async def execute(self, *args: object, **kwargs: object) -> None:
        return None


def _make_dist(tmp_path: Path) -> Path:
    """Create a throwaway ``dist/`` fixture with an index.html; return its path."""
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(_INDEX_HTML, encoding="utf-8")
    return dist


def _spa_settings(tmp_path: Path, *, docs_enabled: bool = False) -> Settings:
    """Settings with the SPA mounted over a fixture dist (docs off by default)."""
    return Settings(
        database_url="postgresql+asyncpg://unused/unused",
        data_dir=tmp_path / "data",
        secret_key="test-secret-key",
        serve_spa=True,
        web_dist_dir=_make_dist(tmp_path),
        docs_enabled=docs_enabled,
    )


@pytest.fixture
def spa_settings(tmp_path: Path) -> Settings:
    """Settings pointed at a throwaway ``dist/`` fixture with an index.html."""
    return _spa_settings(tmp_path)


@pytest_asyncio.fixture
async def spa_client(spa_settings: Settings) -> AsyncIterator[AsyncClient]:
    """In-process client for the SPA-mounted app; no lifespan, no DB."""
    app = create_app(spa_settings)

    async def _override_get_session() -> AsyncIterator[_FakeSession]:
        yield _FakeSession()

    app.dependency_overrides[engine_module.get_session] = _override_get_session
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


async def test_root_serves_index_html(spa_client: AsyncClient) -> None:
    """(a) GET / serves the fixture index.html from web_dist_dir."""
    resp = await spa_client.get("/")
    assert resp.status_code == 200
    assert resp.text == _INDEX_HTML


async def test_unknown_client_route_falls_back_to_index(spa_client: AsyncClient) -> None:
    """(b) An unknown non-API path is the SPA fallback (Vue Router history mode)."""
    resp = await spa_client.get("/channel/some-deep-link")
    assert resp.status_code == 200
    assert resp.text == _INDEX_HTML


async def test_unknown_v1_route_is_not_shadowed(spa_client: AsyncClient) -> None:
    """(c) GET /v1/does-not-exist 404s and is NOT the SPA HTML."""
    resp = await spa_client.get("/v1/does-not-exist")
    assert resp.status_code == 404
    assert resp.text != _INDEX_HTML


async def test_healthz_route_wins(spa_client: AsyncClient) -> None:
    """(d) /healthz keeps its real JSON response — the mount does not shadow it."""
    resp = await spa_client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert resp.text != _INDEX_HTML


async def test_metrics_route_wins(spa_client: AsyncClient) -> None:
    """/metrics keeps its real Prometheus response (no DB needed)."""
    resp = await spa_client.get("/metrics")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert "msgd_up 1" in resp.text


_DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")


async def test_disabled_docs_stay_404_not_spa_shell(tmp_path: Path) -> None:
    """docs OFF (secure prod default) + SPA mounted: docs paths 404, not the shell.

    Guards the PR #12 docs-disable hardening — reserving docs/redoc/openapi.json
    stops the SPA fallback from masking a disabled /docs with a 200 index.html.
    """
    app = create_app(_spa_settings(tmp_path, docs_enabled=False))
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        for path in _DOCS_PATHS:
            resp = await ac.get(path)
            assert resp.status_code == 404, path
            assert resp.text != _INDEX_HTML, path


async def test_enabled_docs_serve_real_responses(tmp_path: Path) -> None:
    """docs ON + SPA mounted: docs routes register first and win (not the shell)."""
    app = create_app(_spa_settings(tmp_path, docs_enabled=True))
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        for path in _DOCS_PATHS:
            resp = await ac.get(path)
            assert resp.status_code == 200, path
            assert resp.text != _INDEX_HTML, path


def test_mount_absent_without_dist(tmp_path: Path) -> None:
    """The is_dir() guard skips the mount when web_dist_dir does not exist."""
    settings = Settings(
        database_url="postgresql+asyncpg://unused/unused",
        data_dir=tmp_path / "data",
        secret_key="test-secret-key",
        serve_spa=True,
        web_dist_dir=tmp_path / "missing-dist",
    )
    app = create_app(settings)
    assert not any(getattr(route, "name", None) == "spa" for route in app.routes)
