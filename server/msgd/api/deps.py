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
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.auth.context import AuthContext
from msgd.auth.ratelimit import RateLimiter, client_ip
from msgd.auth.sessions import bump_session, lookup_session, utcnow
from msgd.auth.tokens import hash_token
from msgd.db.engine import get_session
from msgd.settings import Settings


def get_app_settings(request: Request) -> Settings:
    """Return the :class:`Settings` the app was built with (app.state)."""
    settings: Settings = request.app.state.settings
    return settings


def get_auth_limiter(request: Request) -> RateLimiter:
    """Return the per-app auth :class:`RateLimiter` (app.state)."""
    limiter: RateLimiter = request.app.state.auth_limiter
    return limiter


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


def require_role(*roles: str) -> Callable[[AuthContext], Awaitable[AuthContext]]:
    """Dependency factory: require ``ctx.role`` in ``roles`` else 403 (D5)."""

    async def dependency(ctx: CurrentAuth) -> AuthContext:
        if ctx.role not in roles:
            raise problems.forbidden(f"requires role in {roles}")
        return ctx

    return dependency
