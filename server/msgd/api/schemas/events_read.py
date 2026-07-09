"""Read-side response schemas for the pull endpoints (ENG-67, TDD §3.2).

Two response shapes plus the page constants and the server-metadata time
formatter shared by the ``GET /v1/events`` serializer:

* :class:`EventsPage` — ``{events, has_more}``.  ``events`` is deliberately typed
  ``list[dict[str, Any]]`` so **Pydantic never touches a served ``body``**: each
  event dict is assembled from raw DB row values by the router and passes through
  ``response_model`` verbatim (raw-hash discipline — see ``routers/events_read``).
  A future typed ``EventOut`` MUST keep ``body: dict[str, Any]`` (never
  ``core.Body``) or it would re-coerce the body and break
  ``hash_event(served body) == event_hash`` for unknown-type events.
* :class:`SyncStream` / :class:`SyncResponse` — real typed models built straight
  from ``streams``/``stream_members`` columns; no hash surface here.

:data:`DEFAULT_LIMIT` / :data:`MAX_LIMIT` encode the §4.3 pull-page cap; the
router clamps a client ``limit`` into ``[MIN_LIMIT, MAX_LIMIT]`` in code (never
via ``Query(ge/le)``, which would 422 instead of clamp).

The server-metadata time formatter this module used to carry (``_to_rfc3339``)
is now :func:`msgd.core.time.to_rfc3339` (the earmarked ``core/time`` dedupe,
landed with the ENG-155 shared-serialization refactor).  ``server`` is unhashed
metadata (D1), so µs→ms precision loss on the TIMESTAMPTZ read-back is not an
integrity concern.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

__all__ = [
    "DEFAULT_LIMIT",
    "MAX_LIMIT",
    "MIN_LIMIT",
    "EventsPage",
    "SyncStream",
    "SyncResponse",
]

#: §4.3 pull-page cap. Catch-up wants the biggest legal page, so the default
#: equals the max; a client ``limit`` is clamped into ``[MIN_LIMIT, MAX_LIMIT]``.
DEFAULT_LIMIT = 500
MAX_LIMIT = 500
MIN_LIMIT = 1


class EventsPage(BaseModel):
    """One page of the pull stream: raw events + a directional ``has_more``.

    ``events`` stays ``list[dict[str, Any]]`` on purpose — the router hands back
    dicts assembled verbatim from DB columns, and typing them ``Any`` keeps
    Pydantic from re-serializing (and thus re-canonicalizing) a stored ``body``.
    """

    events: list[dict[str, Any]]
    has_more: bool


class SyncStream(BaseModel):
    """One readable stream in a ``GET /v1/sync`` snapshot.

    ``name`` / ``visibility`` are ``null`` for non-channel kinds. ``member`` is
    the LEFT-JOIN existence of a ``stream_members`` row for the caller: for a
    **public channel** it is the load-bearing browser flag (join state); for
    private/dm it is always ``true`` (the row is why the stream is returned); for
    ``workspace-meta`` it is always ``false`` by construction (meta access is
    role-based, not a membership row) — clients special-case meta and ignore it.
    """

    stream_id: str
    kind: str
    name: str | None
    visibility: str | None
    head_seq: int
    member: bool
    #: ``True`` iff the channel has been archived (``streams.archived_at`` set).
    #: Archived channels stay READABLE (history access, D13) so they remain in the
    #: listing; the flag lets the client gate writes/UI (ENG-104). Always ``False``
    #: for non-channel kinds (they cannot be archived).
    archived: bool = False


class SyncResponse(BaseModel):
    """The full ``GET /v1/sync`` snapshot: every stream the caller may read."""

    streams: list[SyncStream]
