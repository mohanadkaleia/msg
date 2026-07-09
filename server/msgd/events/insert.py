"""``insert_event`` — the minimal server-side event-insert primitive (ENG-65 D1).

This is the sequence-assignment + row-insert + hash primitive that ENG-66's
``POST /v1/events/batch`` will wrap in the full §3.2 validation pipeline.  It
does the smallest correct thing and nothing more:

1. **Hash the raw body** — ``event_hash = hash_event(body)`` over the verbatim
   dict (ENG-56 raw-hash discipline).  Here the server *is* the source of truth,
   so the dict passed in is authoritative and stored verbatim.  ``JCSError``
   propagates to the caller.
2. **Assign the sequence** with the §3.1 canonical statement
   ``UPDATE streams SET head_seq = head_seq + 1 WHERE stream_id = :sid
   RETURNING head_seq`` — one atomic statement that takes a row-level write lock
   on the ``streams`` row, so concurrent inserts to the same stream serialize
   into a gapless, monotonic sequence (D2).  A missing row raises
   :class:`UnknownStreamError` (the caller must bootstrap the row first — D4).
3. **Insert the ``events`` row** verbatim (``body`` is the sole hash source).
3b. **Apply to ``messages_proj``** (ENG-69) — ``apply_projection`` materializes the
   incremental projection *in the same transaction* (§4.2 accept ordering: insert
   into ``events`` → apply to ``messages_proj`` → commit).  It runs BEFORE the
   ``Envelope`` is built and does not commit, so a projection failure rolls back
   the ``events`` insert with it — the event is rejected, never stored without its
   projection.  Only ``message.created`` v1 writes a row; every other type is a
   D9 no-op.
4. **Return** the stored :class:`~msgd.core.envelope.Envelope`.

What it deliberately does **NOT** do (ENG-66 owns these): schema validation,
``event_hash`` recompute-and-compare against a client hash, author-matches-session
checks, referential checks, the 64 KB size cap, and **idempotency by**
``event_id``.  It assumes a fresh, server-trusted body — true for both M1 callers
(two server-authored events with freshly minted ``event_id``s).  It **does not
commit** — it runs inside the caller's transaction.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.core.envelope import Body, Envelope, ServerMetadata
from msgd.core.hashing import hash_event
from msgd.core.time import to_rfc3339
from msgd.db.models import Event, Stream
from msgd.projections.apply import apply_projection

__all__ = ["UnknownStreamError", "insert_event"]


class UnknownStreamError(Exception):
    """Raised when :func:`insert_event` targets a ``streams`` row that does not exist.

    The row must be bootstrapped (by the reducer, D4) before an event can be
    sequenced into it — the sequence bump locks that row.
    """

    def __init__(self, stream_id: str) -> None:
        self.stream_id = stream_id
        super().__init__(f"unknown stream: {stream_id!r}")


async def insert_event(db: AsyncSession, *, stream_id: str, body: dict[str, Any]) -> Envelope:
    """Sequence + insert one server-trusted ``body`` into ``stream_id`` (D1).

    Runs entirely inside the caller's transaction and does not commit.  Returns
    the stored :class:`Envelope` (body + hash + server metadata).

    Raises:
        UnknownStreamError: if the ``streams`` row does not exist.
        JCSError: propagated from :func:`hash_event` for out-of-domain bodies.
    """
    # 1. Hash the raw, verbatim body — the sole hash input (D1/ENG-56).
    event_hash = hash_event(body)

    # 2. Assign the sequence: a single row-locked UPDATE ... RETURNING (§3.1).
    #    Concurrent inserts to the same stream serialize on this row lock, so the
    #    per-stream sequence is gapless and monotonic (D2).
    result = await db.execute(
        update(Stream)
        .where(Stream.stream_id == stream_id)
        .values(head_seq=Stream.head_seq + 1)
        .returning(Stream.head_seq)
    )
    row = result.first()
    if row is None:
        # Caller must bootstrap the row first (D4: reducer-before-insert).
        raise UnknownStreamError(stream_id)
    server_sequence: int = row[0]

    # 3. Insert the events row verbatim. ``client_created_at`` is parsed out of
    #    the body's RFC3339 string into the (lossy, untrusted) convenience column
    #    — never re-hashed (Event HASH-INVARIANT docstring); ``body`` JSONB is the
    #    sole hash source. ``server_received_at`` is server time (now()).
    received_at = datetime.now(UTC)
    db.add(
        Event(
            workspace_id=body["workspace_id"],
            event_id=body["event_id"],
            stream_id=stream_id,
            server_sequence=server_sequence,
            type=body["type"],
            type_version=body["type_version"],
            author_user_id=body["author_user_id"],
            author_device_id=body["author_device_id"],
            client_created_at=datetime.fromisoformat(body["client_created_at"]),
            server_received_at=received_at,
            event_hash=event_hash,
            payload_redacted=False,
            body=body,
        )
    )
    await db.flush()

    # 3b. Apply the incremental projection in this same transaction (ENG-69): only
    #     message.created v1 writes a messages_proj row; every other type is a D9
    #     no-op. A raise here propagates out of the caller's per-event SAVEPOINT →
    #     the events insert + head_seq bump roll back together → the event is
    #     rejected, never stored without its projection (accept-path ordering,
    #     §4.2). Deliberately NOT wrapped in a catch: a projection failure on a
    #     pre-validated payload is a bug that must be loud (500), not silently
    #     shaped into a per-event reject that could let the log and projection
    #     diverge (ENG-69 Pin 5, loud-is-preferable-to-silent-divergence).
    await apply_projection(db, body=body, server_sequence=server_sequence)

    # 4. Return the stored envelope for the caller / ENG-66 response shaping.
    return Envelope(
        body=Body(**body),
        event_hash=event_hash,
        signature=None,
        server=ServerMetadata(
            server_sequence=server_sequence,
            server_received_at=to_rfc3339(received_at),
            payload_redacted=False,
        ),
    )
