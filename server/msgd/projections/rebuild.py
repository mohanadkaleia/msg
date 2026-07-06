"""``rebuild_projections`` — drop ``messages_proj`` and replay ``events`` (ENG-69).

The Postgres analogue of the M0 ``msgctl rebuild``.  M0 rebuilt into a temp
SQLite file and ``os.replace``-swapped it, because a SQLite DB *is* a file;
Postgres cannot rename a table, so the atomicity primitive changes from *rename*
to **transaction / MVCC**:

**Single-transaction ``TRUNCATE messages_proj`` + streamed replay, committed once.**

* **Atomic by MVCC.** Until the single ``COMMIT``, concurrent readers see the
  pre-rebuild snapshot; after commit they see the fully-rebuilt state.  There is
  never a partial projection — the Postgres analogue of ENG-59's "an interrupted
  rebuild leaves the previous projection intact".
* **Safe to interrupt.** Any exception / kill before ``COMMIT`` rolls the whole
  txn back and ``messages_proj`` is untouched.  Delivered by the txn boundary
  instead of ``os.replace``.
* **Rebuild ≡ incremental by construction.** Replay reuses the *exact* same
  :func:`~msgd.projections.apply.apply_projection` the accept path uses.  A
  single source of apply is what makes the equivalence true (M0 rebuild reused
  ``project``; we reuse ``apply_projection``).

Replay order ``(stream_id, server_sequence)`` is fixed for reproducibility.  The
final state is order-independent (``message_id`` is immutable, ``ON CONFLICT DO
NOTHING``), but a deterministic order keeps a single run reproducible.

**Locking property (M1, documented).**  ``TRUNCATE`` takes an ``ACCESS
EXCLUSIVE`` lock, briefly blocking concurrent reads of ``messages_proj`` for the
rebuild's duration.  Acceptable for a single-operator admin op at M1 scale.  If
read-during-rebuild concurrency ever matters, ``DELETE FROM messages_proj``
(ROW EXCLUSIVE, MVCC-invisible to other snapshots until commit) is the drop-in
alternative — noted, not chosen now.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.db.models import Event
from msgd.projections.apply import apply_projection

__all__ = ["RebuildResult", "rebuild_projections"]


@dataclass
class RebuildResult:
    """Outcome of a :func:`rebuild_projections` run (mirrors M0 ``ProjectResult``).

    ``applied`` counts events that projected a row; ``skipped`` counts events
    replayed but not projected (meta / unknown types / unhandled versions — D9).
    """

    applied: int = 0
    skipped: int = 0


async def _iter_events(session: AsyncSession) -> AsyncIterator[tuple[dict[str, Any], int]]:
    """Stream ``(body, server_sequence)`` for every event in replay order.

    ``ORDER BY stream_id, server_sequence`` is the fixed, reproducible replay
    order.  ``.stream()`` (server-side cursor / ``yield_per``) keeps a large log
    from being fully materialized in memory.
    """
    result = await session.stream(
        select(Event.body, Event.server_sequence).order_by(Event.stream_id, Event.server_sequence)
    )
    async for body, server_sequence in result:
        yield body, server_sequence


async def rebuild_projections(session: AsyncSession) -> RebuildResult:
    """TRUNCATE ``messages_proj`` and replay the whole ``events`` log, atomically.

    Runs as ONE transaction committed exactly once: the ``TRUNCATE`` and every
    replayed apply share a snapshot that only becomes visible at ``COMMIT``
    (MVCC atomicity).  A raise before the commit rolls everything back, leaving
    the prior projection intact (interrupt safety).  Returns a
    :class:`RebuildResult` for the CLI summary.
    """
    await session.execute(text("TRUNCATE messages_proj"))
    result = RebuildResult()
    async for body, server_sequence in _iter_events(session):
        if await apply_projection(session, body=body, server_sequence=server_sequence):
            result.applied += 1
        else:
            result.skipped += 1
    await session.commit()
    return result
