"""``/v1/prefs`` — synced per-user KV notification prefs + WS echo (ENG-124, D3).

THE D3 MESSAGE CLASS — READ BEFORE TOUCHING THIS FILE. Notification prefs are the
SAME third kind of state as read-state (ENG-123): **synced per-user KV**, neither
a durable event (the append-only, hashed, projected/rebuilt log) nor ephemeral
presence/typing. A pref is a ``(user_id, stream_id) -> level`` row that syncs with
a same-user cross-device WS echo, but it is **NOT an event** — never appended to
the log, never hashed, never projected, never rebuilt. Nothing here writes
``events`` or any ``*_proj`` table (the D3 negative-guard test asserts a PUT
leaves the ``events`` count and every projection dump unchanged, while a ``prefs``
row appears). ``level`` ∈ ``{all, mentions, mute}`` selects notification
behaviour; ABSENCE of a row means the default ``all`` (the notifications consumer
applies that default — GET returns only EXPLICIT rows).

**LWW, not monotonic — the one behavioural difference from read-state.** A read
marker upserts with ``GREATEST`` (a lower ``last_read_seq`` cannot rewind it); a
pref is a plain **last-write-wins** overwrite: ``ON CONFLICT (user_id, stream_id)
DO UPDATE SET level = EXCLUDED.level, updated_at = now()``. Setting ``mute`` after
``all`` REPLACES ``all`` — there is no ordering over the enum, the newest write is
the truth.

Security crux — **isolation** (identical to read-state; three independent gates,
all keyed on the authenticated principal):

1. **Own-user only, by construction.** Every read and write is keyed on
   ``ctx.user_id``; the ``PUT`` body carries NO ``user_id``, so a caller can
   neither address nor observe another user's prefs. Nothing to spoof.
2. **Readable-stream scope.** A caller may set a pref ONLY on a stream it can
   READ — the shared :func:`~msgd.events.permissions.can_read` predicate gates the
   PUT, and GET scopes to the same readable set. An unreadable / unknown stream is
   a uniform ``404 /problems/not-found`` (no existence oracle).
3. **Same-user-only WS echo.** After the authoritative commit the PUT echoes a
   ``prefs`` frame to the caller's OWN other connections via
   :meth:`~msgd.ws.hub.Hub.publish_prefs` — a direct ``_by_user[user_id]`` lookup,
   NOT the event-fanout stream resolve. No other user ever receives it.

``level`` is guarded twice: the Pydantic :class:`~msgd.api.schemas.prefs.PrefLevel`
enum 422s a bad value at the boundary, and the ``ck_prefs_level_valid`` DB CHECK
is defense-in-depth.

Best-effort echo (§3.3): the DB write is authoritative; the echo is a convenience
hint. A WS-send failure/timeout MUST NOT fail the PUT — the hub timeout-guards and
drops a wedged socket without propagating, and the call is additionally wrapped so
an unexpected hub error is swallowed. The client reconciles from its own GET/PUT.

The hub is imported **function-locally** in the PUT (mirroring
:func:`msgd.events.fanout.publish_event` and the read-state router) to avoid an
``api`` ↔ ``ws`` import cycle at module load.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from msgd.api import problems
from msgd.api.deps import CurrentAuth, prefs_rate_limit
from msgd.api.schemas.prefs import PrefEntry, PrefLevel, PrefPut, PrefsResponse
from msgd.db.engine import get_session
from msgd.db.models import Pref, Stream
from msgd.events.permissions import can_read, readable_streams_predicate

router = APIRouter(prefix="/v1", tags=["prefs"])

DbSession = Annotated[AsyncSession, Depends(get_session)]


@router.put(
    "/prefs",
    response_model=PrefEntry,
    dependencies=[Depends(prefs_rate_limit)],
)
async def put_prefs(ctx: CurrentAuth, db: DbSession, body: PrefPut) -> PrefEntry:
    """Set the caller's notification ``level`` for ``body.stream_id`` (see module docstring).

    Gate: the caller may set a pref ONLY on a stream it can READ — else a uniform
    ``404 /problems/not-found`` (unreadable and unknown are indistinguishable, no
    oracle). Own-user only (keyed on ``ctx.user_id``; no ``user_id`` in the body).
    The upsert is **last-write-wins** (NOT monotonic): the incoming ``level``
    replaces any previous one. After commit, best-effort echoes the stored level to
    the caller's OWN other devices; a failed echo never fails the PUT.
    """
    if not await can_read(db, ctx=ctx, stream_id=body.stream_id):
        # 404-not-403: existence is never disclosed (§3.6.2). A stream the caller
        # cannot read is indistinguishable from one that does not exist.
        raise problems.not_found("no such stream")

    # Last-write-wins upsert. The incoming level REPLACES any prior one (no
    # GREATEST — a pref has no ordering, the newest write is the truth). NOT an
    # event — a plain KV write to `prefs`, no log/projection.
    level_value = body.level.value
    insert_stmt = pg_insert(Pref).values(
        user_id=ctx.user_id,
        stream_id=body.stream_id,
        level=level_value,
    )
    upsert = insert_stmt.on_conflict_do_update(
        index_elements=[Pref.user_id, Pref.stream_id],
        set_={
            "level": insert_stmt.excluded.level,
            "updated_at": func.now(),
        },
    ).returning(Pref.level)

    stored = await db.scalar(upsert)
    await db.commit()
    # ON CONFLICT DO UPDATE always returns the affected row; the fallback narrows
    # the type checker (never None in practice).
    effective_level = str(stored) if stored is not None else level_value

    # Best-effort cross-device echo (§3.3). The hub reaches ONLY _by_user[user_id]
    # (same-user isolation) and timeout-guards each send; the wrap additionally
    # swallows any unexpected hub error so the authoritative write never fails on it.
    try:
        from msgd.ws.hub import hub

        await hub.publish_prefs(
            user_id=ctx.user_id, stream_id=body.stream_id, level=effective_level
        )
    except Exception:  # noqa: BLE001 — echo is a hint; a send/hub failure must not fail the PUT
        pass

    return PrefEntry(stream_id=body.stream_id, level=PrefLevel(effective_level))


@router.get("/prefs", response_model=PrefsResponse)
async def get_prefs(ctx: CurrentAuth, db: DbSession) -> PrefsResponse:
    """Return the caller's EXPLICIT notification prefs for streams they can read.

    One entry per stream the caller can READ **and** has an explicit ``prefs`` row
    for. ``prefs`` is INNER-JOINed onto the readable ``streams`` (the shared
    predicate), so a pref on a stream the caller can no longer read is dropped and
    no other user's pref is ever visible (own-user, keyed on ``ctx.user_id``).
    ABSENCE of an entry means the default level ``all`` — the notifications
    consumer applies that default; GET returns only explicit rows. Never 404s (no
    stream-id input).
    """
    predicate = readable_streams_predicate(
        user_id=ctx.user_id, role=ctx.role, workspace_id=ctx.workspace_id
    )
    # Alias so the JOIN's own-user membership never collides with the predicate's
    # EXISTS(stream_members) subquery. INNER join: only streams WITH an explicit
    # pref row appear (absence = default `all`, not stored).
    p = aliased(Pref)
    stmt = (
        select(p.stream_id, p.level)
        .select_from(Stream)
        .join(p, and_(p.stream_id == Stream.stream_id, p.user_id == ctx.user_id))
        .where(predicate)
        .order_by(p.stream_id)
    )

    rows = (await db.execute(stmt)).all()
    return PrefsResponse(
        prefs=[PrefEntry(stream_id=row.stream_id, level=PrefLevel(row.level)) for row in rows]
    )
