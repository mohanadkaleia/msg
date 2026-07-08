"""FastAPI dependencies: the auth contract and rate-limit wiring (ENG-64 D5/D6).

* :func:`require_auth` → :class:`~msgd.auth.context.AuthContext` — parses the
  bearer token, loads + validates the session, performs the throttled rolling
  bump, and yields the frozen context every protected M1 router consumes.
* :func:`require_role` — a dependency factory layering role checks on top.
* :func:`rate_limit` — a generic ``(limiter, key_fn)`` dependency factory reused
  by ENG-66 with its own limiter/keys. :func:`auth_rate_limit` is the auth-path
  instance: per-IP **and** per-email buckets checked before argon2 runs.

Settings and the auth :class:`~msgd.auth.ratelimit.RateLimiter` are read from
``request.app.state`` (installed by ``create_app``), so tests exercising a
weak-param / custom-limit app get the right instances.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.auth.context import AuthContext
from msgd.auth.ratelimit import RateLimiter, client_ip
from msgd.auth.sessions import bump_session, lookup_session, utcnow
from msgd.auth.tokens import hash_token
from msgd.blobs.store import BlobStore
from msgd.db.engine import get_session
from msgd.events.permissions import can_read
from msgd.settings import Settings


def get_app_settings(request: Request) -> Settings:
    """Return the :class:`Settings` the app was built with (app.state)."""
    settings: Settings = request.app.state.settings
    return settings


def get_auth_limiter(request: Request) -> RateLimiter:
    """Return the per-app auth :class:`RateLimiter` (app.state)."""
    limiter: RateLimiter = request.app.state.auth_limiter
    return limiter


def get_event_limiters(request: Request) -> tuple[RateLimiter, RateLimiter]:
    """Return the (per-minute, per-second-burst) event limiters (app.state, ENG-66)."""
    minute: RateLimiter = request.app.state.event_limiter_minute
    burst: RateLimiter = request.app.state.event_limiter_burst
    return minute, burst


def get_file_limiters(request: Request) -> tuple[RateLimiter, RateLimiter]:
    """Return the (write, download) per-user file limiters (app.state, ENG-116)."""
    write: RateLimiter = request.app.state.file_limiter_minute
    download: RateLimiter = request.app.state.file_download_limiter_minute
    return write, download


def get_search_limiter(request: Request) -> RateLimiter:
    """Return the per-user search :class:`RateLimiter` (app.state, ENG-122)."""
    limiter: RateLimiter = request.app.state.search_limiter_minute
    return limiter


def get_read_state_limiter(request: Request) -> RateLimiter:
    """Return the per-user read-state :class:`RateLimiter` (app.state, ENG-123)."""
    limiter: RateLimiter = request.app.state.read_state_limiter_minute
    return limiter


def get_blob_store(request: Request) -> BlobStore:
    """Return the process-wide content-addressed :class:`BlobStore` (app.state, ENG-116).

    One :class:`~msgd.blobs.store.LocalDiskBlobStore` is constructed in
    ``create_app`` (rooted at ``settings.data_dir / "blobs"``) and shared by every
    request — the store is stateless beyond its root path, so a singleton is
    correct and avoids re-resolving the root per request.
    """
    store: BlobStore = request.app.state.blob_store
    return store


def get_thumbnail_executor(request: Request) -> ThreadPoolExecutor:
    """Return the dedicated bounded thumbnail-decode pool (app.state, ENG-118).

    One :class:`~concurrent.futures.ThreadPoolExecutor` is constructed in
    ``create_app`` (``thumbnail_max_concurrency`` workers) and shared by every request.
    UNTRUSTED image decodes (``render_thumbnail``) run HERE, isolated from the event
    loop's default pool — which also serves argon2 hashing and BlobStore fs I/O — so a
    decode flood cannot starve auth or blob I/O. The pool is shut down in the app's
    lifespan ``finally``.
    """
    executor: ThreadPoolExecutor = request.app.state.thumbnail_executor
    return executor


AppSettings = Annotated[Settings, Depends(get_app_settings)]

KeyFn = Callable[[Request], Iterable[str] | Awaitable[Iterable[str]]]


def rate_limit(limiter: RateLimiter, key_fn: KeyFn) -> Callable[[Request], Awaitable[None]]:
    """Build a dependency that rate-limits a request by the keys ``key_fn`` yields.

    Generic and reusable (ENG-66 constructs its own ``limiter`` + ``key_fn`` for
    the 60/min/user event limits). Every yielded key is checked; the first
    exceeded bucket raises 429 ``/problems/rate-limited`` with ``Retry-After``.
    The attempt still counts toward each window.
    """

    async def dependency(request: Request) -> None:
        keys = key_fn(request)
        if inspect.isawaitable(keys):
            keys = await keys
        for key in keys:
            result = limiter.check(key)
            if not result.allowed:
                raise problems.rate_limited(result.retry_after)

    return dependency


async def _auth_keys(request: Request) -> list[str]:
    """Yield the per-IP and per-email buckets for an auth attempt (D6)."""
    settings = get_app_settings(request)
    ip = client_ip(request, trust_proxy=settings.trust_proxy)
    keys = [f"ip:{ip}"]
    # Read the email from the (cached) JSON body for the per-email bucket. The
    # body stream is cached by Starlette, so the endpoint still parses it after.
    try:
        payload = await request.json()
    except Exception:
        payload = None
    if isinstance(payload, dict):
        email = payload.get("email")
        if isinstance(email, str) and email.strip():
            keys.append(f"email:{email.strip().lower()}")
    return keys


async def auth_rate_limit(request: Request) -> None:
    """Auth-endpoint rate limit: 10/min per IP and per email (D6, §4.3)."""
    limiter = get_auth_limiter(request)
    keys = await _auth_keys(request)
    for key in keys:
        result = limiter.check(key)
        if not result.allowed:
            raise problems.rate_limited(result.retry_after)


def _parse_bearer(request: Request) -> str:
    """Extract the raw bearer token or raise 401 (uniform for missing/malformed)."""
    header = request.headers.get("authorization")
    if not header:
        raise problems.unauthenticated("missing Authorization header")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise problems.unauthenticated("malformed Authorization header")
    return token.strip()


async def require_auth(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_session)],
    settings: AppSettings,
) -> AuthContext:
    """Authenticate a request → :class:`AuthContext` (D5).

    Uniform 401 on every failure path (missing/malformed header, unknown token,
    expired session, deactivated user) — never reveal which check failed. On
    success, perform the throttled rolling bump (D4) and return the context.
    """
    token = _parse_bearer(request)
    token_hash = hash_token(token)

    loaded = await lookup_session(db, token_hash)
    if loaded is None:
        raise problems.unauthenticated()
    session, user, device = loaded

    now = utcnow()
    if now >= session.expires_at:
        raise problems.unauthenticated()
    if user.deactivated_at is not None:
        raise problems.unauthenticated()

    if await bump_session(db, session, settings=settings, now=now):
        await db.commit()

    return AuthContext(
        user_id=user.user_id,
        workspace_id=user.workspace_id,
        role=user.role,
        device_id=device.device_id,
        session_token_hash=session.token_hash,
        user=user,
        device=device,
        session=session,
    )


CurrentAuth = Annotated[AuthContext, Depends(require_auth)]


async def event_rate_limit(ctx: CurrentAuth, request: Request) -> None:
    """Event-upload rate limit (§4.3, ENG-66): 60/min + 20/s burst, per user.

    Checks BOTH ``app.state`` event limiters keyed ``user:{ctx.user_id}``; the
    first exceeded bucket raises 429 ``/problems/rate-limited`` with
    ``Retry-After``. A dedicated dependency (like :func:`auth_rate_limit`)
    because the generic :func:`rate_limit` factory only sees the ``Request`` and
    cannot key by the authenticated user — depending on ``require_auth`` gives it
    the user id and runs the limit before the endpoint body parse.

    Granularity ruling: M1 rate-limits per batch REQUEST (one hit per POST per
    limiter), not per event — the fixed-window ``RateLimiter`` has no weight
    parameter. Documented deviation from a literal "events per user"; per-event
    weighting is a flagged future refinement.
    """
    key = f"user:{ctx.user_id}"
    for limiter in get_event_limiters(request):
        result = limiter.check(key)
        if not result.allowed:
            raise problems.rate_limited(result.retry_after)


async def file_rate_limit(ctx: CurrentAuth, request: Request) -> None:
    """File WRITE rate limit (ENG-116): ``file_rate_limit_per_minute`` per user.

    Mounted on the DB-mutating / disk-touching endpoints
    (``POST /v1/files/initiate`` and ``PUT /v1/files/{file_id}/blob``). Modelled on
    :func:`event_rate_limit`: it depends on :data:`CurrentAuth` so the bucket is
    keyed by the authenticated user and the limit runs before any body read. The
    first exceeded bucket raises 429 ``/problems/rate-limited`` with ``Retry-After``.
    """
    write_limiter, _download_limiter = get_file_limiters(request)
    result = write_limiter.check(f"user:{ctx.user_id}")
    if not result.allowed:
        raise problems.rate_limited(result.retry_after)


async def file_download_rate_limit(ctx: CurrentAuth, request: Request) -> None:
    """File DOWNLOAD rate limit (ENG-116): ``file_download_rate_limit_per_minute`` per user.

    A separate, more generous budget than :func:`file_rate_limit` because a client
    legitimately fetches many attachments to render a channel. Same per-user key +
    429 ``/problems/rate-limited`` shape.
    """
    _write_limiter, download_limiter = get_file_limiters(request)
    result = download_limiter.check(f"user:{ctx.user_id}")
    if not result.allowed:
        raise problems.rate_limited(result.retry_after)


async def search_rate_limit(ctx: CurrentAuth, request: Request) -> None:
    """Search rate limit (ENG-122, §8): ``search_rate_limit_per_minute`` per user.

    Mounted on ``GET /v1/search``. Modelled on :func:`event_rate_limit` /
    :func:`file_rate_limit`: it depends on :data:`CurrentAuth` so the bucket is
    keyed by the authenticated user and the limit runs before the FTS query. The
    exceeded bucket raises 429 ``/problems/rate-limited`` with ``Retry-After``.
    """
    result = get_search_limiter(request).check(f"user:{ctx.user_id}")
    if not result.allowed:
        raise problems.rate_limited(result.retry_after)


async def read_state_rate_limit(ctx: CurrentAuth, request: Request) -> None:
    """Read-state rate limit (ENG-123, D3): ``read_state_rate_limit_per_minute`` per user.

    Mounted on ``PUT /v1/read-state``. Modelled on :func:`event_rate_limit` /
    :func:`search_rate_limit`: it depends on :data:`CurrentAuth` so the bucket is
    keyed by the authenticated user and the limit runs before the upsert. The
    budget is generous (scroll-frequent, cheap idempotent write); the exceeded
    bucket raises 429 ``/problems/rate-limited`` with ``Retry-After``.
    """
    result = get_read_state_limiter(request).check(f"user:{ctx.user_id}")
    if not result.allowed:
        raise problems.rate_limited(result.retry_after)


def require_role(*roles: str) -> Callable[[AuthContext], Awaitable[AuthContext]]:
    """Dependency factory: require ``ctx.role`` in ``roles`` else 403 (D5)."""

    async def dependency(ctx: CurrentAuth) -> AuthContext:
        if ctx.role not in roles:
            raise problems.forbidden(f"requires role in {roles}")
        return ctx

    return dependency


async def require_readable_stream(
    stream_id: str,
    ctx: CurrentAuth,
    db: Annotated[AsyncSession, Depends(get_session)],
) -> str:
    """Dependency: 404 unless ``stream_id`` exists **and** is readable by the caller (D5).

    The **404-not-403 discipline** (§3.6 point 2): existence is not disclosed, so
    an unknown stream and a forbidden stream return the identical
    ``/problems/not-found`` body. ``stream_id`` is resolved from the path (if the
    route declares it) or the query string. ENG-65 ships this dependency but
    wires it to no endpoint (channels are event-born, not CRUD); ENG-66+ mounts
    it on the pull endpoints.
    """
    if not await can_read(db, ctx=ctx, stream_id=stream_id):
        raise problems.not_found("no such stream")
    return stream_id
