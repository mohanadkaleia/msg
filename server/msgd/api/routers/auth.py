"""Auth router (ENG-64): setup, login, sessions list/revoke, accept-invite.

Every endpoint here errors via problem+json (registered app-wide). The three
credential-taking POSTs (setup, login, accept-invite) are gated by the auth
rate limiter (per-IP + per-email, D6) *before* any argon2 work runs.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.api.deps import AppSettings, CurrentAuth, auth_rate_limit
from msgd.api.schemas.auth import (
    AcceptInviteRequest,
    LoginRequest,
    LoginResponse,
    SessionInfo,
    SessionListResponse,
    SetupRequest,
)
from msgd.auth.passwords import (
    dummy_verify,
    hash_password_async,
    needs_rehash,
    verify_password,
)
from msgd.auth.sessions import (
    create_session,
    list_sessions,
    mint_or_reuse_device,
    revoke_session,
    utcnow,
)
from msgd.auth.tokens import hash_token
from msgd.core.ids import new_stream_id, new_user_id, new_workspace_id
from msgd.core.payloads import (
    build_channel_created_body,
    build_channel_member_added_body,
    build_user_joined_body,
    build_workspace_created_body,
)
from msgd.core.time import now_rfc3339
from msgd.db.engine import get_session
from msgd.db.models import Device, Invite, Stream, User, Workspace
from msgd.events.emit import emit_event

logger = logging.getLogger("msgd.auth")

router = APIRouter(prefix="/v1", tags=["auth"])

DbSession = Annotated[AsyncSession, Depends(get_session)]

# Fixed advisory-lock key for first-run setup (D1). hashtext() maps the label to
# an int; pg_advisory_xact_lock serializes concurrent setups within a txn.
_SETUP_LOCK_SQL = text("SELECT pg_advisory_xact_lock(hashtext('msg:setup'))")


async def _login_response(
    db: AsyncSession,
    *,
    user: User,
    device: Device,
    settings: AppSettings,
) -> LoginResponse:
    """Mint a session for ``user``/``device`` and shape the login response."""
    session, raw = await create_session(
        db, user_id=user.user_id, device_id=device.device_id, settings=settings
    )
    await db.commit()
    return LoginResponse(
        token=raw,
        user_id=user.user_id,
        device_id=device.device_id,
        workspace_id=user.workspace_id,
        role=user.role,
        expires_at=session.expires_at,
    )


@router.post("/setup", response_model=LoginResponse, dependencies=[Depends(auth_rate_limit)])
async def setup(req: SetupRequest, db: DbSession, settings: AppSettings) -> LoginResponse:
    """First-run: create the workspace + owner, auto-login (D1).

    Valid only while zero users exist. A transaction-scoped Postgres advisory
    lock serializes concurrent setups; the loser sees ``count > 0`` and gets 409.
    """
    # Advisory lock FIRST — serialize any concurrent setup attempts (D1).
    await db.execute(_SETUP_LOCK_SQL)
    user_count = await db.scalar(select(func.count()).select_from(User))
    if user_count:
        raise problems.already_initialized()

    workspace_id = new_workspace_id()
    user_id = new_user_id()
    password_hash = await hash_password_async(settings, req.password)
    # No ORM relationships are declared (models.py), so the unit-of-work does not
    # auto-order these FK-linked inserts — flush the workspace before the user.
    db.add(Workspace(workspace_id=workspace_id, name=req.workspace_name))
    await db.flush()
    db.add(
        User(
            user_id=user_id,
            workspace_id=workspace_id,
            email=req.email,
            password_hash=password_hash,
            display_name=req.display_name,
            role="owner",
        )
    )
    await db.flush()

    # ENG-65 (D2/D8): mint the device FIRST (reorder — ``author_device_id`` is
    # validated, so the device must exist before we author events), then emit the
    # two server-authored meta events into a fresh workspace-meta stream. The
    # reducer inside ``emit_event`` creates the meta stream row before the insert
    # sequences into it (D4 bootstrap invariant). Both land atomically with the
    # workspace/owner rows at the ``_login_response`` commit.
    device = await mint_or_reuse_device(db, user_id=user_id, device_label=None, device_id=None)
    assert device is not None  # mint path (no device_id) never returns None
    await db.flush()

    authored_at = now_rfc3339()
    meta_stream_id = new_stream_id()
    # seq 1 — workspace.created, authored by the owner (D2).
    await emit_event(
        db,
        home_stream_id=meta_stream_id,
        body=build_workspace_created_body(
            workspace_id=workspace_id,
            stream_id=meta_stream_id,
            author_user_id=user_id,
            author_device_id=device.device_id,
            client_created_at=authored_at,
            name=req.workspace_name,
        ),
    )
    # seq 2 — owner user.joined, so every workspace member has exactly one
    # ``user.joined`` in the meta log (uniform member-list invariant, D2).
    await emit_event(
        db,
        home_stream_id=meta_stream_id,
        body=build_user_joined_body(
            workspace_id=workspace_id,
            stream_id=meta_stream_id,
            author_user_id=user_id,
            author_device_id=device.device_id,
            client_created_at=authored_at,
            user_id=user_id,
            display_name=req.display_name,
        ),
    )
    # seq 3 — channel.created for the default #general channel (ENG-109). The web
    # channel-creation UI is not built yet, so without this a fresh workspace has
    # no channel and the owner's sidebar is empty (unusable out of the box). This
    # server-authored PUBLIC channel is homed in workspace-meta (§2.2 public
    # placement); the same reducer-before-insert ordering (D4) has
    # ``_reduce_channel_created`` create the channel's OWN stream row (head_seq 0)
    # + the owner's ``stream_members`` row in this same transaction — so the
    # owner's ``GET /v1/sync`` returns `general` (public, member:true) right away.
    channel_stream_id = new_stream_id()
    await emit_event(
        db,
        home_stream_id=meta_stream_id,
        body=build_channel_created_body(
            workspace_id=workspace_id,
            stream_id=meta_stream_id,
            author_user_id=user_id,
            author_device_id=device.device_id,
            client_created_at=authored_at,
            channel_stream_id=channel_stream_id,
            name=settings.default_channel_name,
            visibility="public",
        ),
    )

    user = await db.get(User, user_id)
    assert user is not None
    return await _login_response(db, user=user, device=device, settings=settings)


@router.post("/auth/login", response_model=LoginResponse, dependencies=[Depends(auth_rate_limit)])
async def login(req: LoginRequest, db: DbSession, settings: AppSettings) -> LoginResponse:
    """Verify credentials (argon2id), mint/reuse a device, and open a session."""
    # Single-workspace MVP: email is effectively global (§7/D6).
    user = await db.scalar(select(User).where(User.email == req.email).limit(1))
    if user is None or user.deactivated_at is not None:
        # Unknown email / deactivated: burn an identical argon2 verify against a
        # dummy hash, then return the *same* generic 401 as a wrong password —
        # no enumeration by timing or by response shape (D2).
        await dummy_verify(settings, req.password)
        raise problems.invalid_credentials()

    if not await verify_password(settings, user.password_hash, req.password):
        raise problems.invalid_credentials()

    # D8 seam: rehash-on-login (with the plaintext in hand) is deferred past M1;
    # until then, surface stale-parameter hashes in the logs so operators see
    # when a params bump has left old hashes behind. Never log the hash itself.
    if needs_rehash(settings, user.password_hash):
        logger.info(
            "password hash uses stale argon2 parameters; rehash deferred (D8)",
            extra={"user_id": user.user_id},
        )

    device = await mint_or_reuse_device(
        db,
        user_id=user.user_id,
        device_label=req.device_label,
        device_id=req.device_id,
    )
    if device is None:
        # Runs only after successful auth → discloses nothing about credentials.
        raise problems.invalid_device()
    await db.flush()
    return await _login_response(db, user=user, device=device, settings=settings)


@router.get("/auth/sessions", response_model=SessionListResponse)
async def list_user_sessions(ctx: CurrentAuth, db: DbSession) -> SessionListResponse:
    """List the caller's sessions; the current session is flagged (D5).

    ``id`` is the session ``token_hash`` — not a credential (it cannot be
    reversed to the bearer token) and a user only ever sees their own (§Risks).
    """
    sessions = await list_sessions(db, ctx.user_id)
    device_ids = {s.device_id for s in sessions}
    labels: dict[str, str | None] = {}
    if device_ids:
        rows = await db.execute(select(Device).where(Device.device_id.in_(device_ids)))
        labels = {d.device_id: d.label for d in rows.scalars()}
    return SessionListResponse(
        sessions=[
            SessionInfo(
                id=s.token_hash,
                device_id=s.device_id,
                device_label=labels.get(s.device_id),
                created_at=s.created_at,
                last_seen_at=s.last_seen_at,
                expires_at=s.expires_at,
                current=s.token_hash == ctx.session_token_hash,
            )
            for s in sessions
        ]
    )


@router.delete("/auth/sessions/{session_id}", status_code=204)
async def revoke_user_session(session_id: str, ctx: CurrentAuth, db: DbSession) -> None:
    """Revoke one of the caller's sessions (instant — next request 401s).

    Scoped to the owner: revoking another user's session id matches no row → 404.
    """
    deleted = await revoke_session(db, token_hash=session_id, user_id=ctx.user_id)
    if not deleted:
        raise problems.not_found("no such session")
    await db.commit()


@router.post(
    "/auth/accept-invite",
    response_model=LoginResponse,
    dependencies=[Depends(auth_rate_limit)],
)
async def accept_invite(
    req: AcceptInviteRequest, db: DbSession, settings: AppSettings
) -> LoginResponse:
    """Accept an invite (unauthenticated — the token is the authorization, D7).

    Single-use is enforced by an atomic ``UPDATE ... WHERE used_by IS NULL
    RETURNING``: two concurrent accepts race on that update and exactly one wins.

    Claim-then-check (security round 1): the claim runs FIRST; email uniqueness
    is enforced by letting ``UNIQUE(workspace_id, email)`` reject the INSERT.
    The resulting rollback un-claims the invite in the same transaction — a
    duplicate-email attempt never burns a single-use invite — and the generic
    409 body discloses nothing about which emails exist (no pre-check SELECT,
    so no oracle and no concurrent-duplicate 500).
    """
    now = utcnow()
    token_hash = hash_token(req.token)
    invite = await db.get(Invite, token_hash)
    if invite is None:
        raise problems.invalid_invite()
    if invite.used_by is not None:
        raise problems.invite_used()
    if now >= invite.expires_at:
        raise problems.invite_expired()

    new_user_ident = new_user_id()
    claimed = await db.execute(
        update(Invite)
        .where(Invite.token_hash == token_hash, Invite.used_by.is_(None))
        .values(used_by=new_user_ident)
        .returning(Invite.token_hash)
    )
    if claimed.first() is None:
        # Lost the single-use race — another accept consumed it first.
        raise problems.invite_used()

    password_hash = await hash_password_async(settings, req.password)
    db.add(
        User(
            user_id=new_user_ident,
            workspace_id=invite.workspace_id,
            email=req.email,
            password_hash=password_hash,
            display_name=req.display_name,
            role=invite.role,
        )
    )
    try:
        await db.flush()
    except IntegrityError:
        # UNIQUE(workspace_id, email) rejected the INSERT (Postgres checks it at
        # statement execution, i.e. here — a concurrent same-email accept blocks
        # on the index until the winner commits, then raises the same way).
        # Roll back the whole transaction: the invite claim above is undone, so
        # the invite stays usable. Generic 409 — no email-existence oracle.
        await db.rollback()
        raise problems.account_conflict() from None

    # ENG-65 (D2/D8): mint the device FIRST (reorder — the device must exist
    # before we author events), then emit ``user.joined`` for the invitee into
    # the workspace's meta stream (single-workspace MVP → exactly one). Authored
    # by the joining user (D2). Lands atomically at the ``_login_response`` commit.
    device = await mint_or_reuse_device(
        db, user_id=new_user_ident, device_label=None, device_id=None
    )
    assert device is not None
    await db.flush()

    meta_stream_id = await db.scalar(
        select(Stream.stream_id).where(
            Stream.workspace_id == invite.workspace_id,
            Stream.kind == "workspace-meta",
        )
    )
    assert meta_stream_id is not None  # setup always creates the meta stream
    await emit_event(
        db,
        home_stream_id=meta_stream_id,
        body=build_user_joined_body(
            workspace_id=invite.workspace_id,
            stream_id=meta_stream_id,
            author_user_id=new_user_ident,
            author_device_id=device.device_id,
            client_created_at=now_rfc3339(),
            user_id=new_user_ident,
            display_name=req.display_name,
        ),
    )

    # ENG-112: auto-join the invitee to the workspace's default #general channel so
    # their sidebar isn't empty on first load. Setup (ENG-109) auto-adds only the
    # OWNER (via channel.created's genesis member-add), so a later invitee has no
    # channel membership until now. Find the setup-created default channel — the
    # PUBLIC `channel` stream named ``settings.default_channel_name`` in this
    # workspace — and emit a server-authored ``channel.member_added`` self-joining
    # the invitee. §2.2 homes a PUBLIC-channel lifecycle event in workspace-meta
    # (mirrors setup's channel.created and validate.py's upload homing rule), while
    # the reducer grows the channel's OWN stream_members (payload.channel_stream_id).
    # Authored by the invitee (self-join, like their user.joined). Server-authored,
    # so it bypasses can_write like setup's channel.created. If the default channel
    # is missing (renamed/archived edge), skip gracefully — never fail the accept.
    # Decision: default-channel-only (matches the owner); auto-joining ALL public
    # channels is a possible future.
    #
    # Guests are excluded: a guest sees ONLY explicit-membership streams (no
    # workspace-meta, no public-channel browser — D5/ENG-67), so they are invited
    # to specific channels/DMs rather than dropped into #general. Auto-joining a
    # guest would silently widen their scope, so the default-channel add is
    # scoped to full members (owner/admin/member).
    default_channel_stream_id = (
        await db.scalar(
            select(Stream.stream_id).where(
                Stream.workspace_id == invite.workspace_id,
                Stream.kind == "channel",
                Stream.visibility == "public",
                Stream.name == settings.default_channel_name,
            )
        )
        if invite.role != "guest"
        else None
    )
    if default_channel_stream_id is not None:
        await emit_event(
            db,
            home_stream_id=meta_stream_id,
            body=build_channel_member_added_body(
                workspace_id=invite.workspace_id,
                stream_id=meta_stream_id,
                author_user_id=new_user_ident,
                author_device_id=device.device_id,
                client_created_at=now_rfc3339(),
                channel_stream_id=default_channel_stream_id,
                user_id=new_user_ident,
            ),
        )

    user = await db.get(User, new_user_ident)
    assert user is not None
    return await _login_response(db, user=user, device=device, settings=settings)
