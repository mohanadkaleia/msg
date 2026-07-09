"""The ONE validated event-write path (ENG-161 refactor of the ENG-66 tail).

:func:`store_event` is the accepted-item tail of ``POST /v1/events/batch``
factored out verbatim — ``validate_event`` → SAVEPOINT ``emit_event`` →
per-event ``commit`` → ``publish_event`` — so every surface that turns an
untrusted item into a stored event runs the IDENTICAL pipeline:

* the batch upload router (``msgd.api.routers.events_upload``) calls it once
  per item;
* the public incoming-webhook receiver (``msgd.plugins.hooks``) calls it for
  the ONE server-built ``message.created`` it mints per delivery.

There is deliberately no second entry point: a caller that wants an event
stored on behalf of a principal goes through :func:`store_event` (and thus
through the full §3.2 validation — author binding, ``can_write`` membership,
the archived-write gate, payload schema, hash, referential checks, and the
64 KB cap) or through the server-authored ``emit_event`` path for the meta
types clients can never upload. Bypassing ``validate_event`` with a bare
``emit_event`` for client-shaped input is a security bug by definition.

All the D6/D7/F2/F4 rulings documented on the batch router hold unchanged —
this module only MOVED them (the per-event SAVEPOINT + commit, the
idempotent re-accept, the cross-user collision non-disclosure, the narrow
SQLSTATE-22 storability backstop, and the exactly-once post-commit publish).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api.schemas.events import AcceptedEvent, RejectedEvent
from msgd.auth.context import AuthContext
from msgd.core.time import to_rfc3339
from msgd.db.models import Event
from msgd.events.emit import emit_event
from msgd.events.fanout import publish_event
from msgd.events.insert import UnknownStreamError
from msgd.events.validate import Accepted, validate_event

__all__ = ["store_event"]

#: The ``UNIQUE(workspace_id, event_id)`` constraint name (naming convention,
#: migration 0001) — the ONE integrity violation the idempotent re-accept path
#: recognizes. Any other constraint is a schema-impossible state and surfaces as
#: a 500, never a per-event reject (F4).
_IDEMPOTENCY_CONSTRAINT = "uq_events_workspace_id"

#: Postgres SQLSTATE class 22 = "data exception" (e.g. 22P05, a NUL in text). The
#: ONE transient-vs-permanent discriminator for the storability backstop (F2).
_DATA_EXCEPTION_SQLSTATE_CLASS = "22"


def _pg_sqlstate(exc: DBAPIError) -> str | None:
    """The Postgres SQLSTATE of a wrapped driver error, if present.

    SQLAlchemy's asyncpg dialect copies the code onto the translated DBAPI error
    (``exc.orig``) as ``sqlstate``/``pgcode`` — the raw asyncpg exception is only
    reachable via ``__cause__``, so read the code off ``exc.orig`` directly.
    """
    code = getattr(exc.orig, "sqlstate", None) or getattr(exc.orig, "pgcode", None)
    return code if isinstance(code, str) else None


def _pg_constraint_name(exc: DBAPIError) -> str | None:
    """The violated constraint name, dug out of the driver-error cause chain.

    ``exc.orig`` is SQLAlchemy's DBAPI wrapper; the asyncpg ``UniqueViolationError``
    that actually carries ``constraint_name`` is its ``__cause__``.
    """
    for obj in (exc.orig, getattr(exc.orig, "__cause__", None)):
        name = getattr(obj, "constraint_name", None)
        if isinstance(name, str):
            return name
    return None


async def store_event(
    db: AsyncSession, *, ctx: AuthContext, item: Any
) -> AcceptedEvent | RejectedEvent:
    """Validate, sequence, idempotently store, and publish ONE event (§3.2).

    The exact per-item semantics of the batch router (D5/D6/D7, F2/F4):

    * ``validate_event`` first — a rejected item opens no transaction.
    * A ``begin_nested()`` SAVEPOINT around ``emit_event`` (so the idempotency
      UNIQUE violation is catchable without poisoning the session), then a
      ``commit()`` per accepted event — the ``streams`` row lock is released
      immediately so concurrent writers serialize tightly (§4.2).
    * Idempotent re-accept (D7): the UNIQUE violation is recovered by returning
      the ORIGINAL row's four ``accepted[]`` fields; the reducer is not re-run
      and ``publish_event`` is NOT re-invoked. A cross-USER ``event_id``
      collision is rejected non-disclosingly instead of echoing another
      author's coordinates (security round 2).
    * The narrow SQLSTATE-class-22 storability backstop (F2) rejects a
      permanently unstorable body as ``invalid_schema``; every other DB error
      is transient and re-raised → 500 (the client retries; idempotency makes
      the retry safe).
    * ``publish_event`` runs AFTER the commit, exactly once per NEWLY accepted
      event (D9).
    """
    outcome = await validate_event(db, ctx=ctx, item=item)
    if not isinstance(outcome, Accepted):
        return RejectedEvent(event_id=outcome.event_id, code=outcome.code, detail=outcome.detail)

    raw_body = outcome.raw_body
    workspace_id = raw_body["workspace_id"]
    event_id = raw_body["event_id"]
    try:
        # SAVEPOINT makes the UNIQUE violation catchable; the per-event commit
        # releases the streams-row lock immediately (tight gapless serialization).
        async with db.begin_nested():
            envelope = await emit_event(db, home_stream_id=outcome.home_stream_id, body=raw_body)
        await db.commit()
    except IntegrityError as exc:
        # F4: only the idempotency UNIQUE(workspace_id, event_id) constraint is
        # recoverable. Any OTHER integrity violation is a schema-impossible
        # state and must surface loudly (500), never be shaped into a reject.
        if _pg_constraint_name(exc) != _IDEMPOTENCY_CONSTRAINT:
            raise
        # Idempotent re-accept: the savepoint rolled back its head_seq bump +
        # failed insert, so no sequence is consumed. Clear the aborted txn,
        # return the ORIGINAL record (D7).
        await db.rollback()
        fetched = await _fetch_original(db, workspace_id=workspace_id, event_id=event_id)
        if fetched is None:
            # The UNIQUE violation proved a row exists; a fetch-miss is an
            # impossible state after per-event commits — re-raise, don't reject.
            raise
        original, original_author = fetched
        if original_author != ctx.user_id:
            # HARDENING (security round 2): the stored event with this
            # (workspace_id, event_id) was authored by a DIFFERENT user — a
            # cross-user event_id collision (UNIQUE is per-workspace, not
            # per-author). We must NOT echo another author's record/sequence.
            # Reject non-disclosingly instead of leaking their coordinates.
            return RejectedEvent(
                event_id=event_id,
                code="invalid_schema",
                detail="event_id is already in use",
            )
        return original
    except UnknownStreamError:
        # Defensive: only reachable for an owner/admin LIFECYCLE event whose
        # home ``stream_id`` row does not exist (every other type's home is
        # existence-gated in validation: can_read/can_write for messages and
        # unknown types, reducer bootstrap for genesis). The savepoint rolled
        # back the reducer's side effect. D13-safe: only admins reach the
        # lifecycle branch, and stream existence is not confidential to them.
        await db.rollback()
        return RejectedEvent(
            event_id=event_id,
            code="unknown_stream",
            detail="home stream does not exist",
        )
    except DBAPIError as exc:
        # F2: narrow storability backstop. ONLY a Postgres data-domain error
        # (SQLSTATE class 22 — e.g. 22P05 for a NUL U+0000 inside a JSONB
        # string) is a permanent per-event fault the client must not retry, so
        # reject it as invalid_schema. Every OTHER DBAPIError (deadlock,
        # disconnect, timeout) is TRANSIENT and re-raised -> 500, so the client
        # retries and idempotency makes the retry safe.
        #
        # We discriminate on the Postgres SQLSTATE *class* 22 rather than
        # ``sqlalchemy.exc.DataError``: SQLAlchemy's asyncpg dialect maps only
        # integrity violations specially and funnels every other PostgresError
        # to the base ``DBAPIError``, so a NUL never surfaces as
        # ``sqlalchemy.exc.DataError`` — but the dialect does copy the SQLSTATE
        # onto ``exc.orig``. The savepoint isolated the failure; per-event
        # isolation holds for neighbors.
        sqlstate = _pg_sqlstate(exc)
        if sqlstate is None or not sqlstate.startswith(_DATA_EXCEPTION_SQLSTATE_CLASS):
            raise
        await db.rollback()
        return RejectedEvent(
            event_id=event_id,
            code="invalid_schema",
            detail="event body is not storable",
        )

    server = envelope.server
    assert server is not None  # insert_event always attaches server metadata
    accepted = AcceptedEvent(
        event_id=event_id,
        stream_id=outcome.home_stream_id,
        server_sequence=server.server_sequence,
        server_received_at=server.server_received_at,
    )
    # D9 WS seam: after commit, once per NEWLY accepted event (not re-accepts).
    await publish_event(envelope)
    return accepted


async def _fetch_original(
    db: AsyncSession, *, workspace_id: str, event_id: str
) -> tuple[AcceptedEvent, str] | None:
    """Return the ORIGINAL acceptance's four ``accepted[]`` fields + its author.

    The four fields are the D7-idempotency response; ``server_received_at`` is
    re-rendered from the stored TIMESTAMPTZ with the **same** ``to_rfc3339``
    (millisecond-``Z`` truncation) ``insert_event`` used, so the idempotent
    response string is byte-identical to the first one. The second tuple element
    is the stored ``author_user_id`` — the caller compares it against the current
    principal so a cross-user ``event_id`` collision is NOT echoed (security round
    2). The fetch is intentionally NOT author-scoped so the caller can tell a
    same-author idempotent replay from a different-author collision (vs. a
    schema-impossible fetch-miss, which returns ``None`` and re-raises, F4).
    """
    row = (
        await db.execute(
            select(
                Event.stream_id,
                Event.server_sequence,
                Event.server_received_at,
                Event.author_user_id,
            ).where(
                Event.workspace_id == workspace_id,
                Event.event_id == event_id,
            )
        )
    ).first()
    if row is None:
        return None
    stream_id, server_sequence, server_received_at, author_user_id = row
    accepted = AcceptedEvent(
        event_id=event_id,
        stream_id=stream_id,
        server_sequence=server_sequence,
        server_received_at=to_rfc3339(server_received_at),
    )
    return accepted, author_user_id
