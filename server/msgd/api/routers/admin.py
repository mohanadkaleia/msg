"""Admin router (ENG-64 D7, ENG-151): invites + member/role management.

ENG-64 shipped ``POST /v1/admin/invites`` (create only). ENG-151 adds the rest
of the admin surface — the member roster, role changes + deactivation, and
invite listing/revocation — all behind ``AdminAuth`` (owner/admin only; member
and guest are 403'd by ``require_role`` before any handler body runs).

This is a PRIVILEGE-ESCALATION surface, so the authz is the crux. The role
decision is factored into the pure, DB-free :func:`check_member_update` so it is
unit-testable cell-by-cell against the matrix. Read its docstring for the full
authz matrix and the owner-immutability / ≥1-active-owner proof.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.api.deps import AppSettings, require_role
from msgd.api.problems import ProblemException
from msgd.api.schemas.admin import (
    InviteInfo,
    InviteListResponse,
    MemberInfo,
    MemberListResponse,
    UpdateMemberRequest,
)
from msgd.api.schemas.auth import CreateInviteRequest, InviteResponse
from msgd.auth.context import AuthContext
from msgd.auth.sessions import utcnow
from msgd.auth.tokens import mint_token
from msgd.db.engine import get_session
from msgd.db.models import Invite, Session, User

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


def check_member_update(*, actor_role: str, actor_id: str, target: User) -> ProblemException | None:
    """Authorize an admin's PATCH of ``target`` — pure, DB-free, unit-testable.

    Returns the FIRST failing :class:`ProblemException` (403), or ``None`` when
    the identity checks pass. Rules applied IN ORDER (a caller has already passed
    ``require_role("owner","admin")``, so ``actor_role`` is ``owner`` or
    ``admin`` — ``member``/``guest`` never reach here):

    ================================  ======  =========================================
    condition (first match wins)      result  rationale
    ================================  ======  =========================================
    target is the actor (self-edit)   403     no self-modification of role OR active,
                                              ever — an owner cannot demote or
                                              deactivate themselves (see the proof
                                              below); an admin cannot either.
    target.role == "owner"            403     the owner account is IMMUTABLE via the
                                              API — role AND active both locked.
    actor==admin + target.role==      403     only the owner manages admins; an admin
    "admin"                                   may not change a PEER admin's role NOR
                                              deactivate/reactivate them (both the
                                              role and active branches 403).
    otherwise                         None    identity checks pass.
    ================================  ======  =========================================

    The bot rule (a role change on a bot is 403, but deactivating a bot is
    allowed) is field-dependent, so it lives in the endpoint — this function is
    purely the actor/target IDENTITY matrix.

    Effective matrix once combined with the schema + endpoint:

    * **owner** may set role ∈ {admin, member, guest} and/or deactivate/reactivate
      ANYONE except the owner (themselves) — the owner is the only account that
      can promote/demote admins.
    * **admin** may do the same for members and guests, and may promote a member
      to admin, but may NOT touch the owner, a peer admin, or themselves.

    OWNER-IMMUTABILITY / ≥1-ACTIVE-OWNER PROOF. The workspace always retains at
    least one active owner, and it is exactly the ``/v1/setup`` owner:

    1. The owner role is only ever ASSIGNED at ``/v1/setup`` — every other
       role-taking path (invite create, this PATCH) uses a Literal that excludes
       ``owner``, so no ``owner`` account is ever minted after setup.
    2. The single owner row is IMMUTABLE here — rule (b) 403s every PATCH whose
       target is an owner, for both ``role`` and ``active``. It can neither be
       demoted nor deactivated by anyone (including itself — rule (a) also fires).

    Together: the setup owner can never lose the owner role and can never be
    deactivated, so ``count(role='owner' AND deactivated_at IS NULL) >= 1`` holds
    for the life of the workspace. (Multi-owner and owner-transfer are explicit
    non-goals of M1.)
    """
    if target.user_id == actor_id:
        return problems.forbidden("cannot modify your own account")
    if target.role == "owner":
        return problems.forbidden("the owner account cannot be modified")
    if actor_role == "admin" and target.role == "admin":
        # An admin may not modify another admin — role change OR deactivation.
        return problems.forbidden("an admin may not modify another admin")
    return None


def _member_info(user: User) -> MemberInfo:
    """Project a ``users`` row to the admin roster shape (no timestamp leak)."""
    return MemberInfo(
        user_id=user.user_id,
        display_name=user.display_name,
        email=user.email,
        role=user.role,
        is_bot=user.is_bot,
        deactivated=user.deactivated_at is not None,
    )


@router.get("/members", response_model=MemberListResponse)
async def list_members(ctx: AdminAuth, db: DbSession) -> MemberListResponse:
    """List every member of the caller's workspace, ordered by display name.

    Includes DEACTIVATED users and BOTS — the ``deactivated`` / ``is_bot`` flags
    let the admin UI render that state, so the roster is the full picture rather
    than only currently-active humans. Workspace-scoped: only ``ctx.workspace_id``
    rows are returned (no cross-workspace leak).

    EMAILS are admin-visible BY DESIGN. This is a self-hosted server and the
    admin invited each member by email in the first place; exposing it on this
    owner/admin-gated surface reveals nothing they did not already provide. The
    client-facing ``directory.list`` projection stays name-only — member emails
    never leave ``/v1/admin``.
    """
    rows = await db.execute(
        select(User).where(User.workspace_id == ctx.workspace_id).order_by(User.display_name)
    )
    return MemberListResponse(members=[_member_info(u) for u in rows.scalars()])


@router.patch("/members/{user_id}", response_model=MemberInfo)
async def update_member(
    user_id: str, req: UpdateMemberRequest, ctx: AdminAuth, db: DbSession
) -> MemberInfo:
    """Change a member's role and/or active state (owner/admin only, ENG-151).

    Steps, all in ONE transaction:

    1. Load the target ``FOR UPDATE`` (row lock — serializes concurrent PATCHes
       of the same member and pins the role read the authz decision depends on),
       scoped to ``ctx.workspace_id``. A miss (unknown OR cross-workspace id) is
       the uniform ``not_found`` — a cross-workspace user is indistinguishable
       from a nonexistent one (no existence oracle across workspaces).
    2. Authorize via the pure :func:`check_member_update` (self / owner /
       admin-on-admin rules), then the field-dependent bot-role rule. The first
       failing rule 403s; the schema has already excluded assigning ``owner``.
    3. Apply atomically. ``role`` (if given) is set directly. ``active`` (if
       given): ``false`` stamps ``deactivated_at = now()`` AND BULK-REVOKES the
       target's sessions (``DELETE FROM sessions WHERE user_id = target`` — this
       is what ``ix_sessions_user_id`` was reserved for) so every open bearer
       dies IMMEDIATELY, not at expiry; ``true`` clears ``deactivated_at``. Both
       are idempotent (deactivating an already-deactivated user is a 200 no-op;
       the redundant session DELETE simply removes zero rows).

    NOTE — OPERATIONAL STATE, NOT AN EVENT. Role and deactivation live on the
    ``users`` row, NOT in the append-only event log: a PATCH appends ZERO rows to
    ``events`` and touches no projection. Membership/role are server-operational
    state (like ``sessions``), distinct from the hashed, replayable message log
    — so this path deliberately does not ``emit_event``.
    """
    target = await db.scalar(
        select(User)
        .where(User.user_id == user_id, User.workspace_id == ctx.workspace_id)
        .with_for_update()
    )
    if target is None:
        raise problems.not_found("no such user")

    denial = check_member_update(actor_role=ctx.role, actor_id=ctx.user_id, target=target)
    if denial is not None:
        raise denial

    # Field-dependent bot rule: a role change on a bot is rejected, but
    # deactivating a bot is allowed (only the role is fixed at provisioning).
    if req.role is not None and target.is_bot:
        raise problems.forbidden("bot roles are not editable")

    if req.role is not None:
        target.role = req.role
    if req.active is not None:
        if req.active:
            target.deactivated_at = None
        else:
            target.deactivated_at = utcnow()
            # Bulk-revoke: the deactivated user's open sessions die NOW.
            await db.execute(delete(Session).where(Session.user_id == target.user_id))

    await db.commit()
    return _member_info(target)


@router.get("/invites", response_model=InviteListResponse)
async def list_invites(ctx: AdminAuth, db: DbSession) -> InviteListResponse:
    """List the workspace's PENDING invites — unused and unexpired, by expiry.

    ``id`` is the sha256 ``token_hash`` (the revoke handle; NOT a credential —
    irreversible, the sessions-list precedent). The RAW invite token appears
    NOWHERE: it was returned exactly once at create time and never persisted, so
    there is nothing here to leak. Used or expired invites are filtered out.
    """
    now = utcnow()
    rows = await db.execute(
        select(Invite)
        .where(
            Invite.workspace_id == ctx.workspace_id,
            Invite.used_by.is_(None),
            Invite.expires_at > now,
        )
        .order_by(Invite.expires_at)
    )
    return InviteListResponse(
        invites=[
            InviteInfo(
                id=inv.token_hash,
                role=inv.role,
                created_by=inv.created_by,
                expires_at=inv.expires_at,
            )
            for inv in rows.scalars()
        ]
    )


@router.delete("/invites/{invite_id}", status_code=204)
async def revoke_invite(invite_id: str, ctx: AdminAuth, db: DbSession) -> None:
    """Revoke a pending invite — HARD delete, uniform 404 (ENG-151).

    ``DELETE ... WHERE token_hash = :id AND workspace_id = ctx.workspace_id AND
    used_by IS NULL RETURNING token_hash``. No row deleted → uniform
    ``not_found``: an unknown id, an already-used invite, an already-revoked one,
    and a cross-workspace id all return the IDENTICAL body (no revoked-vs-used
    -vs-nonexistent oracle). The delete is HARD (no tombstone) — a subsequent
    ``accept-invite`` with the raw token then ``db.get``s nothing and returns the
    same ``invalid_invite`` as any unknown token, so revocation is
    indistinguishable from "never existed".
    """
    deleted = await db.execute(
        delete(Invite)
        .where(
            Invite.token_hash == invite_id,
            Invite.workspace_id == ctx.workspace_id,
            Invite.used_by.is_(None),
        )
        .returning(Invite.token_hash)
    )
    if deleted.first() is None:
        raise problems.not_found("no such invite")
    await db.commit()
