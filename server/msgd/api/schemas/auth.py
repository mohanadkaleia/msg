"""Auth request/response models (ENG-64).

Password policy (D8) is enforced declaratively here: ``min_length=12`` (no
composition rules, NIST-aligned) and ``max_length=1024`` (bounds argon2 work).
The constants mirror the Settings defaults ``password_min_length`` /
``password_max_length``. Invite creation restricts ``role`` to a Literal that
excludes ``owner`` — an invite can never mint an owner (D7).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 1024

Password = Annotated[str, Field(min_length=PASSWORD_MIN_LENGTH, max_length=PASSWORD_MAX_LENGTH)]
Email = Annotated[str, Field(min_length=3, max_length=320)]
DisplayName = Annotated[str, Field(min_length=1, max_length=200)]
DeviceLabel = Annotated[str, Field(min_length=1, max_length=200)]


def _looks_like_email(value: str) -> str:
    # Deliberately minimal (no email-validator dependency): a single ``@`` with
    # non-empty local and domain parts. Deeper validation is not load-bearing —
    # the workspace-unique constraint and login are what matter.
    local, sep, domain = value.partition("@")
    if not sep or not local or "." not in domain:
        raise ValueError("must be a valid email address")
    return value.strip().lower()


class SetupRequest(BaseModel):
    """First-run: create the workspace + owner (POST /v1/setup)."""

    workspace_name: Annotated[str, Field(min_length=1, max_length=200)]
    email: Email
    password: Password
    display_name: DisplayName

    _normalize_email = field_validator("email")(_looks_like_email)


class LoginRequest(BaseModel):
    """Credentials + device identity (POST /v1/auth/login)."""

    email: Email
    password: Password
    device_label: DeviceLabel
    device_id: str | None = None

    _normalize_email = field_validator("email")(_looks_like_email)


class LoginResponse(BaseModel):
    """Successful auth — the raw session token is returned here exactly once."""

    token: str
    user_id: str
    device_id: str
    workspace_id: str
    role: str
    expires_at: datetime


class SessionInfo(BaseModel):
    """One row of GET /v1/auth/sessions. ``id`` is the session ``token_hash``."""

    id: str
    device_id: str
    device_label: str | None
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    current: bool


class SessionListResponse(BaseModel):
    sessions: list[SessionInfo]


class CreateInviteRequest(BaseModel):
    """POST /v1/admin/invites — role cannot be ``owner`` (D7)."""

    role: Literal["member", "guest", "admin"] = "member"
    ttl_seconds: int | None = Field(default=None, ge=1)


class InviteResponse(BaseModel):
    """The join URL is returned once (the raw invite token is embedded in it)."""

    url: str
    expires_at: datetime


class AcceptInviteRequest(BaseModel):
    """POST /v1/auth/accept-invite — unauthenticated; the token is the authz."""

    token: Annotated[str, Field(min_length=1)]
    email: Email
    display_name: DisplayName
    password: Password

    _normalize_email = field_validator("email")(_looks_like_email)
