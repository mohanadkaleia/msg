"""Request/response schemas for ``/v1/read-state`` (ENG-123, TDD §3.3 / D3).

Read-state is the **synced per-user KV** message class — a THIRD kind of state,
distinct from durable events (the log) and ephemeral presence. A read marker
records how far a user has read a stream (``last_read_seq``); it syncs
**monotonically per user** with a cross-device WS echo, but it is **NOT an
event**: never appended to the log, never hashed, never projected or rebuilt (the
D3 negative guard proves a PUT touches no ``events`` row and no projection).

Three shapes:

* :class:`ReadStatePut` — the ``PUT`` body ``{stream_id, last_read_seq}``.
  ``last_read_seq`` is ``>= 0`` (a seq is a non-negative accept counter).
* :class:`ReadMarker` — one per-stream marker in the ``GET`` bootstrap, carrying
  the unread computation for the sidebar: ``last_read_seq`` (the caller's marker,
  ``0`` when unset), ``head_seq`` (the stream's current accept head), and
  ``unread = head_seq > last_read_seq``.
* :class:`ReadStateResponse` — the ``GET`` envelope (``{streams: [...]}``) and the
  ``PUT`` echo of the EFFECTIVE marker (:class:`ReadStatePutResult`).

Own-user only by construction: every shape is keyed on the authenticated
``ctx.user_id`` in the router — a caller can neither read nor address another
user's markers. Scope is the shared readable-streams predicate, so a marker or a
``head_seq`` for an unreadable stream never appears.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

__all__ = [
    "ReadStatePut",
    "ReadStatePutResult",
    "ReadMarker",
    "ReadStateResponse",
]


class ReadStatePut(BaseModel):
    """The ``PUT /v1/read-state`` body: advance the caller's marker for one stream.

    ``last_read_seq`` is the highest ``server_sequence`` the caller has read in
    ``stream_id``. The upsert is monotonic (``GREATEST``): a value LOWER than the
    stored marker is ignored, so an out-of-order client PUT can never rewind a
    marker. ``>= 0`` because a stream's accept sequence starts at 1 and ``0`` is the
    "nothing read yet" default.
    """

    stream_id: str
    last_read_seq: int = Field(ge=0)


class ReadStatePutResult(BaseModel):
    """The ``PUT`` response: the EFFECTIVE marker after the monotonic upsert.

    ``last_read_seq`` may be the PRE-EXISTING higher value (when the incoming value
    was lower and thus ignored by ``GREATEST``) — it is the authoritative stored
    marker, and exactly the value echoed to the caller's other devices.
    """

    stream_id: str
    last_read_seq: int


class ReadMarker(BaseModel):
    """One readable stream's read marker + unread state for the sidebar bootstrap.

    ``last_read_seq`` defaults to ``0`` for a stream the caller has never marked
    (the LEFT JOIN's ``NULL`` coalesced to ``0``). ``head_seq`` is the stream's
    current accept head; ``unread`` is the derived ``head_seq > last_read_seq``.
    Only streams the caller can READ appear (shared predicate) — no ``head_seq`` or
    marker ever leaks for an unreadable stream.
    """

    stream_id: str
    last_read_seq: int
    head_seq: int
    unread: bool


class ReadStateResponse(BaseModel):
    """The ``GET /v1/read-state`` snapshot: a read marker per readable stream."""

    streams: list[ReadMarker]
