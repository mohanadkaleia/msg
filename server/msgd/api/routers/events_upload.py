"""``POST /v1/events/batch`` — the M1 write sequencer (TDD §3.2/§4.2, ENG-66).

This router **composes** the ENG-65 primitives (``emit_event`` -> reducer +
``insert_event``) behind the full §3.2 validation pipeline, per-event
accepted/rejected shaping, and idempotency. It owns the *write* half only;
ENG-67 owns the pull/sync routers (a filename that cannot collide).

Central rulings (see :mod:`msgd.events.validate` and the plan):

* **Raw-body capture (D2):** the handler takes a raw :class:`Request` — *no*
  bound Pydantic body param. The body is read once via ``request.body()`` (not
  ``request.json()``) so we control the exact byte length for the 1 MB cap and
  own JSON parse errors. Each item's ``body`` is hashed verbatim; no model ever
  touches it before it is hashed and stored.
* **Per-event transaction (D6):** a ``begin_nested()`` SAVEPOINT around
  ``emit_event`` (so a ``UNIQUE(workspace_id, event_id)`` violation is catchable
  without poisoning the session) plus a ``commit()`` **per accepted event**. The
  commit releases the ``streams`` row lock immediately, so concurrent batches to
  one stream serialize tightly into gapless sequences (§4.2). A rejected item
  opens no transaction; a bad event N cannot undo the already-committed N-1.
* **Idempotency (D7):** the UNIQUE violation is recovered by fetching the
  original row and returning its four ``accepted[]`` fields — the reducer is not
  re-run, the body is not re-hashed, and ``publish_event`` is not re-invoked.
* **Batch caps (D3):** body >1 MB -> 413 ``/problems/payload-too-large``;
  >100 events -> 422 ``/problems/batch-too-large``; malformed top-level JSON ->
  422 ``/problems/validation-error``. All three reject the whole request as
  problem+json, distinct from the per-event ``payload_too_large`` code (64 KB).
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.api.deps import CurrentAuth, event_rate_limit
from msgd.api.problems import ProblemException
from msgd.api.schemas.events import AcceptedEvent, BatchUploadResponse, RejectedEvent
from msgd.db.engine import get_session
from msgd.db.models import Event
from msgd.events.emit import emit_event
from msgd.events.fanout import publish_event
from msgd.events.insert import UnknownStreamError, _format_rfc3339
from msgd.events.validate import Accepted, validate_event

__all__ = ["router"]

#: Batch-level caps (D3). Whole-request rejects as problem+json — distinct from
#: the per-event 64 KB ``payload_too_large`` code in ``rejected[]``.
MAX_BATCH_BODY_BYTES = 1024 * 1024  # 1 MB whole-request body cap
MAX_BATCH_EVENTS = 100  # events-per-batch count cap

#: The ``UNIQUE(workspace_id, event_id)`` constraint name (naming convention,
#: migration 0001) — the ONE integrity violation the idempotent re-accept path
#: recognizes. Any other constraint is a schema-impossible state and surfaces as
#: a 500, never a per-event reject (F4).
_IDEMPOTENCY_CONSTRAINT = "uq_events_workspace_id"

#: Postgres SQLSTATE class 22 = "data exception" (e.g. 22P05, a NUL in text). The
#: ONE transient-vs-permanent discriminator for the storability backstop (F2).
_DATA_EXCEPTION_SQLSTATE_CLASS = "22"

router = APIRouter(prefix="/v1", tags=["events"])

DbSession = Annotated[AsyncSession, Depends(get_session)]


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


def _validation_error(detail: str) -> ProblemException:
    """A 422 ``/problems/validation-error`` for a malformed top-level request.

    Mirrors the app-wide RequestValidationError shape (minus the ``errors``
    extension). Raised inline rather than via a ``problems`` factory: the batch
    endpoint parses the body itself (D2), so this is a router-local concern and
    not part of the two new shared problem factories.
    """
    return ProblemException(
        status=422,
        type="/problems/validation-error",
        title="Request validation failed",
        detail=detail,
    )


async def _read_body_capped(request: Request) -> bytes:
    """Read the request body, 413ing the moment it exceeds the 1 MB batch cap (F3).

    Streams chunks and aborts on the running total rather than buffering the whole
    body and measuring after — so an oversized (possibly Content-Length-less)
    chunked upload cannot force unbounded buffering.
    """
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BATCH_BODY_BYTES:
            raise problems.payload_too_large()
        chunks.append(chunk)
    return b"".join(chunks)


@router.post(
    "/events/batch",
    response_model=BatchUploadResponse,
    dependencies=[Depends(event_rate_limit)],
)
async def upload_batch(request: Request, ctx: CurrentAuth, db: DbSession) -> BatchUploadResponse:
    """Validate, sequence, and idempotently store a batch of client events (§3.2).

    Returns 200 with an ``accepted`` / ``rejected`` partition for any well-formed
    request; only batch-level violations (D3) short-circuit to problem+json.
    """
    # --- D2/D3: raw-body capture + batch-level caps ---------------------------
    # F3: cap-and-abort streaming read. Content-Length is only a cheap fast-reject
    # (advisory — a chunked body omits or lies about it); the authoritative guard
    # is the running total below, which 413s the instant it crosses 1 MB WITHOUT
    # buffering the whole (potentially unbounded) body first. A missing
    # Content-Length is NOT rejected — legitimate chunked clients exist. Safe here
    # because nothing else on this route reads the body stream (no body-reading
    # dependency is mounted; ``event_rate_limit`` reads none).
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_BATCH_BODY_BYTES:
                raise problems.payload_too_large()
        except ValueError:
            pass  # unparseable header — fall through to the streaming guard below
    raw = await _read_body_capped(request)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise _validation_error("request body is not valid JSON") from None

    if not isinstance(data, dict):
        raise _validation_error("request body must be a JSON object")
    events = data.get("events")
    if not isinstance(events, list):
        raise _validation_error("'events' must be a list")
    if len(events) > MAX_BATCH_EVENTS:
        raise problems.batch_too_large()

    accepted: list[AcceptedEvent] = []
    rejected: list[RejectedEvent] = []

    # --- per-event loop: validate (D5) -> emit/commit/idempotency (D6/D7) -----
    for item in events:
        outcome = await validate_event(db, ctx=ctx, item=item)
        if not isinstance(outcome, Accepted):
            rejected.append(
                RejectedEvent(event_id=outcome.event_id, code=outcome.code, detail=outcome.detail)
            )
            continue

        raw_body = outcome.raw_body
        workspace_id = raw_body["workspace_id"]
        event_id = raw_body["event_id"]
        try:
            # SAVEPOINT makes the UNIQUE violation catchable; the per-event commit
            # releases the streams-row lock immediately (tight gapless serialization).
            async with db.begin_nested():
                envelope = await emit_event(
                    db, home_stream_id=outcome.home_stream_id, body=raw_body
                )
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
            original = await _fetch_original(db, workspace_id=workspace_id, event_id=event_id)
            if original is None:
                # The UNIQUE violation proved a row exists; a fetch-miss is an
                # impossible state after per-event commits — re-raise, don't reject.
                raise
            accepted.append(original)
            continue
        except UnknownStreamError:
            # Defensive: only reachable for an owner/admin LIFECYCLE event whose
            # home ``stream_id`` row does not exist (every other type's home is
            # existence-gated in validation: can_read/can_write for messages and
            # unknown types, reducer bootstrap for genesis). The savepoint rolled
            # back the reducer's side effect. D13-safe: only admins reach the
            # lifecycle branch, and stream existence is not confidential to them.
            await db.rollback()
            rejected.append(
                RejectedEvent(
                    event_id=event_id,
                    code="unknown_stream",
                    detail="home stream does not exist",
                )
            )
            continue
        except DBAPIError as exc:
            # F2: narrow storability backstop. ONLY a Postgres data-domain error
            # (SQLSTATE class 22 — e.g. 22P05 for a NUL U+0000 inside a JSONB
            # string) is a permanent per-event fault the client must not retry, so
            # reject it as invalid_schema. Every OTHER DBAPIError (deadlock,
            # disconnect, timeout) is TRANSIENT and re-raised -> 500, so the client
            # retries the batch and idempotency makes the retry safe.
            #
            # We discriminate on the Postgres SQLSTATE *class* 22 rather than
            # ``sqlalchemy.exc.DataError``: SQLAlchemy's asyncpg dialect maps only
            # integrity violations specially and funnels every other PostgresError
            # to the base ``DBAPIError``, so a NUL never surfaces as
            # ``sqlalchemy.exc.DataError`` — but the dialect does copy the SQLSTATE
            # onto ``exc.orig``. The savepoint isolated the failure; per-event
            # isolation (point 5) holds for neighbors.
            sqlstate = _pg_sqlstate(exc)
            if sqlstate is None or not sqlstate.startswith(_DATA_EXCEPTION_SQLSTATE_CLASS):
                raise
            await db.rollback()
            rejected.append(
                RejectedEvent(
                    event_id=event_id,
                    code="invalid_schema",
                    detail="event body is not storable",
                )
            )
            continue

        server = envelope.server
        assert server is not None  # insert_event always attaches server metadata
        accepted.append(
            AcceptedEvent(
                event_id=event_id,
                stream_id=outcome.home_stream_id,
                server_sequence=server.server_sequence,
                server_received_at=server.server_received_at,
            )
        )
        # D9 WS seam: after commit, once per NEWLY accepted event (not re-accepts).
        await publish_event(envelope)

    return BatchUploadResponse(accepted=accepted, rejected=rejected)


async def _fetch_original(
    db: AsyncSession, *, workspace_id: str, event_id: str
) -> AcceptedEvent | None:
    """Return the ORIGINAL acceptance's four ``accepted[]`` fields (D7 idempotency).

    ``server_received_at`` is re-rendered from the stored TIMESTAMPTZ with the
    **same** ``_format_rfc3339`` (millisecond-``Z`` truncation) ``insert_event``
    used, so the idempotent response string is byte-identical to the first one.

    Returns ``None`` if no row is found — a state the caller treats as
    schema-impossible and re-raises on (F4), never shaping it into a reject.
    """
    row = (
        await db.execute(
            select(Event.stream_id, Event.server_sequence, Event.server_received_at).where(
                Event.workspace_id == workspace_id,
                Event.event_id == event_id,
            )
        )
    ).first()
    if row is None:
        return None
    stream_id, server_sequence, server_received_at = row
    return AcceptedEvent(
        event_id=event_id,
        stream_id=stream_id,
        server_sequence=server_sequence,
        server_received_at=_format_rfc3339(server_received_at),
    )
