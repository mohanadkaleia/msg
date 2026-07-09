"""``GET /v1/events`` — the pull endpoint: forward catch-up + backward backfill (ENG-67).

Cursors are the source of truth for the whole protocol (§3.2); the WS push is
only ever a hint (§3.3).  This endpoint serves one page of a stream's log, in a
direction chosen by which cursor is present:

======  ======  =============================================================
after   before  behavior
======  ======  =============================================================
set     unset   **forward catch-up** — ``server_sequence > after`` ascending
unset   set     **backward backfill** — newest page with ``server_sequence <
                before``, returned ascending
unset   unset   **first page from seq 1** (≡ ``after=0``) — the "from start"
                default
set     set     **422** ``/problems/invalid-cursor``
======  ======  =============================================================

Both directions return the page **ascending within the page** (ticket contract).
``has_more`` is direction-relative and computed from a single
``LIMIT effective+1`` SELECT (no second count query, so the flag is
snapshot-consistent with the page):

* **forward:** ``has_more`` ⇒ more **newer** events exist; the client advances
  with ``after = last_returned_seq``.
* **backward:** ``has_more`` ⇒ more **older** events exist; the client walks back
  with ``before = first_returned_seq``.

Cold-start protocol (§3.2):  a fresh device pulls ``GET /v1/sync``, then for each
visible stream fetches the **newest page** (``before = head_seq + 1``), renders
immediately, and backfills on scroll (``before = oldest_loaded``).
``workspace-meta`` alone is synced from sequence 1 (``after=0``) because the
client needs the full channel/member state; other streams are newest-page-first.
Forward catch-up (``after = last_contiguous_seq``) is the reconnect path.

No torn reads:  each request reads within one per-request snapshot (READ
COMMITTED), and the accept path bumps ``head_seq`` **and** inserts the event row
in the same transaction (D2) — so any ``head_seq = N`` a reader has seen implies
events ``1..N`` are already visible; a follow-up ``before = N+1`` cannot miss them.

**Serialization is raw (D1):** each event is assembled verbatim from DB row
values — the JSONB ``body`` straight through, ``event_hash`` / ``payload_redacted``
/ ``server_received_at`` from columns, ``signature`` reserved-null (no column).
It is **never** regenerated through ``core.Envelope`` / ``Body.model_dump``, so
``hash_event(response["body"]) == response["event_hash"]`` holds for **every**
event, including unknown-type events (opaque bodies survive untouched).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api.deps import CurrentAuth, require_readable_stream
from msgd.api.problems import ProblemException
from msgd.api.schemas.events_read import (
    MAX_LIMIT,
    MIN_LIMIT,
    EventsPage,
)
from msgd.db.engine import get_session
from msgd.db.models import Event
from msgd.events.serialize import serialize_stored_event

router = APIRouter(prefix="/v1", tags=["events"])

DbSession = Annotated[AsyncSession, Depends(get_session)]


def _invalid_cursor() -> ProblemException:
    """Both ``after`` and ``before`` supplied — the one mutually-exclusive pair.

    Constructed inline (not a ``problems`` factory) because ``problems.py`` is a
    shared file this ticket does not edit; promoting to a named factory is an
    optional post-M1 cleanup.
    """
    return ProblemException(
        status=422,
        type="/problems/invalid-cursor",
        title="Invalid cursor",
        detail="specify at most one of after/before",
    )


# The envelope-dict construction is SHARED with `msgctl export` (ENG-155): both
# import msgd.events.serialize.serialize_stored_event, so the pull wire form and
# the §9 export NDJSON form can never drift. The local name is kept for the
# module docstring's "Serialization is raw (D1)" narrative and existing callers.
_serialize_event = serialize_stored_event


@router.get("/events", response_model=EventsPage)
async def get_events(
    ctx: CurrentAuth,
    db: DbSession,
    stream_id: Annotated[str, Depends(require_readable_stream)],
    after: Annotated[int | None, Query(ge=0)] = None,
    before: Annotated[int | None, Query(ge=0)] = None,
    limit: Annotated[int, Query()] = MAX_LIMIT,
) -> EventsPage:
    """Return one ascending page of ``stream_id``'s log (see the module docstring).

    ``stream_id`` is authorized *and* provided by
    :func:`~msgd.api.deps.require_readable_stream`: an unknown stream and a
    private stream the caller cannot read both yield the identical
    ``404 /problems/not-found`` (existence never disclosed, §3.6.2); a missing
    ``stream_id`` is a ``422`` (required query param).

    ``limit`` is clamped in code to ``[MIN_LIMIT, MAX_LIMIT]`` (§4.3) — a huge or
    non-positive value never errors. Supplying **both** ``after`` and ``before``
    is a ``422 /problems/invalid-cursor``.
    """
    if after is not None and before is not None:
        raise _invalid_cursor()

    effective = min(max(limit, MIN_LIMIT), MAX_LIMIT)

    stmt = select(Event).where(Event.stream_id == stream_id)
    if before is not None:
        # Backward backfill: newest `effective` events strictly below `before`.
        # Fetch DESC (so the LIMIT keeps the newest), then reverse to ascending.
        stmt = stmt.where(Event.server_sequence < before).order_by(Event.server_sequence.desc())
    else:
        # Forward catch-up (and the no-param default ≡ after=0): oldest events
        # strictly above `after`, ascending.
        after_seq = after if after is not None else 0
        stmt = stmt.where(Event.server_sequence > after_seq).order_by(Event.server_sequence.asc())
    # Single snapshot-consistent SELECT: fetch one extra row to detect a further
    # page in this direction without a second count query.
    stmt = stmt.limit(effective + 1)

    rows = list((await db.execute(stmt)).scalars().all())
    has_more = len(rows) > effective
    rows = rows[:effective]  # trim the sentinel extra (largest seq fwd / smallest bwd)
    if before is not None:
        rows.reverse()  # DESC fetch → ascending page

    return EventsPage(events=[_serialize_event(row) for row in rows], has_more=has_more)
