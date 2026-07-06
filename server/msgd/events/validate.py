"""Per-event validation pipeline for ``POST /v1/events/batch`` (TDD §3.2, ENG-66).

:func:`validate_event` runs the §3.2 checks over one raw upload item and returns
an :class:`Accepted` / :class:`Rejected` outcome. It performs **reads only**
(permission predicate + existence queries); all mutation (``emit_event``) and the
per-event commit happen in the router (D6), so a rejected item never opens a
transaction.

The step order is **locked by §3.2** and load-bearing:

    0. item shape         -> invalid_schema
    ii. workspace + author binding matches the session -> permission_denied
    iii. stream write permission (+ archived-write gate) -> permission_denied
    iv. envelope schema gate, then known-type payload gate -> invalid_schema
    v. hash recompute over the RAW dict -> hash_mismatch (JCS out-of-domain ->
       invalid_schema)
    vi. referential (genesis collision / §2.2 homing / lifecycle existence)
    vii. 64 KB single-event wire-form cap -> payload_too_large

Two rulings baked in here:

* **Raw-faithful hashing (ENG-56):** ``raw_body = item["body"]`` is captured
  verbatim and is the *sole* input to ``hash_event``. The step-iv envelope check
  uses :meth:`Body.model_validate` as a **gate only** — it builds a throwaway
  model to validate required fields + id formats and is discarded; because it
  never mutates ``raw_body``, hashing ``raw_body`` afterward is byte-faithful to
  what the client sent. Lax scalar coercion (``"type_version":"1"`` -> ``1``)
  touches only the throwaway model. We call ``hash_event`` directly, **never**
  ``verify_hash`` — so ``verify_hash``'s server-minted redaction exemption is
  unreachable on the upload path, and a client that smuggles
  ``server.payload_redacted`` cannot waive its own hash check (``item["server"]``
  is never even read).

* **Unknown-type write gate (D9, flagged):** ``can_write`` default-denies any
  type it does not recognize, which would wrongly reject D9 unknown types. So
  known types go through ``can_write`` and **unknown types are gated on read /
  membership access via ``can_read``** instead. Subtle — see ``_WRITE_MATRIX_TYPES``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api.schemas.events import RejectionCode
from msgd.auth.context import AuthContext
from msgd.core.envelope import MAX_EVENT_SIZE_BYTES, Body
from msgd.core.hashing import hash_event
from msgd.core.jcs import JCSError
from msgd.core.payloads import get_payload_model
from msgd.db.models import Stream
from msgd.events.permissions import can_read, can_write

__all__ = ["Accepted", "Rejected", "validate_event"]

#: The event types :func:`msgd.events.permissions.can_write` recognizes (its M1
#: write matrix). A type here is gated by ``can_write``; anything else is a D9
#: unknown type, gated by ``can_read`` (membership) — see the module docstring.
_WRITE_MATRIX_TYPES = frozenset(
    {
        "message.created",
        "channel.created",
        "channel.renamed",
        "channel.archived",
        "channel.member_added",
        "channel.member_removed",
        "dm.created",
    }
)

#: Lifecycle events whose ``payload.channel_stream_id`` must reference an existing
#: stream — the one non-confidential ``unknown_stream`` producer (D5 vi / D13-safe:
#: only owner/admin reach here, and channel existence is not secret from admins).
_LIFECYCLE_TYPES = frozenset(
    {
        "channel.renamed",
        "channel.archived",
        "channel.member_added",
        "channel.member_removed",
    }
)

#: Uniform detail for the "stream absent OR forbidden" reject — existence is not
#: disclosed (D13 non-disclosure). The adversary test asserts an identical
#: code+detail for a forbidden existing stream vs. a non-existent one, so this
#: string must NOT vary with which case occurred.
_STREAM_DENIED_DETAIL = "not permitted to write to this stream"


@dataclass
class Accepted:
    """The item passed every §3.2 check; the router emits + commits it."""

    home_stream_id: str
    raw_body: dict[str, Any]


@dataclass
class Rejected:
    """The item failed a §3.2 check; the router shapes it into ``rejected[]``."""

    event_id: str
    code: RejectionCode
    detail: str


def _best_effort_event_id(raw_body: Any) -> str:
    """The item's ``event_id`` for reject shaping, or ``""`` if unreadable."""
    if isinstance(raw_body, dict):
        value = raw_body.get("event_id")
        if isinstance(value, str):
            return value
    return ""


async def _workspace_meta_stream_id(db: AsyncSession, workspace_id: str) -> str | None:
    """The single ``workspace-meta`` stream id for ``workspace_id`` (or ``None``)."""
    stream_id: str | None = await db.scalar(
        select(Stream.stream_id).where(
            Stream.workspace_id == workspace_id,
            Stream.kind == "workspace-meta",
        )
    )
    return stream_id


async def _stream_exists(db: AsyncSession, stream_id: str) -> bool:
    """True iff a ``streams`` row with ``stream_id`` exists (ANY workspace).

    Deliberately GLOBAL, and only used by the genesis-collision check — see the
    load-bearing comment pair in :func:`_check_referential`. A workspace-scoped
    variant here would let a genesis event adopt an id that already exists in
    another tenant. Lifecycle resolution is workspace-scoped instead, via
    :func:`_resolve_channel_in_workspace`.
    """
    found = await db.scalar(select(Stream.stream_id).where(Stream.stream_id == stream_id))
    return found is not None


async def _resolve_channel_in_workspace(
    db: AsyncSession, *, stream_id: str, workspace_id: str
) -> tuple[str, str | None] | None:
    """Resolve a lifecycle target stream WITHIN ``workspace_id`` (F1, cross-tenant).

    Returns ``(kind, visibility)`` for a row whose ``stream_id`` AND
    ``workspace_id`` match, else ``None``. Scoping to ``workspace_id`` makes the
    lifecycle referential check tenant-isolating and non-disclosing: a stream id
    from another workspace resolves to ``None`` exactly like a never-existed id,
    so it produces the identical ``unknown_stream`` outcome (no cross-tenant
    existence oracle).
    """
    row = (
        await db.execute(
            select(Stream.kind, Stream.visibility).where(
                Stream.stream_id == stream_id,
                Stream.workspace_id == workspace_id,
            )
        )
    ).first()
    if row is None:
        return None
    return row[0], row[1]


async def validate_event(db: AsyncSession, *, ctx: AuthContext, item: Any) -> Accepted | Rejected:
    """Run the §3.2 read-only validation pipeline over one raw upload ``item``.

    Returns :class:`Accepted` (the router then emits + commits) or
    :class:`Rejected` (shaped into ``rejected[]``). Never mutates ``item`` /
    ``raw_body`` and never commits.
    """
    # --- step 0: item shape ---------------------------------------------------
    # Only ``body`` and ``event_hash`` are ever read; any ``item["server"]`` /
    # ``item["signature"]`` / extra keys are ignored — point-3 smuggling is inert
    # by construction (they never touch acceptance, the hash, or storage).
    if not isinstance(item, dict):
        return Rejected(
            event_id="",
            code="invalid_schema",
            detail="event item must be a JSON object",
        )
    raw_body = item.get("body")
    raw_hash = item.get("event_hash")
    if not isinstance(raw_body, dict) or not isinstance(raw_hash, str):
        return Rejected(
            event_id=_best_effort_event_id(raw_body),
            code="invalid_schema",
            detail="event item must be {body: object, event_hash: string}",
        )
    event_id = _best_effort_event_id(raw_body)

    # --- step ii: workspace membership + author binding (folded per §3.2) ------
    # The identity group is checked BEFORE schema (locked order): a body whose
    # author/workspace fields do not match the session is permission_denied,
    # regardless of whether the rest of the body would validate.
    if (
        raw_body.get("workspace_id") != ctx.workspace_id
        or raw_body.get("author_user_id") != ctx.user_id
        or raw_body.get("author_device_id") != ctx.device_id
    ):
        return Rejected(
            event_id=event_id,
            code="permission_denied",
            detail="author/workspace fields must match the session",
        )

    # --- step iii: stream write permission (+ archived-write gate) ------------
    # ``stream_id`` / ``type`` are still raw here (the envelope gate is step iv);
    # coerce missing/mistyped values to "" so the permission query cannot match a
    # real stream (-> permission_denied, uniform non-disclosure). ``can_write`` is
    # checked BEFORE the Body gate (locked §3.2 order).
    sid = raw_body.get("stream_id")
    sid = sid if isinstance(sid, str) else ""
    event_type = raw_body.get("type")
    event_type = event_type if isinstance(event_type, str) else ""

    if event_type in _WRITE_MATRIX_TYPES:
        allowed = await can_write(db, ctx=ctx, stream_id=sid, event_type=event_type)
    else:
        # D9 unknown type: ``can_write`` default-denies it, so gate on read /
        # membership access instead (the flagged split — see the module docstring).
        allowed = await can_read(db, ctx=ctx, stream_id=sid)
    if not allowed:
        return Rejected(
            event_id=event_id,
            code="permission_denied",
            detail=_STREAM_DENIED_DETAIL,
        )

    # Archived-write gate (obligation b): ``can_write`` does not consult
    # ``archived_at``, so ENG-66 adds a minimal local check for ``message.created``.
    # FLAGGED: local duplication (does not edit permissions.py); fold into
    # ``can_write`` later. Applies to message.created in M1.
    if event_type == "message.created":
        archived_at = await db.scalar(select(Stream.archived_at).where(Stream.stream_id == sid))
        if archived_at is not None:
            return Rejected(
                event_id=event_id,
                code="permission_denied",
                detail="stream is archived",
            )

    # --- step iv: schema (envelope gate, then known-type payload gate) --------
    # GATE ONLY: the throwaway model validates required fields + id formats and is
    # discarded; ``raw_body`` (never a model_dump) stays the hash/storage source.
    try:
        body_model = Body.model_validate(raw_body)
    except ValidationError:
        return Rejected(
            event_id=event_id,
            code="invalid_schema",
            detail="event body failed envelope validation",
        )

    # Known ``(type, type_version)`` -> validate the payload; unknown type OR
    # unknown version -> ``None`` -> skip payload validation and accept (D9). Keyed
    # by the coerced int version so a known type is always payload-checked.
    payload_model = get_payload_model(body_model.type, body_model.type_version)
    if payload_model is not None:
        try:
            payload_model.model_validate(raw_body["payload"])
        except ValidationError:
            return Rejected(
                event_id=event_id,
                code="invalid_schema",
                detail="event payload failed schema validation",
            )

    # --- step v: hash recompute over the RAW dict -----------------------------
    # ``hash_event`` — never ``verify_hash`` (redaction exemption unreachable).
    try:
        computed_hash = hash_event(raw_body)
    except JCSError:
        # Out-of-domain body (non-finite float, over-cap int, over-depth): the
        # body is un-hashable / protocol-invalid, so invalid_schema — hash_mismatch
        # is reserved strictly for "hashed fine but != supplied".
        return Rejected(
            event_id=event_id,
            code="invalid_schema",
            detail="event body is not canonicalizable",
        )
    if computed_hash != raw_hash:
        return Rejected(
            event_id=event_id,
            code="hash_mismatch",
            detail="event_hash does not match the event body",
        )

    # --- storability gate (DOCUMENTED DEVIATION — deliberately AFTER hash) ----
    # ``insert_event`` (ENG-65, consumed read-only) derives the ``events``
    # convenience columns from the RAW body: ``type_version`` -> INTEGER (asyncpg
    # strictly rejects a str/oversized int) and ``client_created_at`` ->
    # ``fromisoformat`` (the envelope regex is shape-only, so
    # "2026-13-45T99:99:99Z" passes it but does not parse). Bodies that hash fine
    # but cannot populate those columns are rejected here as ``invalid_schema``
    # rather than 500ing at insert. Placed AFTER the hash check so the
    # coercion-tamper case ('"type_version":"1"' with a hash computed over int 1)
    # still reports ``hash_mismatch`` per the locked test plan; the
    # honestly-hashed string form is rejected here instead of being "accepted
    # and stored verbatim" (the one plan ruling M1 storage cannot honor —
    # flagged for review in the PR).
    type_version = raw_body.get("type_version")
    if (
        isinstance(type_version, bool)
        or not isinstance(type_version, int)
        or not (1 <= type_version <= 2**31 - 1)
    ):
        return Rejected(
            event_id=event_id,
            code="invalid_schema",
            detail="type_version must be a JSON integer",
        )
    try:
        datetime.fromisoformat(raw_body["client_created_at"])
    except ValueError:
        return Rejected(
            event_id=event_id,
            code="invalid_schema",
            detail="client_created_at is not a parseable timestamp",
        )

    # --- step vi: referential checks (M1-minimal) -----------------------------
    referential = await _check_referential(db, ctx=ctx, body_model=body_model, raw_body=raw_body)
    if referential is not None:
        referential.event_id = event_id
        return referential

    # --- step vii: single-event wire-form size cap ----------------------------
    # Measured over the compact raw ``{body, event_hash}`` dump (honest bytes; no
    # model rebuild). Distinct from the batch-level 1 MB whole-body cap.
    wire = {"body": raw_body, "event_hash": raw_hash}
    compact = json.dumps(wire, separators=(",", ":"), ensure_ascii=False)
    if len(compact.encode("utf-8")) > MAX_EVENT_SIZE_BYTES:
        return Rejected(
            event_id=event_id,
            code="payload_too_large",
            detail=f"event exceeds the {MAX_EVENT_SIZE_BYTES}-byte cap",
        )

    return Accepted(home_stream_id=raw_body["stream_id"], raw_body=raw_body)


async def _check_referential(
    db: AsyncSession,
    *,
    ctx: AuthContext,
    body_model: Body,
    raw_body: dict[str, Any],
) -> Rejected | None:
    """Step vi: genesis-collision / §2.2 homing / lifecycle-existence (M1-minimal).

    Returns a :class:`Rejected` (its ``event_id`` filled in by the caller) or
    ``None`` to pass. ``thread_root_id`` / ``file_ids`` / ``mentions`` existence
    are M3 features with no M1 table — deliberately skipped (D8d).
    """
    event_type = body_model.type
    payload = raw_body.get("payload")
    payload = payload if isinstance(payload, dict) else {}

    if event_type == "channel.created":
        channel_stream_id = payload.get("channel_stream_id")
        visibility = payload.get("visibility")
        if isinstance(channel_stream_id, str):
            # Genesis collision (obligation a): a genesis event may not adopt an
            # already-existing stream (would be a cross-stream read grant — the
            # reducer's created-flag guard is the defense-in-depth backstop).
            #
            # LOAD-BEARING (F1): this existence check is GLOBAL (all workspaces),
            # NOT scoped to ctx.workspace_id — and that asymmetry vs. the
            # workspace-scoped LIFECYCLE resolution below is intentional. Genesis
            # is protective: scoping it to the caller's workspace would let a
            # genesis event adopt a stream id that already exists in workspace B,
            # and for a private/self-homed genesis that re-opens cross-tenant home
            # injection (the event would home in — and mutate the log of — B's id).
            # Lifecycle is resolving: it must find the caller's own channel, so it
            # scopes to ctx.workspace_id (tenant isolation + non-disclosure).
            if await _stream_exists(db, channel_stream_id):
                return Rejected(
                    event_id="",
                    code="invalid_schema",
                    detail="channel_stream_id already exists",
                )
            # §2.2 homing (point 9): public genesis homes in workspace-meta;
            # private genesis is self-homed in the channel's own stream.
            meta_id = await _workspace_meta_stream_id(db, ctx.workspace_id)
            if visibility == "public":
                if body_model.stream_id != meta_id:
                    return Rejected(
                        event_id="",
                        code="invalid_schema",
                        detail="public channel.created must be homed in workspace-meta",
                    )
            elif visibility == "private":
                if body_model.stream_id != channel_stream_id:
                    return Rejected(
                        event_id="",
                        code="invalid_schema",
                        detail="private channel.created must be self-homed",
                    )
        return None

    # ``dm.created`` homing (§2.2: stream_id == dm_stream_id) is never reached in
    # M1 — ``dm.created`` is rejected earlier at step iii (``can_write`` -> False ->
    # permission_denied), so no homing check runs here. Documented, not gated.

    if event_type in _LIFECYCLE_TYPES:
        channel_stream_id = payload.get("channel_stream_id")
        if not isinstance(channel_stream_id, str):
            # Unknown-version lifecycle without a resolvable target field — nothing
            # to check referentially (payload was not schema-validated, D9).
            return None

        # F1 step 1 — workspace-scoped target resolution (D13 non-disclosing): a
        # stream id from ANOTHER tenant resolves to None exactly like a
        # never-existed id, so both yield the identical unknown_stream below.
        resolved = await _resolve_channel_in_workspace(
            db, stream_id=channel_stream_id, workspace_id=ctx.workspace_id
        )
        # F1 step 2 — kind gate: the target must be a channel. Aiming e.g.
        # channel.member_added at a DM or workspace-meta stream id in one's OWN
        # workspace (a membership graft / intra-tenant privacy breach) collapses to
        # the SAME unknown_stream — never a distinct code, so admins get no DM
        # existence oracle.
        if resolved is None or resolved[0] != "channel":
            return Rejected(
                event_id="",
                code="unknown_stream",
                detail="no such channel in this workspace",
            )

        # F1 step 3 — strict §2.2 lifecycle homing (mirrors the genesis rule):
        # private target -> body.stream_id must be the channel's own stream
        # (self-homed); public target -> the caller workspace's workspace-meta.
        # Both legal homes are inside ctx.workspace_id by construction, so
        # cross-tenant home/log injection is dead without an insert_event guard.
        # A violation is a protocol-placement fault (invalid_schema), not a
        # permission fault — same code as a genesis homing violation.
        visibility = resolved[1]
        if visibility == "private":
            if body_model.stream_id != channel_stream_id:
                return Rejected(
                    event_id="",
                    code="invalid_schema",
                    detail="private channel lifecycle event must be self-homed",
                )
        else:  # a channel is 'public' or 'private'; public homes in workspace-meta
            meta_id = await _workspace_meta_stream_id(db, ctx.workspace_id)
            if body_model.stream_id != meta_id:
                return Rejected(
                    event_id="",
                    code="invalid_schema",
                    detail="public channel lifecycle event must be homed in workspace-meta",
                )
        return None

    return None
