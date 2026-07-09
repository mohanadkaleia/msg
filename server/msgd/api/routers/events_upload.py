"""``POST /v1/events/batch`` — the M1 write sequencer (TDD §3.2/§4.2, ENG-66).

This router owns the *batch* half only: raw-body capture, the batch-level caps,
and per-item accepted/rejected shaping. The per-event tail — ``validate_event``
-> SAVEPOINT ``emit_event`` -> per-event commit -> ``publish_event``, plus the
D7 idempotent re-accept and the F2/F4 error discriminations — lives in
:func:`msgd.events.write.store_event` (factored out by ENG-161 so the incoming-
webhook receiver runs the IDENTICAL validated write path; the rulings are
documented there).

Batch-level rulings that stay here:

* **Raw-body capture (D2):** the handler takes a raw :class:`Request` — *no*
  bound Pydantic body param. The body is read once via a cap-and-abort stream
  (not ``request.json()``) so we control the exact byte length for the 1 MB cap
  and own JSON parse errors. Each item's ``body`` is hashed verbatim inside the
  pipeline; no model ever touches it before it is hashed and stored.
* **Batch caps (D3):** body >1 MB -> 413 ``/problems/payload-too-large``;
  >100 events -> 422 ``/problems/batch-too-large``; malformed top-level JSON ->
  422 ``/problems/validation-error``. All three reject the whole request as
  problem+json, distinct from the per-event ``payload_too_large`` code (64 KB).
"""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api import problems
from msgd.api.deps import CurrentAuth, event_rate_limit, require_scope
from msgd.api.problems import ProblemException
from msgd.api.schemas.events import AcceptedEvent, BatchUploadResponse, RejectedEvent
from msgd.db.engine import get_session
from msgd.events.write import store_event

__all__ = ["router"]

#: Batch-level caps (D3). Whole-request rejects as problem+json — distinct from
#: the per-event 64 KB ``payload_too_large`` code in ``rejected[]``.
MAX_BATCH_BODY_BYTES = 1024 * 1024  # 1 MB whole-request body cap
MAX_BATCH_EVENTS = 100  # events-per-batch count cap

router = APIRouter(prefix="/v1", tags=["events"])

DbSession = Annotated[AsyncSession, Depends(get_session)]


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
    # ENG-159: the events:write verb gate runs FIRST (a scope-less bot 403s
    # before consuming a rate-limit slot); humans (scopes=None) bypass it.
    dependencies=[Depends(require_scope("events:write")), Depends(event_rate_limit)],
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

    # --- per-event loop: the ONE shared validated write path (ENG-161) --------
    # store_event = validate (D5) -> SAVEPOINT emit -> commit -> publish, with
    # the D7 idempotent re-accept and the F2/F4 error rulings inside.
    for item in events:
        outcome = await store_event(db, ctx=ctx, item=item)
        if isinstance(outcome, RejectedEvent):
            rejected.append(outcome)
        else:
            accepted.append(outcome)

    return BatchUploadResponse(accepted=accepted, rejected=rejected)
