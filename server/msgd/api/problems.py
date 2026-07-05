"""RFC 9457 problem+json — the app-wide error convention (TDD §3.2, ENG-64).

Every error the API emits is ``application/problem+json`` with the standard
members ``{type, title, status, detail, instance}``. This module defines:

* :class:`Problem` — the response model.
* :class:`ProblemException` — the exception routers raise; carries a status,
  a relative ``/problems/<slug>`` ``type`` URI, a title, and an optional detail.
* Named factory helpers (``unauthenticated``, ``forbidden``, ...) so call sites
  never hand-assemble a problem.
* :func:`register_problem_handlers` — installs handlers for ``ProblemException``,
  FastAPI's ``RequestValidationError`` (→ 422) and Starlette's ``HTTPException``
  so the *entire* app — including framework-raised errors — speaks problem+json.

Every M1 router inherits this; there is no ad-hoc JSON error anywhere.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

PROBLEM_CONTENT_TYPE = "application/problem+json"


class Problem(BaseModel):
    """An RFC 9457 problem document."""

    type: str
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None


class ProblemException(Exception):
    """Raised by routers/dependencies to emit a problem+json response.

    ``type`` is a relative URI ``/problems/<slug>``. ``headers`` lets a specific
    problem attach response headers (e.g. ``Retry-After`` on a rate-limit).
    """

    def __init__(
        self,
        *,
        status: int,
        type: str,
        title: str,
        detail: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status = status
        self.type = type
        self.title = title
        self.detail = detail
        self.headers = headers
        super().__init__(f"{status} {type}: {title}")


def _problem_response(
    *,
    status: int,
    type: str,
    title: str,
    detail: str | None,
    instance: str | None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    body = Problem(
        type=type, title=title, status=status, detail=detail, instance=instance
    ).model_dump()
    return JSONResponse(
        status_code=status, content=body, media_type=PROBLEM_CONTENT_TYPE, headers=headers
    )


# --- named factories ---------------------------------------------------------
# Slugs are stable relative URIs; downstream tickets and clients switch on them.


def unauthenticated(detail: str | None = None) -> ProblemException:
    return ProblemException(
        status=401,
        type="/problems/unauthenticated",
        title="Authentication required",
        detail=detail,
    )


def invalid_credentials() -> ProblemException:
    # Deliberately generic: identical body/status for unknown-email and
    # wrong-password so login discloses nothing about which emails exist (D2).
    return ProblemException(
        status=401,
        type="/problems/invalid-credentials",
        title="Invalid email or password",
        detail="invalid email or password",
    )


def forbidden(detail: str | None = None) -> ProblemException:
    return ProblemException(
        status=403, type="/problems/forbidden", title="Forbidden", detail=detail
    )


def not_found(detail: str | None = None) -> ProblemException:
    return ProblemException(
        status=404, type="/problems/not-found", title="Not found", detail=detail
    )


def rate_limited(retry_after: int, detail: str | None = None) -> ProblemException:
    return ProblemException(
        status=429,
        type="/problems/rate-limited",
        title="Too many requests",
        detail=detail,
        headers={"Retry-After": str(retry_after)},
    )


def already_initialized() -> ProblemException:
    return ProblemException(
        status=409,
        type="/problems/already-initialized",
        title="Server already initialized",
        detail="setup is only available while no users exist",
    )


def invalid_device() -> ProblemException:
    return ProblemException(
        status=400,
        type="/problems/invalid-device",
        title="Invalid device",
        detail="device_id is unknown or not owned by this user",
    )


def invite_used() -> ProblemException:
    return ProblemException(
        status=410,
        type="/problems/invite-used",
        title="Invite already used",
        detail="this invite has already been accepted",
    )


def invite_expired() -> ProblemException:
    return ProblemException(
        status=410,
        type="/problems/invite-expired",
        title="Invite expired",
        detail="this invite has expired",
    )


def account_conflict() -> ProblemException:
    # Deliberately generic — no email-existence oracle: the same body is
    # returned for any uniqueness clash on account creation, so acceptance
    # discloses nothing about which emails already exist.
    return ProblemException(
        status=409,
        type="/problems/account-conflict",
        title="Account cannot be created",
        detail="account cannot be created with these details",
    )


def invalid_invite() -> ProblemException:
    return ProblemException(
        status=404,
        type="/problems/invalid-invite",
        title="Invalid invite",
        detail="no such invite",
    )


# --- handler registration ----------------------------------------------------


def register_problem_handlers(app: FastAPI) -> None:
    """Install app-wide problem+json exception handlers (called in create_app)."""

    async def _handle_problem(request: Request, exc: ProblemException) -> JSONResponse:
        return _problem_response(
            status=exc.status,
            type=exc.type,
            title=exc.title,
            detail=exc.detail,
            instance=str(request.url.path),
            headers=exc.headers,
        )

    async def _handle_validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Pydantic/FastAPI request validation → 422 problem+json. The raw error
        # list is surfaced under a non-standard ``errors`` extension member for
        # debuggability without leaking submitted values into ``detail``.
        body = Problem(
            type="/problems/validation-error",
            title="Request validation failed",
            status=422,
            detail="one or more fields are invalid",
            instance=str(request.url.path),
        ).model_dump()
        body["errors"] = _sanitize_errors(exc.errors())
        return JSONResponse(status_code=422, content=body, media_type=PROBLEM_CONTENT_TYPE)

    async def _handle_http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        # Framework/Starlette HTTPExceptions (e.g. 404 for an unknown route, 405)
        # are normalized into the same problem+json shape.
        title = exc.detail if isinstance(exc.detail, str) else "HTTP error"
        return _problem_response(
            status=exc.status_code,
            type=f"/problems/http-{exc.status_code}",
            title=title,
            detail=None,
            instance=str(request.url.path),
            headers=dict(exc.headers) if exc.headers else None,
        )

    app.add_exception_handler(ProblemException, _handle_problem)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _handle_validation)  # type: ignore[arg-type]
    app.add_exception_handler(StarletteHTTPException, _handle_http)  # type: ignore[arg-type]


def _sanitize_errors(errors: Sequence[Any]) -> list[dict[str, Any]]:
    """Reduce pydantic errors to ``{loc, msg, type}`` — never echo submitted input.

    Dropping ``input``/``ctx`` keeps a submitted password out of the 422 body.
    """
    out: list[dict[str, Any]] = []
    for err in errors:
        out.append(
            {
                "loc": [str(p) for p in err.get("loc", ())],
                "msg": err.get("msg", ""),
                "type": err.get("type", ""),
            }
        )
    return out
