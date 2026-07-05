"""Admin router (ENG-64 D7): create single-use invites.

Minimal M1 surface — create only. Invite *listing* is intentionally not built
(YAGNI; no admin UI consumes it yet). Restricted to owners and admins.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api.deps import AppSettings, require_role
from msgd.api.schemas.auth import CreateInviteRequest, InviteResponse
from msgd.auth.context import AuthContext
from msgd.auth.sessions import utcnow
from msgd.auth.tokens import mint_token
from msgd.db.engine import get_session
from msgd.db.models import Invite

router = APIRouter(prefix="/v1/admin", tags=["admin"])

DbSession = Annotated[AsyncSession, Depends(get_session)]
AdminAuth = Annotated[AuthContext, Depends(require_role("owner", "admin"))]


@router.post("/invites", response_model=InviteResponse, status_code=201)
async def create_invite(
    req: CreateInviteRequest,
    request: Request,
    ctx: AdminAuth,
    db: DbSession,
    settings: AppSettings,
) -> InviteResponse:
    """Mint a single-use invite; return the join URL once (D7).

    The raw 256-bit token is embedded in the URL and never persisted — only its
    sha256 hex ``token_hash`` is stored. ``role`` cannot be ``owner`` (enforced
    by the request schema's Literal). TTL is clamped to ``invite_max_ttl_seconds``.
    """
    ttl = req.ttl_seconds or settings.invite_default_ttl_seconds
    ttl = min(ttl, settings.invite_max_ttl_seconds)
    expires_at = utcnow() + timedelta(seconds=ttl)

    raw, token_hash = mint_token()
    db.add(
        Invite(
            token_hash=token_hash,
            workspace_id=ctx.workspace_id,
            created_by=ctx.user_id,
            role=req.role,
            expires_at=expires_at,
        )
    )
    await db.commit()

    host = request.headers.get("host") or (
        request.url.netloc if request.url.netloc else "localhost"
    )
    url = f"{request.url.scheme}://{host}/join/{raw}"
    return InviteResponse(url=url, expires_at=expires_at)
