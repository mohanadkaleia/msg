"""Plugins request/response schemas (ENG-159, M5-1): bots + bot tokens.

This is a CREDENTIAL-ISSUANCE surface, so the boundary is locked structurally:

* ``Scope`` is a Literal over the CLOSED §10 verb vocabulary
  (:data:`msgd.auth.bot_tokens.KNOWN_SCOPES`) — an unknown scope string is a
  422 at the boundary and can never be minted into a credential.
* The RAW bot token appears in exactly ONE response model
  (:class:`BotTokenMintResponse.token`) exactly once, at mint time — the
  ``create_invite`` discipline. Everywhere else a token is its sha256
  ``token_hash`` handle (:class:`BotTokenInfo.id`) — irreversible, usable only
  to revoke (the sessions-list / invites-list precedent).
* :class:`CreateBotRequest` deliberately has NO role field: a bot is always a
  ``guest`` (its access = explicit ``stream_members`` grants, §3.6), and the
  admin PATCH refuses to change a bot's role — so a bot can never be widened
  into a role-based read of workspace-meta/public channels.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

__all__ = [
    "Scope",
    "CreateBotRequest",
    "MintBotTokenRequest",
    "BotTokenMintResponse",
    "BotTokenInfo",
    "BotInfo",
    "BotListResponse",
    "CreateHookRequest",
    "HookCreateResponse",
    "HookInfo",
    "HookListResponse",
]

#: The closed §10 verb-scope vocabulary — mirrors ``msgd.auth.bot_tokens.KNOWN_SCOPES``.
Scope = Literal["events:read", "events:write", "files:write"]

BotName = Annotated[str, Field(min_length=1, max_length=200)]


class CreateBotRequest(BaseModel):
    """POST /v1/plugins/bots — provision a bot identity (NO credential is minted).

    ``scopes`` are the bot's INSTALL scopes: recorded in the ``bot.installed``
    meta event and used as the default for later token mints. ``stream_ids``
    are the channels the bot is granted at install (each becomes a
    ``channel.member_added`` event → ``stream_members`` row).
    """

    name: BotName
    scopes: list[Scope]
    stream_ids: list[str] = Field(default_factory=list)


class MintBotTokenRequest(BaseModel):
    """POST /v1/plugins/bots/{bot_user_id}/tokens — mint a scoped credential.

    ``scopes`` omitted/None → the token inherits the bot's install scopes (from
    its ``bot.installed`` event). An explicit list narrows or widens within the
    closed vocabulary — issuing is owner/admin-gated either way.
    """

    scopes: list[Scope] | None = None


class BotTokenMintResponse(BaseModel):
    """The mint response — the ONLY place the raw bot token ever appears.

    ``token`` is returned exactly once and never persisted (only its sha256
    ``token_hash`` — echoed here as ``id``, the future revoke handle — is
    stored).
    """

    token: str
    id: str
    bot_user_id: str
    scopes: list[Scope]
    created_at: datetime


class BotTokenInfo(BaseModel):
    """One bot token in the listing. ``id`` is the sha256 ``token_hash`` handle."""

    id: str
    scopes: list[str]
    created_at: datetime
    last_used_at: datetime | None
    revoked: bool


class BotInfo(BaseModel):
    """One bot in GET /v1/plugins/bots (and the create response).

    ``device_id`` is the bot's single provisioned device — a bot client needs it
    to author event bodies (``author_device_id`` is validated against the
    credential at upload, §3.2 step ii). ``stream_ids`` are the current
    ``stream_members`` grants; ``tokens`` lists hash handles only (never raw).
    """

    bot_user_id: str
    name: str
    device_id: str
    role: str
    deactivated: bool
    stream_ids: list[str]
    tokens: list[BotTokenInfo]


class BotListResponse(BaseModel):
    bots: list[BotInfo]


class CreateHookRequest(BaseModel):
    """POST /v1/plugins/hooks — register an incoming webhook (ENG-161, §10).

    ``stream_id`` names the ONE channel every delivery will post into and
    ``bot_user_id`` the ONE bot that will author it — both are pinned in the
    ``incoming_webhooks`` row at create time; the external payload can never
    move either. ``bot_user_id`` omitted → a dedicated bot named for the hook
    is auto-provisioned (the M5-1 creation path, install scope
    ``events:write``).
    """

    stream_id: str
    name: BotName
    bot_user_id: str | None = None


class HookCreateResponse(BaseModel):
    """The create response — the ONLY place the capability URL ever appears.

    ``url`` embeds the raw path token exactly once (the ``create_invite``
    discipline); only its sha256 — echoed here as ``id``, the revoke handle —
    is stored. ``GET /v1/plugins/hooks`` never returns it again.
    """

    url: str
    id: str
    stream_id: str
    bot_user_id: str
    name: str
    created_at: datetime


class HookInfo(BaseModel):
    """One hook in GET /v1/plugins/hooks. ``id`` is the sha256 hash handle."""

    id: str
    stream_id: str
    bot_user_id: str
    name: str
    created_by: str
    created_at: datetime
    disabled: bool


class HookListResponse(BaseModel):
    hooks: list[HookInfo]
