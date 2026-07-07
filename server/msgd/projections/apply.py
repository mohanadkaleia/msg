"""Incremental ``messages_proj`` apply — the single source of projection truth (ENG-69).

``apply_projection`` is the one function BOTH the incremental accept path
(:mod:`msgd.events.insert` step 3b) and the full :mod:`msgd.projections.rebuild`
replay call.  Because there is exactly one apply implementation, ``rebuild ≡
incremental`` holds **by construction** — a rebuild replays the stored log
through the same handler the accept path used (the Postgres analogue of the M0
SQLite ``project``/``rebuild`` both calling ``_apply_message_created``).

Dispatch mirrors ``reducers.REDUCERS`` and the M0 ``projection._HANDLERS``, but
is keyed on ``(type, type_version)`` (a version bump is a new, unhandled key —
D9-skipped, never a silent mis-apply).  Handlers exist for ``("message.created",
1)`` (→ ``messages_proj`` insert, plus — since ENG-99 (M3) — a thread reply
RECOMPUTE of the root's ``reply_count``/``last_reply_seq``/``thread_participants_proj``
when ``thread_root_id`` is set); since ENG-97 (M3) ``("reaction.added", 1)`` /
``("reaction.removed", 1)`` (→ the ``reactions_proj`` set); and since ENG-98 (M3)
``("message.edited", 1)`` (LWW ``text``/``edited_seq`` update by ``server_sequence``)
/ ``("message.deleted", 1)`` (tombstone ``deleted`` + ``text`` content redaction, plus
the ENG-99 delete-side thread recompute when the deleted message was a reply).
Everything else — meta events, unknown types, and any ``v>=2`` — has no handler
and is a **no-op** (D9: skipped in the projection, never crashes).  ``bot.*`` is a
later milestone; its ``messages_proj`` columns exist but no reducer writes them.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Final

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.core.payloads import (
    MessageCreatedV1,
    MessageDeletedV1,
    MessageEditedV1,
    ReactionAddedV1,
    ReactionRemovedV1,
)
from msgd.db.models import MessageProj, ReactionProj, ThreadParticipantProj

__all__ = ["PROJECTION_VERSION", "apply_projection"]

#: The projection contract version. It governs BOTH the ``messages_proj`` shape
#: AND the apply logic: bump it on ANY change to either — add/drop a projected
#: column, add or change a handler, or change how a field maps.
#:
#: M1 declares the version (satisfying the "every projection declares its
#: version" D-invariant, TDD §2.3 rule 5) but deliberately does NOT ship the
#: stored-version auto-rebuild-on-mismatch machinery that the M0 SQLite/Dexie
#: sides carry: a server version bump is handled by an operator running
#: ``msgctl rebuild-projections``.  Deferred until a bump actually needs it
#: (ENG-69 plan Ruling / risk 5).
#:
#: Bumped to 2 by ENG-97 (M3): the reaction handlers + the new ``reactions_proj``
#: shape are a change to both the projection tables AND the apply logic — the
#: exact "bump on ANY change to either" trigger above. An operator upgrading to
#: M3 runs ``msgctl rebuild-projections`` once to materialize ``reactions_proj``.
#:
#: Bumped to 3 by ENG-98 (M3): ``message.edited`` (LWW by ``server_sequence``) and
#: ``message.deleted`` (tombstone + content redaction) handlers now WRITE the
#: pre-existing ``edited_seq`` / ``deleted`` / ``text`` columns of ``messages_proj``
#: — a change to the apply logic (no schema/table change: the columns already
#: exist from M1 ENG-69, so NO migration is needed, only this version bump). An
#: operator upgrading runs ``msgctl rebuild-projections`` once so replayed
#: edits/deletes materialize.
#:
#: Bumped to 4 by ENG-99 (M3): the ``message.created`` reply reducer + the
#: ``message.deleted`` reply-recompute now WRITE ``messages_proj``'s pre-existing
#: ``reply_count`` / ``last_reply_seq`` columns (M1 ENG-69, previously unused) AND
#: maintain the NEW ``thread_participants_proj`` set — a change to both the apply
#: logic and the projection tables (the new table ships in migration 0004). An
#: operator upgrading runs ``msgctl rebuild-projections`` once so replayed thread
#: counters + participants materialize.
PROJECTION_VERSION: Final = 4

_Handler = Callable[..., Awaitable[None]]


async def _recompute_thread_root(db: AsyncSession, root_message_id: str) -> None:
    """RECOMPUTE a thread root's ``reply_count`` / ``last_reply_seq`` / participants.

    The single delete-aware, rebuild-equivalent thread reducer (ENG-99, D7). Given
    a ``root_message_id``, it derives ALL thread state for that root from the
    CURRENT committed ``messages_proj`` rows whose ``thread_root_id`` equals it and
    that are NOT deleted:

    * ``reply_count`` = ``count(*)`` of those non-deleted replies (written onto the
      root's own ``messages_proj`` row);
    * ``last_reply_seq`` = ``max(created_seq)`` among them (``NULL`` when none
      remain — e.g. every reply was deleted);
    * ``thread_participants_proj`` = the DISTINCT ``author_user_id`` set of them
      (fully rebuilt: delete the root's rows, re-insert from the current set).

    WHY RECOMPUTE, NOT ``+1`` (the load-bearing rebuild-equivalence argument): a
    reply can be DELETED after it was counted, so a blind ``reply_count += 1`` on
    ``message.created`` is not invertible by a later ``message.deleted``. Recomputing
    from state makes every value a PURE FUNCTION of the current ``messages_proj``
    ``(thread_root_id, deleted, author_user_id, created_seq)`` columns — whose state
    is itself already ``rebuild ≡ incremental`` (ENG-98 gate). The recompute is
    triggered on EXACTLY the events that can change a root's non-deleted-reply set —
    a reply ``message.created`` and a reply ``message.deleted`` — so the last such
    event leaves the derived state equal to a full replay's, in any delivery/replay
    order. (A ``message.edited`` cannot change ``thread_root_id`` or ``deleted``, so
    it needs no recompute; a ROOT's own ``message.deleted`` does not change
    ``count(thread_root_id = root)``, so it triggers none either.)

    A ``root_message_id`` with no ``messages_proj`` row (a not-yet/never-projected
    root) leaves the counter ``UPDATE`` a zero-row no-op; the participant rebuild
    still reflects the current reply set. On the validated accept path the root
    always exists (the ENG-99 referential check), so this is a defensive edge.
    """
    non_deleted_replies = (
        MessageProj.thread_root_id == root_message_id,
        MessageProj.deleted.is_(False),
    )
    # ``.correlate(None)`` is LOAD-BEARING: the subqueries scan the SAME table the
    # UPDATE targets (``messages_proj``), and SQLAlchemy would otherwise auto-correlate
    # that reference to the outer UPDATE row — counting only the root's own row instead
    # of its replies. Forcing no correlation makes each subquery an independent
    # whole-table aggregate over the replies.
    await db.execute(
        update(MessageProj)
        .where(MessageProj.message_id == root_message_id)
        .values(
            reply_count=select(func.count())
            .select_from(MessageProj)
            .where(*non_deleted_replies)
            .correlate(None)
            .scalar_subquery(),
            last_reply_seq=select(func.max(MessageProj.created_seq))
            .where(*non_deleted_replies)
            .correlate(None)
            .scalar_subquery(),
        )
    )
    # Rebuild the participant set for this root from the current non-deleted replies.
    await db.execute(
        delete(ThreadParticipantProj).where(
            ThreadParticipantProj.root_message_id == root_message_id
        )
    )
    await db.execute(
        pg_insert(ThreadParticipantProj)
        .from_select(
            ["root_message_id", "user_id"],
            select(
                MessageProj.thread_root_id,
                MessageProj.author_user_id,
            )
            .where(*non_deleted_replies)
            .distinct(),
        )
        .on_conflict_do_nothing(
            index_elements=[
                ThreadParticipantProj.root_message_id,
                ThreadParticipantProj.user_id,
            ]
        )
    )


async def _apply_message_created(
    db: AsyncSession, *, body: dict[str, Any], server_sequence: int
) -> None:
    """Project one ``message.created`` v1 event into ``messages_proj``.

    Re-validates the opaque ``payload`` through :class:`MessageCreatedV1`
    (defence-in-depth: ENG-66's ``validate.py`` already validated it pre-accept)
    and ``INSERT … ON CONFLICT (message_id) DO NOTHING`` — the Postgres analogue
    of M0's ``INSERT OR IGNORE``.  ``message.created`` is **immutable** in M1
    (edits/deletes are later milestones), so an existing row and a re-applied one
    are byte-identical; ``DO NOTHING`` keeps the incremental accept and the
    rebuild replay in agreement on any re-seen ``message_id`` and makes replay
    idempotent.

    Only the columns the apply owns are written:

    * ``message_id`` / ``text`` / ``thread_root_id`` — from the validated payload.
    * ``stream_id`` / ``author_user_id`` — from the envelope ``body``.
    * ``created_seq`` — the accept-time ``server_sequence``.

    The row's OWN ``edited_seq``/``last_reply_seq`` DEFAULT NULL, ``deleted``
    FALSE, ``reply_count`` 0.  ``search_tsv`` is a GENERATED column (a pure
    function of ``text``) and is never written.

    **Thread reply (ENG-99, D7).** When ``thread_root_id`` is non-null this message
    is a reply, so AFTER inserting its own row (the insert must land first, so the
    reply is included in the count) it RECOMPUTES the ROOT message's thread state
    via :func:`_recompute_thread_root` — ``reply_count`` / ``last_reply_seq`` on the
    root row and the root's ``thread_participants_proj`` set, all delete-aware and
    rebuild-equivalent (see that helper). Recompute reads the just-inserted row, so
    a duplicate (``ON CONFLICT DO NOTHING``) re-apply still recomputes the same count
    — idempotent.
    """
    payload = MessageCreatedV1(**body["payload"])
    await db.execute(
        pg_insert(MessageProj)
        .values(
            message_id=payload.message_id,
            stream_id=body["stream_id"],
            thread_root_id=payload.thread_root_id,
            author_user_id=body["author_user_id"],
            text=payload.text,
            created_seq=server_sequence,
        )
        .on_conflict_do_nothing(index_elements=[MessageProj.message_id])
    )
    if payload.thread_root_id is not None:
        await _recompute_thread_root(db, payload.thread_root_id)


async def _apply_reaction_added(
    db: AsyncSession, *, body: dict[str, Any], server_sequence: int
) -> None:
    """Project one ``reaction.added`` v1 event: idempotent set-insert (§2.4).

    Re-validates the opaque ``payload`` through :class:`ReactionAddedV1`
    (defence-in-depth) and ``INSERT … ON CONFLICT DO NOTHING`` on the membership
    key ``(message_id, author_user_id, emoji)``. Already-present membership is a
    **no-op** — the count (``= |{author_user_id}|`` for a ``(message_id, emoji)``)
    is unchanged, exactly the §2.4 idempotent-add semantics. A duplicate
    ``reaction.added`` (same key, different ``event_id``) sequences as its own
    event but lands zero new rows, so the projected set — hence the aggregated
    count — is a pure function of the log. ``author_user_id`` comes from the
    envelope (§2.4 keys the set on it, not the payload). ``emoji`` is bound as an
    opaque parameter into the ``COLLATE "C"`` byte-exact column.
    """
    payload = ReactionAddedV1(**body["payload"])
    await db.execute(
        pg_insert(ReactionProj)
        .values(
            message_id=payload.message_id,
            author_user_id=body["author_user_id"],
            emoji=payload.emoji,
        )
        .on_conflict_do_nothing(
            index_elements=[
                ReactionProj.message_id,
                ReactionProj.author_user_id,
                ReactionProj.emoji,
            ]
        )
    )


async def _apply_reaction_removed(
    db: AsyncSession, *, body: dict[str, Any], server_sequence: int
) -> None:
    """Project one ``reaction.removed`` v1 event: idempotent set-delete (§2.4).

    ``DELETE`` the membership key ``(message_id, author_user_id, emoji)``.
    Removing an absent reaction deletes zero rows — a **no-op**, exactly the §2.4
    idempotent-remove semantics — so a ``reaction.removed`` for a reaction that
    was never added (or already removed) sequences as its own event yet leaves the
    set unchanged. ``emoji`` matches byte-exactly via the column's ``C`` collation.
    """
    payload = ReactionRemovedV1(**body["payload"])
    await db.execute(
        delete(ReactionProj).where(
            ReactionProj.message_id == payload.message_id,
            ReactionProj.author_user_id == body["author_user_id"],
            ReactionProj.emoji == payload.emoji,
        )
    )


async def _apply_message_edited(
    db: AsyncSession, *, body: dict[str, Any], server_sequence: int
) -> None:
    """Project one ``message.edited`` v1 event: last-writer-wins by ``server_sequence``.

    Re-validates the opaque ``payload`` through :class:`MessageEditedV1`
    (defence-in-depth) then ``UPDATE messages_proj`` the target row's ``text`` and
    ``edited_seq``, but **only** when this event out-ranks the current state (D14
    LWW): ``server_sequence > coalesce(edited_seq, created_seq)`` — i.e. it is
    newer than the last edit already applied (or, if none, than the creation). This
    single guard makes the apply **order-independent**: a rebuild replaying the
    same edits in any order, or an out-of-order incremental delivery, converges to
    the highest-``server_sequence`` edit's text. Prior edit payloads stay in the
    immutable ``events`` log for a future edit-history viewer — the projection
    keeps only the winning body, never history.

    ``deleted IS FALSE`` in the predicate makes a delete **terminal**: an edit that
    arrives after a delete (higher or lower seq) matches zero rows, so it never
    un-deletes nor un-redacts the tombstoned content. ``format`` is NOT projected
    (``messages_proj`` has no ``format`` column — §4.2, mirroring
    ``message.created``), so only ``text`` + ``edited_seq`` move. A no-match UPDATE
    (missing/older/deleted target) changes zero rows — a safe idempotent no-op that
    keeps rebuild ≡ incremental.
    """
    payload = MessageEditedV1(**body["payload"])
    await db.execute(
        update(MessageProj)
        .where(
            MessageProj.message_id == payload.message_id,
            MessageProj.deleted.is_(False),
            func.coalesce(MessageProj.edited_seq, MessageProj.created_seq) < server_sequence,
        )
        .values(text=payload.text, edited_seq=server_sequence)
    )


async def _apply_message_deleted(
    db: AsyncSession, *, body: dict[str, Any], server_sequence: int
) -> None:
    """Project one ``message.deleted`` v1 event: tombstone + content redaction (§2.4).

    Re-validates through :class:`MessageDeletedV1` then ``UPDATE messages_proj SET
    deleted = TRUE, text = ''`` for the target message. Two rulings are baked in:

    * **Content is redacted, not just flagged.** Setting ``text = ''`` (the column
      is ``NOT NULL``, so ``''`` rather than ``NULL``) means the ``messages_proj``
      read/dump path cannot serve deleted content — a deleted message never leaks
      its body through the projection. The GENERATED ``search_tsv`` is a pure
      function of ``text``, so redacting ``text`` empties the search index too. The
      original ``message.created`` body is still in the immutable ``events`` log
      (event-sourcing reality) — the log is NOT redacted, only the projection.
    * **Terminal + idempotent, hence order-independent.** The write is
      unconditional on ``message_id`` (no seq guard): a delete always wins over any
      edit regardless of replay order, and delete-after-delete simply re-sets the
      same tombstone (a no-op). ``stream_id`` / ``author_user_id`` / ``created_seq``
      are left intact so the referential + author-or-admin checks still resolve a
      later (valid) edit/delete of the tombstoned message.

    A delete of a message with no projected row (impossible on the accept path —
    validation proved existence) updates zero rows: a safe no-op.

    **Thread reply (ENG-99, D7).** If the deleted message was itself a REPLY (its
    ``thread_root_id`` is non-null), the delete drops it from the root's
    non-deleted-reply set, so AFTER tombstoning it RECOMPUTES the root's
    ``reply_count`` / ``last_reply_seq`` / participants from the now-current state
    (:func:`_recompute_thread_root`) — this is the delete-side of the reply counter
    that a blind create-time ``+1`` could not honor. Deleting a ROOT (its own
    ``thread_root_id`` is null) triggers no recompute: a root's replies survive it
    (the root row stays as a tombstone with ``reply_count`` intact, §2.4 / D7), and
    ``count(thread_root_id = root)`` is unchanged by the root's own deletion.
    """
    payload = MessageDeletedV1(**body["payload"])
    await db.execute(
        update(MessageProj)
        .where(MessageProj.message_id == payload.message_id)
        .values(deleted=True, text="")
    )
    thread_root_id = await db.scalar(
        select(MessageProj.thread_root_id).where(MessageProj.message_id == payload.message_id)
    )
    if thread_root_id is not None:
        await _recompute_thread_root(db, thread_root_id)


#: The projection's dispatch table, keyed ``(type, type_version)`` — distinct
#: from ``core``'s payload-validation registry and from ``reducers.REDUCERS``
#: (which is ``type``-keyed). Handlers exist for ``message.created`` v1,
#: ``reaction.added``/``reaction.removed`` v1 (ENG-97), and
#: ``message.edited``/``message.deleted`` v1 (ENG-98); every other ``(type,
#: version)`` — meta events, unknown types, any ``v>=2`` — has no handler and is
#: uniformly skipped (D9).
_HANDLERS: Final[dict[tuple[str, int], _Handler]] = {
    ("message.created", 1): _apply_message_created,
    ("reaction.added", 1): _apply_reaction_added,
    ("reaction.removed", 1): _apply_reaction_removed,
    ("message.edited", 1): _apply_message_edited,
    ("message.deleted", 1): _apply_message_deleted,
}


async def apply_projection(db: AsyncSession, *, body: dict[str, Any], server_sequence: int) -> bool:
    """Apply one event ``body`` to ``messages_proj`` (no commit — caller's txn).

    Dispatches on ``(body["type"], body["type_version"])``.  Returns ``True`` if
    a handler ran (the event projects to a row), ``False`` if it was a D9 no-op
    (meta / unknown type / unhandled version) — the rebuild uses the flag for its
    applied/skipped summary.  Never commits; runs inside the caller's
    transaction, so a raise here rolls the caller's txn back (the accept-path
    "projection failure rejects the event" guarantee, ENG-69 Pin 5).

    :class:`~pydantic.ValidationError` from a handler propagates: on a
    pre-validated payload it is impossible, so surfacing it loudly (accept path →
    500) is preferable to silently letting ``events`` and ``messages_proj``
    diverge (ENG-69 Pin 5 — loud-is-preferable-to-silent-divergence).
    """
    handler = _HANDLERS.get((body["type"], body["type_version"]))
    if handler is None:
        return False  # D9: meta / unknown type / message.created v>=2 → skip, never crash
    await handler(db, body=body, server_sequence=server_sequence)
    return True
