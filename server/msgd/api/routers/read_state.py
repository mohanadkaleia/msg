"""``/v1/read-state`` — synced per-user KV read markers + WS echo (ENG-123, D3).

THE D3 MESSAGE CLASS — READ BEFORE TOUCHING THIS FILE. Read-state is a THIRD kind
of state, distinct from the two the rest of the server already knows:

* **durable events** — the append-only, hashed, projected/rebuilt log (§2); and
* **ephemeral presence/typing** — transient, never stored.

A read marker is neither. It is **synced per-user KV**: a ``(user_id, stream_id)
-> last_read_seq`` row that syncs **monotonically per user** with a cross-device
WS echo, but it is **NOT an event** — never appended to the log, never hashed,
never projected, never rebuilt. Nothing here writes ``events`` or any
``*_proj`` table (the D3 negative-guard test asserts a PUT leaves the ``events``
count and every projection dump unchanged). The client's Dexie ``read_state``
table is correspondingly exempt from log-rebuild (ENG-126).

Security crux — **isolation** (three independent gates, all keyed on the
authenticated principal):

1. **Own-user only, by construction.** Every read and write is keyed on
   ``ctx.user_id``; a caller can neither address nor observe another user's
   markers. There is no user-id input to spoof.
2. **Readable-stream scope.** A caller may set a marker ONLY on a stream it can
   READ — the shared :func:`~msgd.events.permissions.can_read` predicate gates the
   PUT, and GET scopes to the same readable set. An unreadable / unknown stream is
   a uniform ``404 /problems/not-found`` (no existence oracle — a stream you can't
   read is indistinguishable from one that doesn't exist).
3. **Same-user-only WS echo.** After the authoritative commit the PUT echoes a
   ``read_state`` frame to the caller's OWN other connections via
   :meth:`~msgd.ws.hub.Hub.publish_read_state` — a direct ``_by_user[user_id]``
   lookup, NOT the event-fanout stream resolve. No other user ever receives it.

Monotonic upsert: ``INSERT … ON CONFLICT (user_id, stream_id) DO UPDATE SET
last_read_seq = GREATEST(existing, incoming)``. A LOWER incoming value is IGNORED
(an out-of-order client PUT cannot rewind a marker); the ``RETURNING`` clause
yields the EFFECTIVE value (possibly the pre-existing higher one), which is what
the response and the echo carry.

Best-effort echo (§3.3): the DB write is authoritative; the echo is a convenience
hint. A WS-send failure/timeout MUST NOT fail the PUT — the hub timeout-guards and
drops a wedged socket without propagating, and the call is additionally wrapped so
an unexpected hub error is swallowed. The client reconciles from its own GET/PUT
regardless.

The hub is imported **function-locally** in the PUT (mirroring
:func:`msgd.events.fanout.publish_event`) to avoid an ``api`` ↔ ``ws`` import
cycle at module load.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from msgd.api import problems
from msgd.api.deps import CurrentAuth, read_state_rate_limit
from msgd.api.schemas.read_state import (
    ReadMarker,
    ReadStatePut,
    ReadStatePutResult,
    ReadStateResponse,
)
from msgd.db.engine import get_session
from msgd.db.models import ReadState, Stream
from msgd.events.permissions import can_read, readable_streams_predicate

router = APIRouter(prefix="/v1", tags=["read-state"])

DbSession = Annotated[AsyncSession, Depends(get_session)]


@router.put(
    "/read-state",
    response_model=ReadStatePutResult,
    dependencies=[Depends(read_state_rate_limit)],
)
async def put_read_state(ctx: CurrentAuth, db: DbSession, body: ReadStatePut) -> ReadStatePutResult:
    """Advance the caller's read marker for ``body.stream_id`` (see module docstring).

    Gate: the caller may set a marker ONLY on a stream it can READ — else a uniform
    ``404 /problems/not-found`` (unreadable and unknown are indistinguishable, no
    oracle). Own-user only (keyed on ``ctx.user_id``). The upsert is monotonic
    (``GREATEST``), so a lower incoming ``last_read_seq`` is ignored and the stored
    higher value is returned. After commit, best-effort echoes the EFFECTIVE value
    to the caller's OWN other devices; a failed echo never fails the PUT.
    """
    if not await can_read(db, ctx=ctx, stream_id=body.stream_id):
        # 404-not-403: existence is never disclosed (§3.6.2). A stream the caller
        # cannot read is indistinguishable from one that does not exist.
        raise problems.not_found("no such stream")

    # Monotonic upsert. GREATEST(existing, incoming) so a lower incoming value is a
    # no-op; RETURNING yields the EFFECTIVE stored marker (possibly the prior higher
    # value). NOT an event — a plain KV write to `read_state`, no log/projection.
    insert_stmt = pg_insert(ReadState).values(
        user_id=ctx.user_id,
        stream_id=body.stream_id,
        last_read_seq=body.last_read_seq,
    )
    upsert = insert_stmt.on_conflict_do_update(
        index_elements=[ReadState.user_id, ReadState.stream_id],
        set_={
            "last_read_seq": func.greatest(
                ReadState.last_read_seq, insert_stmt.excluded.last_read_seq
            ),
            "updated_at": func.now(),
        },
    ).returning(ReadState.last_read_seq)

    effective = await db.scalar(upsert)
    await db.commit()
    # ON CONFLICT DO UPDATE always returns the affected row; the coalesce is a
    # belt-and-suspenders narrow for the type checker (never None in practice).
    effective_seq = int(effective if effective is not None else body.last_read_seq)

    # Best-effort cross-device echo (§3.3). The hub reaches ONLY _by_user[user_id]
    # (same-user isolation) and timeout-guards each send; the wrap additionally
    # swallows any unexpected hub error so the authoritative write never fails on it.
    try:
        from msgd.ws.hub import hub

        await hub.publish_read_state(
            user_id=ctx.user_id, stream_id=body.stream_id, last_read_seq=effective_seq
        )
    except Exception:  # noqa: BLE001 — echo is a hint; a send/hub failure must not fail the PUT
        pass

    return ReadStatePutResult(stream_id=body.stream_id, last_read_seq=effective_seq)


@router.get("/read-state", response_model=ReadStateResponse)
async def get_read_state(ctx: CurrentAuth, db: DbSession) -> ReadStateResponse:
    """Return the caller's read markers + unread state for every readable stream.

    The sidebar-bootstrap snapshot: one row per stream the caller can READ, each
    ``{stream_id, last_read_seq, head_seq, unread}``. ``read_state`` is LEFT-JOINed
    onto the readable ``streams`` (the shared predicate), defaulting an absent
    marker to ``last_read_seq = 0``; ``unread = head_seq > last_read_seq``. Own-user
    only (``ctx.user_id``). Unreadable streams are simply absent — no ``head_seq`` or
    marker ever leaks across the readable boundary (never 404s: no stream id input).
    """
    predicate = readable_streams_predicate(
        user_id=ctx.user_id, role=ctx.role, workspace_id=ctx.workspace_id
    )
    # Alias so the LEFT JOIN's own-user membership never collides with the
    # predicate's EXISTS(stream_members) subquery.
    rs = aliased(ReadState)
    last_read = func.coalesce(rs.last_read_seq, 0)
    stmt = (
        select(
            Stream.stream_id,
            Stream.head_seq,
            last_read.label("last_read_seq"),
        )
        .select_from(Stream)
        .outerjoin(rs, and_(rs.stream_id == Stream.stream_id, rs.user_id == ctx.user_id))
        .where(predicate)
        .order_by(Stream.stream_id)
    )

    rows = (await db.execute(stmt)).all()
    return ReadStateResponse(
        streams=[
            ReadMarker(
                stream_id=row.stream_id,
                last_read_seq=row.last_read_seq,
                head_seq=row.head_seq,
                unread=row.head_seq > row.last_read_seq,
            )
            for row in rows
        ]
    )
