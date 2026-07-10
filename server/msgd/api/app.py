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
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text

from msgd import ws
from msgd.api.problems import register_problem_handlers
from msgd.api.routers import (
    admin,
    auth,
    avatars,
    events_read,
    events_upload,
    files,
    health,
    me,
    plugins,
    prefs,
    read_state,
    search,
    sync,
    workspace_icon,
)
from msgd.api.spa import SPAStaticFiles
from msgd.auth.ratelimit import RateLimiter
from msgd.blobs.store import LocalDiskBlobStore
from msgd.db.engine import create_engine, create_sessionmaker, set_sessionmaker
from msgd.logging import configure_logging
from msgd.plugins import hooks as plugin_hooks
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
            # Tear down the dedicated thumbnail-decode pool: cancel any queued decodes
            # and do not block shutdown on in-flight ones (they are best-effort work).
            thumbnail_executor.shutdown(wait=False, cancel_futures=True)
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
    # Search limiter (§8, ENG-122): per-user FTS budget, keyed like the event limiters.
    app.state.search_limiter_minute = RateLimiter(settings.search_rate_limit_per_minute, 60)
    # Read-state limiter (D3, ENG-123): per-user budget for PUT /v1/read-state,
    # keyed ``user:{user_id}`` exactly like the event/search limiters.
    app.state.read_state_limiter_minute = RateLimiter(settings.read_state_rate_limit_per_minute, 60)
    # Prefs limiter (D3, ENG-124): per-user budget for PUT /v1/prefs, keyed
    # ``user:{user_id}`` exactly like the read-state/search limiters.
    app.state.prefs_limiter_minute = RateLimiter(settings.prefs_rate_limit_per_minute, 60)
    # Incoming-webhook limiters (ENG-161): the PUBLIC unauthenticated receiver is
    # budgeted per hook (keyed by the sha256 of the path token) AND per client IP;
    # both are checked in a dependency BEFORE any DB work, so an unknown-token
    # flood from one host is 429'd without a single query.
    app.state.hook_limiter_minute = RateLimiter(settings.hook_rate_limit_per_minute, 60)
    app.state.hook_ip_limiter_minute = RateLimiter(settings.hook_rate_limit_per_ip_per_minute, 60)
    # Content-addressed blob store for file attachments (ENG-116, D8). One shared
    # instance rooted under the configured data dir; ``get_blob_store`` reads it.
    app.state.blob_store = LocalDiskBlobStore(root=settings.data_dir / "blobs")
    # Dedicated, bounded pool for UNTRUSTED image decodes (ENG-118 review hardening).
    # render_thumbnail runs here — NEVER on the event loop's default ThreadPoolExecutor
    # (which also serves argon2 + BlobStore fs I/O) — so a decode flood cannot starve
    # auth or blob I/O, and transient decode memory is capped at max_workers × ~168 MB.
    # Torn down in the lifespan finally (shutdown(wait=False, cancel_futures=True)).
    thumbnail_executor = ThreadPoolExecutor(
        max_workers=settings.thumbnail_max_concurrency, thread_name_prefix="thumbnail"
    )
    app.state.thumbnail_executor = thumbnail_executor
    # File limiters (ENG-116, per user): a tighter budget for the mutating/disk
    # writes (initiate + blob) and a more generous one for read-only downloads.
    app.state.file_limiter_minute = RateLimiter(settings.file_rate_limit_per_minute, 60)
    app.state.file_download_limiter_minute = RateLimiter(
        settings.file_download_rate_limit_per_minute, 60
    )

    # RFC 9457 problem+json — the app-wide error convention every router inherits.
    register_problem_handlers(app)

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(admin.router)
    app.include_router(plugins.router)  # ENG-159/161: /v1/plugins (bots + tokens + hooks mgmt)
    # ENG-161: the PUBLIC incoming-webhook receiver (capability URL, NO auth
    # dependency — the path token is the credential; see msgd.plugins.hooks).
    app.include_router(plugin_hooks.router)
    app.include_router(me.router)  # self-profile: GET/PATCH /v1/me (structurally self-only)
    # ENG-152 profile pictures: POST/DELETE /v1/me/avatar (self-only, re-encode
    # pipeline) + GET /v1/users/{id}/avatar (workspace-readable, never by hash).
    app.include_router(avatars.router)
    # ENG-152 workspace icon: POST/DELETE /v1/admin/workspace/icon (owner/admin,
    # re-encode pipeline) + GET /v1/workspace/icon (workspace-readable, no sha).
    app.include_router(workspace_icon.router)
    app.include_router(events_upload.router)
    app.include_router(events_read.router)
    app.include_router(files.router)  # ENG-116: /v1/files (initiate + blob + download)
    app.include_router(sync.router)
    app.include_router(search.router)  # ENG-122: GET /v1/search (Postgres FTS, readable-scoped)
    app.include_router(read_state.router)  # ENG-123: /v1/read-state (synced per-user KV, D3)
    app.include_router(prefs.router)  # ENG-124: /v1/prefs (synced per-user KV, LWW, D3)
    app.include_router(ws.router)  # ENG-68: GET /v1/ws (append-only)

    # ENG-75: single-origin SPA (§5.1 D4). Mounted LAST so API routes win;
    # SPAStaticFiles refuses index.html for reserved API prefixes (belt-and-
    # suspenders). The is_dir() guard means dev (no web/dist) skips the mount.
    if settings.serve_spa and settings.web_dist_dir.is_dir():
        app.mount("/", SPAStaticFiles(directory=settings.web_dist_dir, html=True), name="spa")
    return app
