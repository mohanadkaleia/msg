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
from msgd.core import ids
from msgd.core.envelope import MAX_EVENT_SIZE_BYTES, Body
from msgd.core.hashing import hash_event
from msgd.core.jcs import JCSError
from msgd.core.payloads import get_payload_model
from msgd.db.models import MessageProj, Stream
from msgd.events.permissions import can_read, can_write

__all__ = ["Accepted", "Rejected", "validate_event"]

#: The event types :func:`msgd.events.permissions.can_write` recognizes (its M1
#: write matrix). A type here is gated by ``can_write``; anything else is a D9
#: unknown type, gated by ``can_read`` (membership) — see the module docstring.
_WRITE_MATRIX_TYPES = frozenset(
    {
        "message.created",
        "reaction.added",
        "reaction.removed",
        "message.edited",
        "message.deleted",
        "channel.created",
        "channel.renamed",
        "channel.archived",
        "channel.member_added",
        "channel.member_removed",
        "dm.created",
    }
)

#: ``reaction.*`` types — gated by ``can_write`` (== read access, ENG-97) at step
#: iii and by the §3.2 message-referential check at step vi (:func:`_check_referential`).
_REACTION_TYPES = frozenset({"reaction.added", "reaction.removed"})

#: ``message.edited`` / ``message.deleted`` (ENG-98) — gated by ``can_write`` (==
#: read access to the homed stream) at step iii, then by a message-referential +
#: **author-or-admin** check at step vi (:func:`_check_referential`).
_EDIT_DELETE_TYPES = frozenset({"message.edited", "message.deleted"})

#: Workspace roles that may edit/delete ANY message (not only their own), §2.4.
_ADMINISH = frozenset({"owner", "admin"})

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

#: Uniform detail for a reaction whose target message is absent OR lives in a
#: different (possibly unreadable) stream than the reaction is homed in. Like
#: ``_STREAM_DENIED_DETAIL`` it must NOT vary with which case occurred, so a
#: never-existed message and a message in a stream the author cannot see collapse
#: to the identical outcome (D13 non-disclosure — no cross-stream existence oracle).
_UNKNOWN_MESSAGE_DETAIL = "no such message in this stream"


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


async def _resolve_message_stream(db: AsyncSession, message_id: str) -> str | None:
    """The ``messages_proj.stream_id`` a message lives in, or ``None`` if unknown.

    Reads the committed message projection (populated in the same transaction as
    the ``message.created`` accept, ENG-69) — the authoritative "does this message
    exist, and where does it live" oracle for the reaction referential check. A
    message that never existed and one in another workspace both resolve to a
    stream id the reaction's home cannot equal (or to ``None``), so both collapse
    to the identical ``unknown_message`` — no cross-tenant/cross-stream existence
    oracle (D13).
    """
    stream_id: str | None = await db.scalar(
        select(MessageProj.stream_id).where(MessageProj.message_id == message_id)
    )
    return stream_id


async def _resolve_message_home_and_root(
    db: AsyncSession, message_id: str
) -> tuple[str, str | None] | None:
    """The ``(stream_id, thread_root_id)`` of a message, or ``None`` if unknown.

    The thread-root referential oracle (ENG-99): a ``message.created`` carrying a
    ``thread_root_id`` must root on a message that (a) EXISTS, (b) lives in the exact
    stream the reply is homed in, and (c) is itself a NON-reply (``thread_root_id IS
    NULL`` — flat-channel threads, D7 / §2.2 "the first reply *is* the thread"). All
    three are decided from this one lookup. A DELETED (tombstoned) root still has its
    row — ``stream_id`` / ``thread_root_id`` are never cleared on delete — so replying
    into a deleted root's thread resolves and is ALLOWED (the root row exists; the
    tombstone is a projection concern). A message that never existed and one in a
    DIFFERENT stream both resolve to a value the reply's home cannot match (or to
    ``None``), collapsing to the identical non-disclosing ``unknown_message`` (D13 —
    no cross-stream/cross-tenant existence oracle).
    """
    row = (
        await db.execute(
            select(MessageProj.stream_id, MessageProj.thread_root_id).where(
                MessageProj.message_id == message_id
            )
        )
    ).first()
    if row is None:
        return None
    return row[0], row[1]


async def _resolve_message_home_and_author(
    db: AsyncSession, message_id: str
) -> tuple[str, str] | None:
    """The ``(stream_id, author_user_id)`` of a message, or ``None`` if unknown.

    The edit/delete referential oracle (ENG-98): the target must exist (a
    committed ``messages_proj`` row) so it can be homed and its ORIGINAL author
    checked for the author-or-admin rule. A **deleted** (tombstoned) message still
    has its row — ``stream_id``/``author_user_id`` are never cleared on delete — so
    a later edit/delete of a deleted message still resolves and sequences normally
    (deleted is terminal only in the projection, not in validation).
    """
    row = (
        await db.execute(
            select(MessageProj.stream_id, MessageProj.author_user_id).where(
                MessageProj.message_id == message_id
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
    """Step vi: genesis-collision / §2.2 homing / lifecycle- + reaction-existence.

    Returns a :class:`Rejected` (its ``event_id`` filled in by the caller) or
    ``None`` to pass. ``reaction.*`` adds a message-referential branch (ENG-97):
    the target ``message_id`` must exist in the stream the reaction is homed in.
    ``message.edited`` / ``message.deleted`` add the same message-referential check
    plus an **author-or-admin** authorization gate (ENG-98). ``message.created`` adds
    a **thread-root** referential check (ENG-99): a non-null ``thread_root_id`` must
    reference an existing NON-reply message in the reply's own stream. ``file_ids`` /
    ``mentions`` existence are still deferred (D8d).

    TOTALITY (security round 2): every ``return None`` accept path leaves the
    effective home stream id (``body.stream_id``, which reaches ``insert_event``'s
    global ``UPDATE streams``) provably inside ``ctx.workspace_id`` — enforced here
    for genesis/lifecycle, and upstream at step iii (workspace-scoped ``can_read`` /
    ``can_write``) for message.created and unknown types. No branch may fall
    through to accept with an unconstrained home (cross-tenant injection).
    """
    event_type = body_model.type
    payload = raw_body.get("payload")
    payload = payload if isinstance(payload, dict) else {}

    # SECURITY INVARIANT (round 2) — TOTALITY: every ``return None`` (accept) path
    # in this function MUST leave the effective home stream id (``body.stream_id``,
    # the value that reaches ``insert_event``'s global ``UPDATE streams``) provably
    # inside ``ctx.workspace_id``. A non-total gate that falls through to accept
    # with an unconstrained home is a cross-tenant injection (an event appended to
    # another workspace's — or a private/DM — stream, bumping its sequence). Each
    # branch below states how it upholds this on EVERY accept path.

    if event_type == "channel.created":
        # Home totality: an accept here is only reachable with
        # body.stream_id == workspace-meta (public) OR == channel_stream_id
        # (private, self-homed). Meta is in ctx.workspace_id by query; the
        # self-homed id is guaranteed not to pre-exist ANYWHERE (global genesis
        # collision) so the reducer creates it fresh inside ctx.workspace_id.
        channel_stream_id = payload.get("channel_stream_id")
        name = payload.get("name")
        visibility = payload.get("visibility")

        # Enforce the genesis payload shape HERE, regardless of type_version. The
        # step-iv payload model is SKIPPED for an unknown version
        # (get_payload_model("channel.created", 2) -> None), so leaning on it would
        # let a v2 genesis with visibility=null fall through the homing gate with an
        # unconstrained home. The reducer reads all three fields unconditionally.
        if not isinstance(channel_stream_id, str) or not ids.is_valid_typed_id(
            channel_stream_id, ids.IdKind.STREAM
        ):
            return Rejected(
                event_id="",
                code="invalid_schema",
                detail="channel.created payload.channel_stream_id must be a stream id",
            )
        if not isinstance(name, str):
            return Rejected(
                event_id="",
                code="invalid_schema",
                detail="channel.created payload.name must be a string",
            )
        if visibility not in ("public", "private"):
            return Rejected(
                event_id="",
                code="invalid_schema",
                detail="channel.created payload.visibility must be 'public' or 'private'",
            )

        # Genesis collision (obligation a): a genesis event may not adopt an
        # already-existing stream (would be a cross-stream read grant — the
        # reducer's created-flag guard is the defense-in-depth backstop).
        #
        # LOAD-BEARING (F1): this existence check is GLOBAL (all workspaces), NOT
        # scoped to ctx.workspace_id — and that asymmetry vs. the workspace-scoped
        # LIFECYCLE resolution below is intentional. Genesis is protective: scoping
        # it to the caller's workspace would let a genesis event adopt a stream id
        # that already exists in workspace B, and for a private/self-homed genesis
        # that re-opens cross-tenant home injection (the event would home in — and
        # mutate the log of — B's id). Lifecycle is resolving: it must find the
        # caller's own channel, so it scopes to ctx.workspace_id.
        if await _stream_exists(db, channel_stream_id):
            return Rejected(
                event_id="",
                code="invalid_schema",
                detail="channel_stream_id already exists",
            )

        # TOTAL §2.2 homing (point 9): public -> workspace-meta; private ->
        # self-homed. ``visibility`` is enum-checked above, so these two arms are
        # exhaustive — there is NO fall-through-accept with an unconstrained home,
        # and a home that is neither meta nor channel_stream_id is always rejected.
        meta_id = await _workspace_meta_stream_id(db, ctx.workspace_id)
        if visibility == "public":
            if body_model.stream_id != meta_id:
                return Rejected(
                    event_id="",
                    code="invalid_schema",
                    detail="public channel.created must be homed in workspace-meta",
                )
        else:  # visibility == "private" (enum enforced above)
            if body_model.stream_id != channel_stream_id:
                return Rejected(
                    event_id="",
                    code="invalid_schema",
                    detail="private channel.created must be self-homed",
                )
        return None

    if event_type == "dm.created":
        # Home totality: UNREACHABLE. ``dm.created`` is rejected at step iii for
        # EVERY version (``can_write`` keys on the type string -> False ->
        # permission_denied), so control never reaches this function for it. This
        # explicit reject is defense-in-depth in case that ever changes: a
        # dm.created that somehow arrives here is refused rather than accepted with
        # an unconstrained home (§2.2 dm homing is deferred with the DM endpoint).
        return Rejected(
            event_id="",
            code="invalid_schema",
            detail="dm.created is not accepted in M1",
        )

    if event_type in _LIFECYCLE_TYPES:
        # Home totality: an accept here is only reachable with the target resolved
        # as a CHANNEL inside ctx.workspace_id AND body.stream_id constrained to
        # either that channel (private) or the caller's workspace-meta (public) —
        # both in ctx.workspace_id. Every other path rejects.
        channel_stream_id = payload.get("channel_stream_id")
        if not isinstance(channel_stream_id, str):
            # Unresolvable target (missing/mistyped — an unknown version skipped
            # payload validation, D9). Reject cleanly here: falling through to
            # accept would (a) leave the home unconstrained and (b) 500 in the
            # version-agnostic reducer, which reads payload["channel_stream_id"]
            # unconditionally. invalid_schema, not unknown_stream (nothing to
            # resolve — this is a shape fault).
            return Rejected(
                event_id="",
                code="invalid_schema",
                detail="channel lifecycle event payload.channel_stream_id must be a stream id",
            )

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

        # Reducer-field guard (500-proof): the version-agnostic reducer reads these
        # payload fields unconditionally, and an unknown version skipped payload
        # validation — so verify them here or reject before emit_event runs the
        # reducer (a KeyError there would 500 the request). channel.archived needs
        # only channel_stream_id (already guarded).
        if event_type == "channel.renamed" and not isinstance(payload.get("name"), str):
            return Rejected(
                event_id="",
                code="invalid_schema",
                detail="channel.renamed payload.name must be a string",
            )
        if event_type in ("channel.member_added", "channel.member_removed"):
            member_user_id = payload.get("user_id")
            if not isinstance(member_user_id, str) or not ids.is_valid_typed_id(
                member_user_id, ids.IdKind.USER
            ):
                return Rejected(
                    event_id="",
                    code="invalid_schema",
                    detail="channel membership event payload.user_id must be a user id",
                )

        # F1 step 3 — strict §2.2 lifecycle homing (mirrors the genesis rule):
        # private target -> body.stream_id must be the channel's own stream
        # (self-homed); public target -> the caller workspace's workspace-meta.
        # ``visibility`` of a resolved channel is 'public' or 'private', so these
        # arms are exhaustive; both legal homes are inside ctx.workspace_id by
        # construction, so cross-tenant home/log injection is dead without an
        # insert_event guard. A violation is a protocol-placement fault
        # (invalid_schema), not a permission fault.
        visibility = resolved[1]
        if visibility == "private":
            if body_model.stream_id != channel_stream_id:
                return Rejected(
                    event_id="",
                    code="invalid_schema",
                    detail="private channel lifecycle event must be self-homed",
                )
        else:  # a resolved channel is 'public' or 'private'; public homes in meta
            meta_id = await _workspace_meta_stream_id(db, ctx.workspace_id)
            if body_model.stream_id != meta_id:
                return Rejected(
                    event_id="",
                    code="invalid_schema",
                    detail="public channel lifecycle event must be homed in workspace-meta",
                )
        return None

    if event_type in _REACTION_TYPES:
        # §3.2 reaction referential check (ENG-97): the target message must EXIST
        # in the stream the reaction is homed in. Home totality: an accept here is
        # only reachable when the message resolves to body.stream_id, and step iii
        # already gated can_write(body.stream_id) == can_read (workspace-scoped
        # readable_streams_predicate), so the only accepted home is a stream in
        # ctx.workspace_id — cross-tenant home injection is dead upstream.
        #
        # message_id shape guard (500-proof + D9): for the known v1 the step-iv
        # payload model already forced a valid m_ id, but an unknown reaction
        # version (get_payload_model("reaction.added", 2) -> None) SKIPS it, so a
        # garbage/absent message_id must be handled here. A reference to something
        # that is not even a message id references no real message -> the same
        # non-disclosing unknown_message as a well-formed-but-absent reference.
        message_id = payload.get("message_id")
        if not isinstance(message_id, str) or not ids.is_valid_typed_id(
            message_id, ids.IdKind.MESSAGE
        ):
            return Rejected(event_id="", code="unknown_message", detail=_UNKNOWN_MESSAGE_DETAIL)

        # Referential existence + §2.4 homing in ONE check: the message must live
        # in the exact stream the reaction is homed in. A message that never
        # existed (None) and one in a DIFFERENT stream — including a private stream
        # the author cannot read, or another workspace — both fail this equality
        # and collapse to the identical unknown_message (no existence oracle).
        # Duplicate reaction.added and reaction.removed of an absent reaction are
        # NOT rejected here: idempotency/no-op is a projection concern (ENG-97),
        # so both sequence normally as valid events.
        home_message_stream = await _resolve_message_stream(db, message_id)
        if home_message_stream is None or home_message_stream != body_model.stream_id:
            return Rejected(event_id="", code="unknown_message", detail=_UNKNOWN_MESSAGE_DETAIL)
        return None

    if event_type in _EDIT_DELETE_TYPES:
        # §3.2 edit/delete referential + author-or-admin (ENG-98). Home totality: an
        # accept here is only reachable when the target message resolves to
        # body.stream_id, and step iii already gated can_write(body.stream_id) ==
        # can_read (workspace-scoped readable_streams_predicate), so the only
        # accepted home is a stream in ctx.workspace_id — cross-tenant home
        # injection is dead upstream.
        #
        # message_id shape guard (500-proof + D9): for the known v1 the step-iv
        # payload model already forced a valid m_ id, but an unknown version
        # (get_payload_model("message.edited", 2) -> None) SKIPS it, so a
        # garbage/absent message_id must be handled here — it references no real
        # message, so the same non-disclosing unknown_message.
        message_id = payload.get("message_id")
        if not isinstance(message_id, str) or not ids.is_valid_typed_id(
            message_id, ids.IdKind.MESSAGE
        ):
            return Rejected(event_id="", code="unknown_message", detail=_UNKNOWN_MESSAGE_DETAIL)

        # Referential existence + §2.4 homing FIRST (before the author check, so
        # existence is never disclosed): the message must live in the exact stream
        # the edit/delete is homed in. A message that never existed (None) and one
        # in a DIFFERENT stream — a private stream the author cannot read, or another
        # workspace — both fail this equality and collapse to the identical
        # unknown_message (no cross-stream/cross-tenant existence oracle, D13).
        resolved = await _resolve_message_home_and_author(db, message_id)
        if resolved is None or resolved[0] != body_model.stream_id:
            return Rejected(event_id="", code="unknown_message", detail=_UNKNOWN_MESSAGE_DETAIL)

        # Author-or-admin (§2.4): only the ORIGINAL author or a workspace admin/owner
        # may edit/delete a message. A non-author non-admin who CAN see the message
        # (it resolved in a stream they can read/write) gets permission_denied — the
        # existence was already (legitimately) disclosed by their read access, so
        # this is an honest authorization fault, not a non-disclosure concern. This
        # is reachable only AFTER the referential check passes, so a cross-stream /
        # unreadable target never reaches here (it is unknown_message above).
        author_user_id = resolved[1]
        if author_user_id != ctx.user_id and ctx.role not in _ADMINISH:
            return Rejected(
                event_id="",
                code="permission_denied",
                detail="only the message author or a workspace admin may edit or delete it",
            )
        # Multiple edits, edit-after-delete, and delete-after-delete are all VALID
        # events that sequence normally — convergence (LWW / terminal tombstone) is
        # a projection concern (ENG-98 apply.py), never a reject here.
        return None

    if event_type == "message.created":
        # §3.2 thread-root referential check (ENG-99, D7). A message.created with a
        # non-null thread_root_id is a THREAD REPLY: the root must EXIST, live in the
        # exact stream the reply is homed in, and be a NON-reply (flat threads). A
        # null thread_root_id is a top-level message — nothing to resolve, pass.
        #
        # Home totality: an accept here is only reachable for body.stream_id already
        # gated at step iii (can_write == workspace-scoped readable predicate), so the
        # only accepted home is a stream in ctx.workspace_id — cross-tenant home
        # injection is dead upstream, exactly as for a top-level message.created.
        thread_root_id = payload.get("thread_root_id")
        if thread_root_id is None:
            return None  # top-level message — no thread root to resolve.

        # Shape guard (500-proof + D9): the known v1 payload model already forced a
        # valid m_ id, but an unknown message.created version skips it, so a
        # garbage/mistyped thread_root_id must be handled here — it references no real
        # message, so the same non-disclosing unknown_message as a well-formed-absent
        # reference (never invalid_schema, to keep ONE uniform non-disclosing outcome).
        if not isinstance(thread_root_id, str) or not ids.is_valid_typed_id(
            thread_root_id, ids.IdKind.MESSAGE
        ):
            return Rejected(event_id="", code="unknown_message", detail=_UNKNOWN_MESSAGE_DETAIL)

        # Existence + §2.2 same-stream homing + flat-thread (non-reply root) in ONE
        # check. A root that never existed (None), one in a DIFFERENT stream (private/
        # unreadable or another workspace), AND one that is ITSELF a reply (reply-of-
        # reply — forbidden by the flat-channel model, D7) all collapse to the identical
        # unknown_message: existence is never disclosed, and the reply-of-reply case is
        # within a readable stream so folding it into the same outcome leaks nothing.
        # Replying into a DELETED root's thread is ALLOWED — the tombstone row still
        # resolves with its stream_id + null thread_root_id (see _resolve_message_home_and_root).
        resolved = await _resolve_message_home_and_root(db, thread_root_id)
        if resolved is None or resolved[0] != body_model.stream_id or resolved[1] is not None:
            return Rejected(event_id="", code="unknown_message", detail=_UNKNOWN_MESSAGE_DETAIL)
        return None

    # unknown D9 types: no referential branch. Home totality is upheld UPSTREAM at
    # step iii — ``can_read`` / ``can_write`` gate on ``readable_streams_predicate``,
    # which filters ``Stream.workspace_id == ctx.workspace_id``, so the only accepted
    # home is a stream in the caller's workspace. (Unknown types run no reducer.)
    return None
