"""Plugins router (ENG-159, M5-1): bot identity + scoped bot tokens.

The whole surface is owner/admin-gated (``require_role`` 403s member/guest —
and therefore every BOT, which is always a guest — before any handler body
runs) and workspace-scoped everywhere (``ctx.workspace_id`` filters; a
cross-workspace or unknown id is the uniform ``not_found``, no existence
oracle). This is a PRIVILEGE surface twice over — it mints bearer credentials
AND emits server-authored meta events — so the boundary rules are locked:

* **A bot is a ``users`` row**: ``is_bot=true``, ``role='guest'`` (access =
  the existing guest readable-streams predicate over explicit
  ``stream_members`` grants, §3.6 — no new predicate code), and
  ``password_hash = UNUSABLE_PASSWORD_HASH`` (the M4 import sentinel: argon2id
  verifies cleanly and matches nothing, so a bot can never log in). One device
  (label ``"bot"``) because every event body carries a validated
  ``author_device_id``.
* **Membership is event-sourced** (§2.2): grants/revokes are
  ``channel.member_added`` / ``channel.member_removed`` emitted through
  ``emit_event`` (reducer grows/shrinks ``stream_members`` in the same
  transaction), homed per the §2.2 rule (public channel → workspace-meta;
  private channel → the channel's own stream). Only ``kind='channel'`` streams
  are grantable — a DM or workspace-meta id collapses to the SAME uniform 404
  as a never-existed id (the ``validate.py`` lifecycle kind-gate, D13).
* **Tokens follow the invite discipline** (D2): raw returned exactly once at
  mint, only the sha256 ``token_hash`` stored; listings expose the hash as a
  revoke handle, never a credential. Scopes are the closed §10 verb vocabulary
  enforced by the request Literal.
* **``bot.installed`` / ``bot.removed``** are server-authored (in
  ``SERVER_AUTHORED_EVENT_TYPES``): this router (+ the admin deactivation
  branch) is the only writer, via ``emit_event`` into workspace-meta.
"""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Request
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.api.deps import require_role
from msgd.api.schemas.plugins import (
    BotInfo,
    BotListResponse,
    BotTokenInfo,
    BotTokenMintResponse,
    CreateBotRequest,
    CreateHookRequest,
    HookCreateResponse,
    HookInfo,
    HookListResponse,
    MintBotTokenRequest,
    Scope,
)
from msgd.auth.bot_tokens import KNOWN_SCOPES, create_bot_token
from msgd.auth.context import AuthContext
from msgd.auth.sessions import mint_or_reuse_device, utcnow
from msgd.auth.tokens import mint_token
from msgd.core.ids import new_user_id
from msgd.core.payloads import (
    build_bot_installed_body,
    build_channel_member_added_body,
    build_channel_member_removed_body,
    build_user_joined_body,
)
from msgd.core.time import now_rfc3339
from msgd.db.engine import get_session
from msgd.db.models import BotToken, Device, Event, IncomingWebhook, Stream, StreamMember, User
from msgd.events.emit import emit_event
from msgd.export.restore import UNUSABLE_PASSWORD_HASH

router = APIRouter(prefix="/v1/plugins", tags=["plugins"])

DbSession = Annotated[AsyncSession, Depends(get_session)]
PluginsAuth = Annotated[AuthContext, Depends(require_role("owner", "admin"))]

#: Uniform 404 details (D13 non-disclosure): an unknown, cross-workspace, or
#: wrong-kind id always yields the identical body — no existence oracle.
_NO_SUCH_BOT = "no such bot"
_NO_SUCH_STREAM = "no such stream"
_NO_SUCH_TOKEN = "no such token"
_NO_SUCH_HOOK = "no such hook"


async def _load_bot(db: AsyncSession, *, ctx: AuthContext, bot_user_id: str) -> User:
    """Resolve ``bot_user_id`` to a BOT user in the caller's workspace, else 404.

    Uniform miss (D13): an unknown id, a cross-workspace bot, and a HUMAN user
    id all collapse to the identical ``not_found`` — the plugins surface never
    confirms the existence of anything that is not the caller's own bot.
    """
    bot = await db.scalar(
        select(User).where(
            User.user_id == bot_user_id,
            User.workspace_id == ctx.workspace_id,
            User.is_bot.is_(True),
        )
    )
    if bot is None:
        raise problems.not_found(_NO_SUCH_BOT)
    return bot


async def _meta_stream_id(db: AsyncSession, workspace_id: str) -> str:
    """The workspace-meta stream id (setup always creates it — assert, don't 404)."""
    stream_id = await db.scalar(
        select(Stream.stream_id).where(
            Stream.workspace_id == workspace_id,
            Stream.kind == "workspace-meta",
        )
    )
    assert stream_id is not None  # /v1/setup emits workspace.created at seq 1
    return stream_id


async def _resolve_channel(db: AsyncSession, *, ctx: AuthContext, stream_id: str) -> Stream:
    """Resolve a grantable CHANNEL in the caller's workspace, else the uniform 404.

    Mirrors ``validate._resolve_channel_in_workspace`` + its kind gate: a
    never-existed id, a cross-workspace id, a DM, and workspace-meta itself all
    collapse to the identical ``not_found`` — granting a bot into a DM or the
    meta stream is structurally impossible, and no distinct error discloses
    which case occurred (D13).
    """
    stream = await db.scalar(
        select(Stream).where(
            Stream.stream_id == stream_id,
            Stream.workspace_id == ctx.workspace_id,
            Stream.kind == "channel",
        )
    )
    if stream is None:
        raise problems.not_found(_NO_SUCH_STREAM)
    return stream


def _membership_home(channel: Stream, meta_stream_id: str) -> str:
    """§2.2 homing for a channel membership event (public → meta; private → own)."""
    return meta_stream_id if channel.visibility == "public" else channel.stream_id


async def _bot_device(db: AsyncSession, bot_user_id: str) -> Device:
    """The bot's single provisioned device (deterministic oldest-first pick)."""
    device = (
        await db.execute(
            select(Device)
            .where(Device.user_id == bot_user_id)
            .order_by(Device.created_at, Device.device_id)
            .limit(1)
        )
    ).scalar()
    assert device is not None  # provisioning always mints exactly one device
    return device


async def _install_scopes(db: AsyncSession, *, ctx: AuthContext, bot_user_id: str) -> list[Scope]:
    """The bot's install scopes, read back from its ``bot.installed`` meta event.

    Event-sourced on purpose: the bot's ``users`` row carries no scope column —
    the ``bot.installed`` payload is the durable record of what the admin named
    at install, and this router is its only writer (SERVER_AUTHORED guard), so
    the latest such event is authoritative. Values are re-filtered against the
    closed vocabulary (defense-in-depth; the install request Literal already
    enforced it). A miss yields ``[]`` — a no-verb, fail-closed credential —
    rather than any wider default.
    """
    body = await db.scalar(
        select(Event.body)
        .where(
            Event.workspace_id == ctx.workspace_id,
            Event.type == "bot.installed",
            Event.body["payload"]["bot_user_id"].astext == bot_user_id,
        )
        .order_by(Event.server_sequence.desc())
        .limit(1)
    )
    if not isinstance(body, dict):
        return []
    payload = body.get("payload")
    raw = payload.get("scopes") if isinstance(payload, dict) else None
    if not isinstance(raw, list):
        return []
    return cast(list[Scope], sorted({s for s in raw if isinstance(s, str) and s in KNOWN_SCOPES}))


def _token_info(token: BotToken) -> BotTokenInfo:
    """Project a ``bot_tokens`` row to its listing shape (hash handle, never raw)."""
    return BotTokenInfo(
        id=token.token_hash,
        scopes=list(token.scopes),
        created_at=token.created_at,
        last_used_at=token.last_used_at,
        revoked=token.revoked_at is not None,
    )


async def _bot_info(db: AsyncSession, bot: User) -> BotInfo:
    """Assemble one bot's listing shape (device + grants + token handles)."""
    device = await _bot_device(db, bot.user_id)
    stream_ids = list(
        (
            await db.execute(
                select(StreamMember.stream_id)
                .where(StreamMember.user_id == bot.user_id)
                .order_by(StreamMember.stream_id)
            )
        ).scalars()
    )
    tokens = (
        (
            await db.execute(
                select(BotToken)
                .where(BotToken.bot_user_id == bot.user_id)
                .order_by(BotToken.created_at, BotToken.token_hash)
            )
        )
        .scalars()
        .all()
    )
    return BotInfo(
        bot_user_id=bot.user_id,
        name=bot.display_name,
        device_id=device.device_id,
        role=bot.role,
        deactivated=bot.deactivated_at is not None,
        stream_ids=stream_ids,
        tokens=[_token_info(t) for t in tokens],
    )


@router.post("/bots", response_model=BotInfo, status_code=201)
async def create_bot(req: CreateBotRequest, ctx: PluginsAuth, db: DbSession) -> BotInfo:
    """Provision a bot identity — user + device + meta events + grants (NO token).

    One transaction, in log order:

    1. Resolve every requested grant FIRST (uniform 404 before any write — a
       bad stream id creates nothing).
    2. Insert the bot ``users`` row (``is_bot``, ``role='guest'``, the
       unusable-password sentinel, a synthetic workspace-unique email) + its
       single device (label ``"bot"``).
    3. Emit ``user.joined`` (self-authored by the bot on its device — the
       setup/accept-invite precedent, preserving the "every member has exactly
       one user.joined" roster invariant) and ``bot.installed`` (authored by
       the ACTING admin — installing is an administrative act) into
       workspace-meta.
    4. Emit one ``channel.member_added`` per grant (admin-authored, §2.2-homed);
       the reducer materializes the ``stream_members`` rows in this same
       transaction.

    The response carries the bot's ``device_id`` (a bot client must author
    events as ``(bot_user_id, device_id)``) and NO credential — tokens are a
    separate, deliberate mint.
    """
    # Step 1 — resolve all grants before any write (dedupe, keep first-seen order).
    requested: list[str] = []
    for stream_id in req.stream_ids:
        if stream_id not in requested:
            requested.append(stream_id)
    channels = [await _resolve_channel(db, ctx=ctx, stream_id=sid) for sid in requested]
    meta_stream_id = await _meta_stream_id(db, ctx.workspace_id)

    # Steps 2–4 — the shared M5 provisioning path (also used by create_hook).
    bot, _device = await _provision_bot_identity(
        db,
        ctx=ctx,
        name=req.name,
        scopes=sorted(set(req.scopes)),
        channels=channels,
        meta_stream_id=meta_stream_id,
    )

    await db.commit()
    return await _bot_info(db, bot)


async def _provision_bot_identity(
    db: AsyncSession,
    *,
    ctx: AuthContext,
    name: str,
    scopes: list[Scope],
    channels: list[Stream],
    meta_stream_id: str,
) -> tuple[User, Device]:
    """Steps 2–4 of bot provisioning (identity + meta events + grants), no commit.

    The ONE bot-creation path (ENG-159, reused verbatim by the ENG-161 hook
    auto-provision): the ``users`` row + single device, then ``user.joined`` +
    ``bot.installed`` into workspace-meta, then one ``channel.member_added``
    per grant (§2.2-homed; the reducer materializes ``stream_members`` in this
    same transaction). The caller resolves ``channels`` FIRST (uniform 404
    before any write) and owns the commit.
    """
    # Step 2 — the bot identity. Email is synthetic but workspace-unique by
    # construction (it embeds the fresh user id) and can never log in anyway
    # (the sentinel hash verifies nothing).
    bot_user_id = new_user_id()
    bot = User(
        user_id=bot_user_id,
        workspace_id=ctx.workspace_id,
        email=f"{bot_user_id}@bot.invalid",
        password_hash=UNUSABLE_PASSWORD_HASH,
        display_name=name,
        role="guest",
        is_bot=True,
    )
    db.add(bot)
    await db.flush()
    device = await mint_or_reuse_device(db, user_id=bot_user_id, device_label="bot", device_id=None)
    assert device is not None  # mint path (no device_id) never returns None
    await db.flush()

    # Step 3 — the meta events.
    authored_at = now_rfc3339()
    await emit_event(
        db,
        home_stream_id=meta_stream_id,
        body=build_user_joined_body(
            workspace_id=ctx.workspace_id,
            stream_id=meta_stream_id,
            author_user_id=bot_user_id,
            author_device_id=device.device_id,
            client_created_at=authored_at,
            user_id=bot_user_id,
            display_name=name,
        ),
    )
    await emit_event(
        db,
        home_stream_id=meta_stream_id,
        body=build_bot_installed_body(
            workspace_id=ctx.workspace_id,
            stream_id=meta_stream_id,
            author_user_id=ctx.user_id,
            author_device_id=ctx.device_id,
            client_created_at=authored_at,
            bot_user_id=bot_user_id,
            name=name,
            scopes=list(scopes),
        ),
    )

    # Step 4 — event-sourced grants (§2.2 homing per channel visibility).
    for channel in channels:
        await emit_event(
            db,
            home_stream_id=_membership_home(channel, meta_stream_id),
            body=build_channel_member_added_body(
                workspace_id=ctx.workspace_id,
                stream_id=_membership_home(channel, meta_stream_id),
                author_user_id=ctx.user_id,
                author_device_id=ctx.device_id,
                client_created_at=now_rfc3339(),
                channel_stream_id=channel.stream_id,
                user_id=bot_user_id,
            ),
        )

    return bot, device


@router.get("/bots", response_model=BotListResponse)
async def list_bots(ctx: PluginsAuth, db: DbSession) -> BotListResponse:
    """List the workspace's bots (incl. deactivated) with grants + token HANDLES.

    Token ``id``s are sha256 hashes (revoke handles, the invites-list
    precedent) — the raw token was returned exactly once at mint and is never
    persisted, so there is nothing here to leak. Workspace-scoped.
    """
    bots = (
        (
            await db.execute(
                select(User)
                .where(User.workspace_id == ctx.workspace_id, User.is_bot.is_(True))
                .order_by(User.display_name, User.user_id)
            )
        )
        .scalars()
        .all()
    )
    return BotListResponse(bots=[await _bot_info(db, bot) for bot in bots])


@router.post("/bots/{bot_user_id}/tokens", response_model=BotTokenMintResponse, status_code=201)
async def mint_bot_token(
    bot_user_id: str, req: MintBotTokenRequest, ctx: PluginsAuth, db: DbSession
) -> BotTokenMintResponse:
    """Mint a scoped bot bearer token; return the RAW token exactly once.

    Mirrors ``create_invite`` (D7/D2): the raw 256-bit token appears only in
    this response; only its sha256 hex is stored. ``scopes`` omitted → the
    bot's install scopes (see ``_install_scopes``). A DEACTIVATED bot is
    refused 403 — no fresh credentials for a disabled principal (they would
    401 anyway, but issuing them at all is bad hygiene).
    """
    bot = await _load_bot(db, ctx=ctx, bot_user_id=bot_user_id)
    if bot.deactivated_at is not None:
        raise problems.forbidden("bot is deactivated")

    scopes: list[Scope] = (
        sorted(set(req.scopes))
        if req.scopes is not None
        else await _install_scopes(db, ctx=ctx, bot_user_id=bot_user_id)
    )

    token, raw = await create_bot_token(
        db,
        bot_user_id=bot_user_id,
        workspace_id=ctx.workspace_id,
        scopes=list(scopes),
        created_by=ctx.user_id,
    )
    await db.commit()
    return BotTokenMintResponse(
        token=raw,
        id=token.token_hash,
        bot_user_id=bot_user_id,
        scopes=scopes,
        created_at=token.created_at,
    )


@router.delete("/bots/{bot_user_id}/tokens/{token_id}", status_code=204)
async def revoke_bot_token(
    bot_user_id: str, token_id: str, ctx: PluginsAuth, db: DbSession
) -> None:
    """Revoke one bot token by its hash handle — instant, uniform 404 (D13).

    ``UPDATE ... SET revoked_at = now() WHERE token_hash = :id AND bot_user_id
    = :bot AND workspace_id = :ws AND revoked_at IS NULL RETURNING``. No row →
    the uniform ``not_found``: an unknown handle, a cross-workspace token, a
    token under a DIFFERENT bot than the path names, and an already-revoked one
    all return the IDENTICAL body. The row survives as a tombstone (auditable
    ``revoked_at``); ``require_auth`` 401s it on its very next request.
    """
    revoked = await db.execute(
        update(BotToken)
        .where(
            BotToken.token_hash == token_id,
            BotToken.bot_user_id == bot_user_id,
            BotToken.workspace_id == ctx.workspace_id,
            BotToken.revoked_at.is_(None),
        )
        .values(revoked_at=func.now())
        .returning(BotToken.token_hash)
    )
    if revoked.first() is None:
        raise problems.not_found(_NO_SUCH_TOKEN)
    await db.commit()


@router.put("/bots/{bot_user_id}/streams/{stream_id}", status_code=204)
async def grant_bot_stream(
    bot_user_id: str, stream_id: str, ctx: PluginsAuth, db: DbSession
) -> None:
    """Grant the bot access to a channel via a ``channel.member_added`` event.

    Event-sourced membership (§2.2): the emitted event is §2.2-homed (public →
    workspace-meta; private → the channel's own stream) and its reducer inserts
    the ``stream_members`` row in the same transaction — the bot's guest
    predicate picks it up on its very next query. Idempotent: re-granting emits
    another event whose reducer is an ``ON CONFLICT DO NOTHING`` no-op. Uniform
    404 for an unknown/cross-workspace bot or a non-channel/cross-workspace
    stream.
    """
    bot = await _load_bot(db, ctx=ctx, bot_user_id=bot_user_id)
    channel = await _resolve_channel(db, ctx=ctx, stream_id=stream_id)
    meta_stream_id = await _meta_stream_id(db, ctx.workspace_id)
    home = _membership_home(channel, meta_stream_id)
    await emit_event(
        db,
        home_stream_id=home,
        body=build_channel_member_added_body(
            workspace_id=ctx.workspace_id,
            stream_id=home,
            author_user_id=ctx.user_id,
            author_device_id=ctx.device_id,
            client_created_at=now_rfc3339(),
            channel_stream_id=channel.stream_id,
            user_id=bot.user_id,
        ),
    )
    await db.commit()


@router.delete("/bots/{bot_user_id}/streams/{stream_id}", status_code=204)
async def revoke_bot_stream(
    bot_user_id: str, stream_id: str, ctx: PluginsAuth, db: DbSession
) -> None:
    """Revoke the bot's access to a channel via ``channel.member_removed``.

    The reducer deletes the ``stream_members`` row in this transaction, and the
    guest predicate's live ``EXISTS`` cuts the bot's read/write access on its
    very next query (D13 — removal is immediate). Idempotent like the grant.
    """
    bot = await _load_bot(db, ctx=ctx, bot_user_id=bot_user_id)
    channel = await _resolve_channel(db, ctx=ctx, stream_id=stream_id)
    meta_stream_id = await _meta_stream_id(db, ctx.workspace_id)
    home = _membership_home(channel, meta_stream_id)
    await emit_event(
        db,
        home_stream_id=home,
        body=build_channel_member_removed_body(
            workspace_id=ctx.workspace_id,
            stream_id=home,
            author_user_id=ctx.user_id,
            author_device_id=ctx.device_id,
            client_created_at=now_rfc3339(),
            channel_stream_id=channel.stream_id,
            user_id=bot.user_id,
        ),
    )
    await db.commit()


# --- incoming webhooks (ENG-161, M5-2) -----------------------------------------


@router.post("/hooks", response_model=HookCreateResponse, status_code=201)
async def create_hook(
    req: CreateHookRequest, request: Request, ctx: PluginsAuth, db: DbSession
) -> HookCreateResponse:
    """Register an incoming webhook; return the capability URL exactly once.

    One transaction, in order:

    1. Resolve the target as a grantable CHANNEL in the caller's workspace
       (uniform 404 for unknown/cross-workspace/DM/meta ids — the
       ``_resolve_channel`` kind gate, before any write).
    2. Pin the author bot. ``bot_user_id`` given → resolve it (uniform 404;
       403 if deactivated — no new capability for a disabled principal, the
       mint-token rule) and ensure a ``stream_members`` grant for the target
       channel exists, emitting the event-sourced ``channel.member_added`` if
       not. Omitted → auto-provision a bot named for the hook through the
       SAME M5-1 creation path (``user.joined`` + ``bot.installed`` with
       install scope ``events:write`` + the channel grant).
    3. Mint the raw capability token (D2): store ONLY ``hash_token(raw)``;
       embed the raw in the returned URL — the one and only time it exists
       outside the caller's hands. The URL base is derived from the request
       exactly as ``create_invite`` builds the join URL (the ENG-154
       Host-header caveat applies identically and is solved by the same
       deployment guidance).
    """
    channel = await _resolve_channel(db, ctx=ctx, stream_id=req.stream_id)
    meta_stream_id = await _meta_stream_id(db, ctx.workspace_id)

    if req.bot_user_id is not None:
        bot = await _load_bot(db, ctx=ctx, bot_user_id=req.bot_user_id)
        if bot.deactivated_at is not None:
            raise problems.forbidden("bot is deactivated")
        member = await db.get(StreamMember, (channel.stream_id, bot.user_id))
        if member is None:
            home = _membership_home(channel, meta_stream_id)
            await emit_event(
                db,
                home_stream_id=home,
                body=build_channel_member_added_body(
                    workspace_id=ctx.workspace_id,
                    stream_id=home,
                    author_user_id=ctx.user_id,
                    author_device_id=ctx.device_id,
                    client_created_at=now_rfc3339(),
                    channel_stream_id=channel.stream_id,
                    user_id=bot.user_id,
                ),
            )
    else:
        # Auto-provision: a dedicated bot named for the hook, whose only verb
        # is writing events (a hook never reads anything).
        bot, _device = await _provision_bot_identity(
            db,
            ctx=ctx,
            name=req.name,
            scopes=["events:write"],
            channels=[channel],
            meta_stream_id=meta_stream_id,
        )

    raw, token_hash = mint_token()
    hook = IncomingWebhook(
        token_hash=token_hash,
        workspace_id=ctx.workspace_id,
        stream_id=channel.stream_id,
        bot_user_id=bot.user_id,
        name=req.name,
        created_by=ctx.user_id,
        created_at=utcnow(),
    )
    db.add(hook)
    await db.commit()

    # Base-URL derivation mirrors create_invite (incl. the ENG-154 caveat).
    host = request.headers.get("host") or (
        request.url.netloc if request.url.netloc else "localhost"
    )
    url = f"{request.url.scheme}://{host}/v1/hooks/{raw}"
    return HookCreateResponse(
        url=url,
        id=token_hash,
        stream_id=channel.stream_id,
        bot_user_id=bot.user_id,
        name=req.name,
        created_at=hook.created_at,
    )


@router.get("/hooks", response_model=HookListResponse)
async def list_hooks(ctx: PluginsAuth, db: DbSession) -> HookListResponse:
    """List the workspace's hooks by hash HANDLE — the capability URL never again.

    ``id`` is the sha256 ``token_hash`` (the revoke handle, the invites-list
    precedent) — the raw token was embedded in the create-time URL exactly once
    and never persisted, so there is nothing here to leak. Workspace-scoped.
    """
    rows = await db.execute(
        select(IncomingWebhook)
        .where(IncomingWebhook.workspace_id == ctx.workspace_id)
        .order_by(IncomingWebhook.created_at, IncomingWebhook.token_hash)
    )
    return HookListResponse(
        hooks=[
            HookInfo(
                id=hook.token_hash,
                stream_id=hook.stream_id,
                bot_user_id=hook.bot_user_id,
                name=hook.name,
                created_by=hook.created_by,
                created_at=hook.created_at,
                disabled=hook.disabled_at is not None,
            )
            for hook in rows.scalars()
        ]
    )


@router.delete("/hooks/{hook_id}", status_code=204)
async def revoke_hook(hook_id: str, ctx: PluginsAuth, db: DbSession) -> None:
    """Revoke a hook by its hash handle — HARD delete, uniform 404 (D13).

    ``DELETE ... WHERE token_hash = :id AND workspace_id = :ws RETURNING``. No
    row → the uniform ``not_found``: an unknown handle, a cross-workspace hook,
    and an already-revoked one all return the IDENTICAL body. The delete is
    HARD (the invites discipline) — a subsequent ``POST /v1/hooks/<raw>`` then
    misses the lookup and returns the same uniform 404 as a never-existed
    token, so revocation is indistinguishable from "never existed".
    """
    deleted = await db.execute(
        delete(IncomingWebhook)
        .where(
            IncomingWebhook.token_hash == hook_id,
            IncomingWebhook.workspace_id == ctx.workspace_id,
        )
        .returning(IncomingWebhook.token_hash)
    )
    if deleted.first() is None:
        raise problems.not_found(_NO_SUCH_HOOK)
    await db.commit()
