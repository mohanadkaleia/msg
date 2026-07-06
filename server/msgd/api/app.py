"""FastAPI application factory (ENG-63 D-5).

``create_app()`` wires logging, settings, the async engine/session factory, the
lifespan, and the health router. The lifespan does a DB **ping only** — never
DDL: migrations run in the container entrypoint (``python -m msgd.db.migrate``)
before uvicorn boots, and the test harness owns schema via fixtures. This keeps
request serving decoupled from migrations and keeps tests deterministic.

Factory-compatible: ``uvicorn msgd.api.app:create_app --factory``.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text

from msgd import ws
from msgd.api.problems import register_problem_handlers
from msgd.api.routers import admin, auth, events_read, events_upload, health, sync
from msgd.api.spa import SPAStaticFiles
from msgd.auth.ratelimit import RateLimiter
from msgd.db.engine import create_engine, create_sessionmaker, set_sessionmaker
from msgd.logging import configure_logging
from msgd.settings import Settings, get_settings

logger = logging.getLogger("msgd.api")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build and return the configured FastAPI application."""
    if settings is None:
        settings = get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_engine(settings.database_url)
        set_sessionmaker(create_sessionmaker(engine))
        # Ping only — no DDL here (migrations run in the entrypoint, D-5).
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        logger.info("msgd startup complete", extra={"event": "startup"})
        try:
            yield
        finally:
            set_sessionmaker(None)
            await engine.dispose()
            logger.info("msgd shutdown complete", extra={"event": "shutdown"})

    # Config-gate the interactive docs + schema (PR #12 security review): when
    # disabled (secure prod default), FastAPI serves 404 for all three.
    docs_kwargs: dict[str, str | None] = (
        {} if settings.docs_enabled else {"docs_url": None, "redoc_url": None, "openapi_url": None}
    )
    app = FastAPI(title="msgd", lifespan=lifespan, **docs_kwargs)  # type: ignore[arg-type]

    # Shared per-app state for dependencies (settings + the one auth limiter).
    app.state.settings = settings
    app.state.auth_limiter = RateLimiter(settings.auth_rate_limit_per_minute, 60)
    # Event-upload limiters (§4.3, ENG-66): sustained/min + burst/s, per user.
    app.state.event_limiter_minute = RateLimiter(settings.event_rate_limit_per_minute, 60)
    app.state.event_limiter_burst = RateLimiter(settings.event_rate_limit_burst_per_second, 1)

    # RFC 9457 problem+json — the app-wide error convention every router inherits.
    register_problem_handlers(app)

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(admin.router)
    app.include_router(events_upload.router)
    app.include_router(events_read.router)
    app.include_router(sync.router)
    app.include_router(ws.router)  # ENG-68: GET /v1/ws (append-only)

    # ENG-75: single-origin SPA (§5.1 D4). Mounted LAST so API routes win;
    # SPAStaticFiles refuses index.html for reserved API prefixes (belt-and-
    # suspenders). The is_dir() guard means dev (no web/dist) skips the mount.
    if settings.serve_spa and settings.web_dist_dir.is_dir():
        app.mount("/", SPAStaticFiles(directory=settings.web_dist_dir, html=True), name="spa")
    return app
