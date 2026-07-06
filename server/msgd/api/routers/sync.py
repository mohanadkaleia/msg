"""``GET /v1/sync`` — one round trip → what to pull (ENG-67, TDD §3.2).

A reconnecting client hits this first: it returns every stream the caller may
read, each with its current ``head_seq``, so the client knows what to catch up
on.  It is a **listing** and therefore **never 404s** — an unreadable stream is
simply absent (the predicate omits it); no stream id is an input, so there is
nothing to hide behind a 404.

Snapshot consistency (no torn reads):  every stream's ``head_seq`` comes from a
**single** SELECT, so the heads are mutually consistent (one Postgres snapshot).
Combined with the accept path's atomic head-bump + event-insert (D2), any
``head_seq = N`` returned here implies events ``1..N`` are already committed, so
a follow-up ``GET /v1/events?before=N+1`` cannot miss them.

Access + the ``member`` flag come from **one** ``streams LEFT JOIN
stream_members`` filtered by the shared
:func:`~msgd.events.permissions.readable_streams_predicate` (the exact fragment
pull/search/fanout reuse — no divergent second implementation, no union):

* The predicate already yields **public non-member channels for non-guests**, so
  the "channel browser" needs no extra query; the ``member`` flag is the
  LEFT-JOIN existence of the caller's row.
* ``member`` semantics — public channel: reflects join state (the load-bearing
  browser distinction); private/dm: always ``true`` (a row is why it is
  returned); ``workspace-meta``: always ``false`` by construction (meta access is
  role-based, not a membership row) — clients special-case meta and ignore it.
* **Guests (FLAGGED DEVIATION, ENG-65):** the predicate gives a guest **only**
  explicit-membership streams — **no ``workspace-meta``, no public browser** —
  so every stream a guest sees is ``member:true``. A guest is a member with
  restricted scope; giving guests meta would leak the full channel/member roster.

DM ``member_user_ids`` (the §3.2 example field for DMs) is **deferred**: no
DM-creation path ships in M1, so DMs do not appear via sync yet; the field
re-enters with the M3 DM endpoint.

Cold-start protocol (§3.2):  a fresh device pulls this endpoint, then for each
visible stream fetches the **newest page** (``GET /v1/events?before=head_seq+1``),
renders immediately, and backfills on scroll.  ``workspace-meta`` alone is synced
from sequence 1 (``after=0``) because the client needs the full channel/member
state; other streams are newest-page-first.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from msgd.api.deps import CurrentAuth
from msgd.api.schemas.events_read import SyncResponse, SyncStream
from msgd.db.engine import get_session
from msgd.db.models import Stream, StreamMember
from msgd.events.permissions import readable_streams_predicate

router = APIRouter(prefix="/v1", tags=["sync"])

DbSession = Annotated[AsyncSession, Depends(get_session)]


@router.get("/sync", response_model=SyncResponse)
async def get_sync(ctx: CurrentAuth, db: DbSession) -> SyncResponse:
    """Return every stream the caller may read + its ``head_seq`` (see module docstring).

    One snapshot ``streams LEFT JOIN stream_members`` filtered by the shared
    readable-streams predicate, ordered by ``stream_id`` for a stable listing.
    Never 404s: unreadable streams are simply absent.
    """
    predicate = readable_streams_predicate(
        user_id=ctx.user_id, role=ctx.role, workspace_id=ctx.workspace_id
    )
    # Alias the joined membership table so it never collides with the predicate's
    # own EXISTS(stream_members) subquery.
    mem = aliased(StreamMember)
    stmt = (
        select(
            Stream.stream_id,
            Stream.kind,
            Stream.name,
            Stream.visibility,
            Stream.head_seq,
            mem.user_id.isnot(None).label("member"),
        )
        .select_from(Stream)
        .outerjoin(
            mem,
            and_(mem.stream_id == Stream.stream_id, mem.user_id == ctx.user_id),
        )
        .where(predicate)
        .order_by(Stream.stream_id)
    )

    rows = (await db.execute(stmt)).all()
    return SyncResponse(
        streams=[
            SyncStream(
                stream_id=row.stream_id,
                kind=row.kind,
                name=row.name,
                visibility=row.visibility,
                head_seq=row.head_seq,
                member=bool(row.member),
            )
            for row in rows
        ]
    )
