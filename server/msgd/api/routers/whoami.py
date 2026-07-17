"""``GET /v1/whoami`` — the caller's own identity (ENG-179).

A bot that authors events must know its ``user_id``, ``device_id``, and
``workspace_id``: the upload validator rejects any event whose
``author_user_id`` / ``author_device_id`` / ``workspace_id`` do not match the
credential (``events/validate.py`` step ii). ``GET /v1/me`` returns the caller's
``user_id`` but NOT its ``device_id`` or ``workspace_id``, and the
``/v1/plugins/bots`` listing that carries ``device_id`` is owner/admin-gated (a
bot is a guest and gets 403 there) — so before ENG-179 a bot had no first-party
way to discover its own ``device_id``. This endpoint closes that gap.

STRUCTURALLY SELF-ONLY, like ``GET /v1/me``: it takes no id, projects only
``ctx`` (which ``require_auth`` already populated), and returns only who the
caller already is. It is therefore ungated — reachable by any valid credential,
human or bot, regardless of which verb scopes the bot happens to hold (identity
discovery must not depend on ``events:read`` vs ``events:write``).
"""

from __future__ import annotations

from fastapi import APIRouter

from msgd.api.deps import CurrentAuth
from msgd.api.schemas.whoami import WhoAmIResponse

router = APIRouter(prefix="/v1", tags=["whoami"])


@router.get("/whoami", response_model=WhoAmIResponse)
async def get_whoami(ctx: CurrentAuth) -> WhoAmIResponse:
    """Return the caller's own identity — a pure projection of ``ctx``."""
    return WhoAmIResponse(
        user_id=ctx.user_id,
        device_id=ctx.device_id,
        workspace_id=ctx.workspace_id,
        is_bot=ctx.user.is_bot,
        role=ctx.role,
    )
