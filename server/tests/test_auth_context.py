"""The AuthContext dependency contract (ENG-64 D5) via a throwaway probe route."""

from __future__ import annotations

from typing import Annotated

from authutil import auth_header, do_setup, make_app, make_client
from fastapi import APIRouter, Depends, FastAPI
from msgd.api.deps import CurrentAuth, require_role
from msgd.auth.context import AuthContext
from msgd.settings import Settings
from sqlalchemy.ext.asyncio import AsyncSession

probe = APIRouter()


@probe.get("/probe/whoami")
async def whoami(ctx: CurrentAuth) -> dict[str, str]:
    return {
        "user_id": ctx.user_id,
        "workspace_id": ctx.workspace_id,
        "role": ctx.role,
        "device_id": ctx.device_id,
        "session_token_hash": ctx.session_token_hash,
    }


@probe.get("/probe/owner-only")
async def owner_only(
    ctx: Annotated[AuthContext, Depends(require_role("owner"))],
) -> dict[str, bool]:
    return {"ok": True}


@probe.get("/probe/member-only")
async def member_only(
    ctx: Annotated[AuthContext, Depends(require_role("member"))],
) -> dict[str, bool]:
    return {"ok": True}


async def test_context_fields_and_role_gate(settings: Settings, db_session: AsyncSession) -> None:
    """require_auth yields the right principal; require_role enforces the role."""
    app = make_app(settings, db_session, configure=lambda a: _mount(a))
    async with make_client(app) as client:
        body = await do_setup(client)
        token = body["token"]

        who = await client.get("/probe/whoami", headers=auth_header(token))
        assert who.status_code == 200
        data = who.json()
        assert data["user_id"] == body["user_id"]
        assert data["workspace_id"] == body["workspace_id"]
        assert data["role"] == "owner"
        assert data["device_id"] == body["device_id"]

        # Owner passes an owner gate…
        allowed = await client.get("/probe/owner-only", headers=auth_header(token))
        assert allowed.status_code == 200
        # …and is refused a member-only gate with 403.
        refused = await client.get("/probe/member-only", headers=auth_header(token))
        assert refused.status_code == 403
        assert refused.json()["type"] == "/problems/forbidden"


def _mount(app: FastAPI) -> None:
    app.include_router(probe)
