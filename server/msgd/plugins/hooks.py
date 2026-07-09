"""``POST /v1/hooks/{hook_token}`` — the public incoming-webhook receiver (ENG-161, §10).

This is msg's ONE unauthenticated write surface: the path token IS the
credential (a capability URL). Every design decision below exists to keep that
surface airtight:

* **Rate limit BEFORE any DB work** (a dependency, so it runs before the
  handler body): a per-hook bucket keyed by the sha256 of the path token AND a
  per-client-IP bucket. An unknown-token flood from one host is 429'd without
  a single query.
* **Uniform 404** (D13): an unknown token, a disabled hook (``disabled_at``),
  a deactivated bot, and an archived target stream ALL return the byte-
  identical ``not_found`` — no oracle distinguishes revoked vs disabled vs
  never-existed, and the endpoint never answers 401/403 (there is no
  credential family to disclose).
* **Body cap before parse**: a streaming cap-and-abort read (the batch-router
  F3 pattern) 413s the instant the body crosses ``hook_max_body_bytes``
  (16 KB default — well under the 64 KB event cap, so an accepted body can
  never fail the pipeline for size).
* **The payload controls ONLY the text bytes** (the injection guard): the
  ``message.created`` body is built SERVER-SIDE via
  ``build_message_created_body`` with ``author_user_id``/``author_device_id``
  = the hook's pinned bot, ``stream_id`` = the hook's pinned channel,
  ``format="plain"``, ``mentions=[]``, ``file_ids=[]``, no ``thread_root_id``
  — all HARD-CODED, never read from the payload. A delivery cannot mention,
  attach, thread, re-target, spoof authorship, or inject markdown.
* **The SAME validated write path as every client upload**:
  :func:`msgd.events.write.store_event` runs the full §3.2 pipeline under the
  bot's synthesized :class:`AuthContext` — author binding, ``can_write``
  (live ``stream_members`` membership), the archived-write gate, the payload
  schema gate, the hash, and the size cap all re-apply, so revoking the bot's
  channel grant or archiving the channel cuts a live hook mid-flight. There
  is deliberately NO bare ``emit_event`` here.
"""

from __future__ import annotations

import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.api.deps import AppSettings, get_app_settings
from msgd.api.problems import ProblemException
from msgd.api.schemas.events import RejectedEvent
from msgd.auth.context import AuthContext
from msgd.auth.ratelimit import RateLimiter, client_ip
from msgd.auth.tokens import hash_token
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.engine import get_session
from msgd.db.models import Device, IncomingWebhook, Stream, User
from msgd.events.write import store_event

__all__ = ["router"]

router = APIRouter(prefix="/v1/hooks", tags=["hooks"])

DbSession = Annotated[AsyncSession, Depends(get_session)]

#: The ONE detail every unusable-hook outcome returns (D13 non-disclosure):
#: unknown token, disabled hook, deactivated bot, archived/gone stream, and a
#: mid-flight membership revoke all collapse to this identical body.
_NO_SUCH_HOOK = "no such hook"


class HookAck(BaseModel):
    """The Slack-compatible success acknowledgement."""

    ok: bool = True


def _payload_too_large(limit: int) -> ProblemException:
    """413: the request body crossed ``hook_max_body_bytes`` (before parsing)."""
    return ProblemException(
        status=413,
        type="/problems/payload-too-large",
        title="Request body too large",
        detail=f"request body exceeds the {limit}-byte incoming-webhook limit",
    )


def _invalid_payload(detail: str) -> ProblemException:
    """400: the delivery payload is malformed (missing/empty text, bad JSON)."""
    return ProblemException(
        status=400,
        type="/problems/invalid-hook-payload",
        title="Invalid webhook payload",
        detail=detail,
    )


def get_hook_limiters(request: Request) -> tuple[RateLimiter, RateLimiter]:
    """Return the (per-hook, per-IP) hook limiters (app.state, ENG-161)."""
    per_hook: RateLimiter = request.app.state.hook_limiter_minute
    per_ip: RateLimiter = request.app.state.hook_ip_limiter_minute
    return per_hook, per_ip


async def hook_rate_limit(hook_token: str, request: Request) -> None:
    """Rate-limit a delivery BEFORE any DB work (it is a dependency, so it runs
    before the handler body opens a session or touches a table).

    Two buckets, both checked (the auth-limiter D6 pattern): per HOOK — keyed by
    ``hash_token(path_token)`` so the raw capability token is never retained in
    limiter state — and per client IP (``trust_proxy`` semantics as everywhere
    else). The per-IP bucket is what stops an unknown-token flood from one host:
    the 429 fires without a single lookup, so guessing tokens cannot hammer the
    DB. The first exceeded bucket raises 429 with ``Retry-After``.
    """
    settings = get_app_settings(request)
    per_hook, per_ip = get_hook_limiters(request)
    checks = (
        (per_hook, f"hook:{hash_token(hook_token)}"),
        (per_ip, f"ip:{client_ip(request, trust_proxy=settings.trust_proxy)}"),
    )
    for limiter, key in checks:
        result = limiter.check(key)
        if not result.allowed:
            raise problems.rate_limited(result.retry_after)


async def _read_body_capped(request: Request, limit: int) -> bytes:
    """Read the body, 413ing the moment it exceeds ``limit`` (the F3 pattern).

    Streams chunks and aborts on the running total rather than buffering the
    whole body and measuring after — an oversized (possibly Content-Length-less)
    chunked delivery cannot force unbounded buffering, and the cap fires BEFORE
    any JSON parsing.
    """
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise _payload_too_large(limit)
        chunks.append(chunk)
    return b"".join(chunks)


def _flatten_blocks(blocks: Any) -> str:
    """Flatten the MINIMAL supported ``blocks`` subset to plain text.

    Only ``{"type": "section", "text": {"text": <str>}}`` contributes (the
    de-facto-standard shape); every other block type — and every malformed
    entry — is IGNORED, never an error (§10: "text + a small supported
    subset"). The result is the section texts joined by newlines. Nothing
    here is interpreted: the flattened string becomes ``format="plain"``
    message text, so mrkdwn syntax inside arrives as inert characters.
    """
    if not isinstance(blocks, list):
        return ""
    parts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "section":
            continue
        text_obj = block.get("text")
        if not isinstance(text_obj, dict):
            continue
        text = text_obj.get("text")
        if isinstance(text, str) and text:
            parts.append(text)
    return "\n".join(parts)


def _effective_text(data: dict[str, Any]) -> str:
    """The message text of a delivery: flattened ``blocks`` if any, else ``text``.

    Mirrors the de-facto semantics (``blocks`` render; ``text`` is the
    fallback). A delivery must yield NON-EMPTY text one way or the other —
    anything else is a 400. Every other key in the payload is ignored by
    construction: this function is the ONLY reader of the parsed body, and it
    returns nothing but a string.
    """
    block_text = _flatten_blocks(data.get("blocks"))
    if block_text:
        return block_text
    text = data.get("text")
    if isinstance(text, str) and text.strip():
        return text
    raise _invalid_payload("payload must carry non-empty text (or section blocks)")


@router.post(
    "/{hook_token}",
    response_model=HookAck,
    # The rate limit is a DEPENDENCY so it runs before the handler body — i.e.
    # before any DB session work. No auth dependency: the token is the capability.
    dependencies=[Depends(hook_rate_limit)],
)
async def receive_hook(
    hook_token: str, request: Request, db: DbSession, settings: AppSettings
) -> HookAck:
    """Turn one external delivery into ONE validated ``message.created``.

    Order (each step's rationale in the module docstring): lookup → uniform
    404; capped body read → 413; parse + text extraction → 400; server-built
    body; the shared ``store_event`` pipeline → 200 ``{"ok": true}``.
    """
    # --- resolve the capability: uniform 404 for EVERY unusable shape ---------
    row = (
        await db.execute(
            select(IncomingWebhook, User, Stream)
            .join(User, IncomingWebhook.bot_user_id == User.user_id)
            .join(Stream, IncomingWebhook.stream_id == Stream.stream_id)
            .where(IncomingWebhook.token_hash == hash_token(hook_token))
        )
    ).first()
    if row is None:
        raise problems.not_found(_NO_SUCH_HOOK)
    hook, bot, stream = row[0], row[1], row[2]
    if (
        hook.disabled_at is not None
        or bot.deactivated_at is not None
        or stream.archived_at is not None
    ):
        raise problems.not_found(_NO_SUCH_HOOK)

    # --- body cap (before parse), then parse -----------------------------------
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > settings.hook_max_body_bytes:
                raise _payload_too_large(settings.hook_max_body_bytes)
        except ValueError:
            pass  # unparseable header — the streaming guard below is authoritative
    raw = await _read_body_capped(request, settings.hook_max_body_bytes)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise _invalid_payload("request body is not valid JSON") from None
    if not isinstance(data, dict):
        raise _invalid_payload("request body must be a JSON object")
    text = _effective_text(data)

    # --- server-built message: the payload controlled ONLY the text bytes ------
    device = (
        await db.execute(
            select(Device)
            .where(Device.user_id == bot.user_id)
            .order_by(Device.created_at, Device.device_id)
            .limit(1)
        )
    ).scalar()
    if device is None:
        # Schema-impossible for a provisioned bot; fold into the uniform 404
        # rather than 500 on a corrupt row.
        raise problems.not_found(_NO_SUCH_HOOK)

    # HARD-CODED injection guards: author = the hook's bot, stream = the hook's
    # channel, plain format, no mentions, no files, no thread. NEVER derived
    # from the delivery payload.
    body = build_message_created_body(
        workspace_id=hook.workspace_id,
        stream_id=hook.stream_id,
        author_user_id=hook.bot_user_id,
        author_device_id=device.device_id,
        client_created_at=now_rfc3339(),
        text=text,
        format="plain",
        thread_root_id=None,
        file_ids=[],
        mentions=[],
    ).model_dump(mode="json")

    # The bot's synthesized principal: the SAME context shape a bot token
    # yields, so the pipeline's step-ii author binding pins the event to
    # exactly this bot + device. ``session_token_hash`` carries the hook's
    # hash (a handle, never a credential); the capability's only verb is
    # writing events.
    bot_ctx = AuthContext(
        user_id=bot.user_id,
        workspace_id=bot.workspace_id,
        role=bot.role,
        device_id=device.device_id,
        session_token_hash=hook.token_hash,
        user=bot,
        device=device,
        session=None,
        scopes=frozenset({"events:write"}),
    )

    # --- the ONE shared validated write path (never a bare emit_event) ---------
    item = {"body": body, "event_hash": hash_event(body)}
    outcome = await store_event(db, ctx=bot_ctx, item=item)
    if isinstance(outcome, RejectedEvent):
        if outcome.code == "permission_denied":
            # The live gates cut the hook mid-flight (membership revoked, or a
            # race with archival/deactivation after the snapshot above): the
            # SAME uniform 404 as an unusable hook — never a distinct signal.
            raise problems.not_found(_NO_SUCH_HOOK)
        # Any other reject is a payload fault the pipeline caught that the
        # entry checks did not (e.g. text that is not storable). Generic 400 —
        # no pipeline internals are echoed to the anonymous caller.
        raise _invalid_payload("payload could not be accepted")
    return HookAck()
