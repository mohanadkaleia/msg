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

:func:`_to_rfc3339` mirrors ``events.insert._format_rfc3339`` exactly (that
helper is private to ENG-65's file; post-M1 both dedupe into ``core/time`` — a
follow-up that would touch a shared module, so not this ticket).  ``server`` is
unhashed metadata (D1), so µs→ms precision loss on the TIMESTAMPTZ read-back is
not an integrity concern.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from msgd.core.time import now_rfc3339

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


def _to_rfc3339(moment: datetime) -> str:
    """Render a server timestamp as RFC 3339 (millisecond ``Z``), matching D1.

    Mirrors ``events.insert._format_rfc3339`` (kept private to that file). A
    TIMESTAMPTZ read-back is always tz-aware; the naive fallback matches the
    origin helper for total safety.
    """
    if moment.tzinfo is None:
        return now_rfc3339()
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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


class SyncResponse(BaseModel):
    """The full ``GET /v1/sync`` snapshot: every stream the caller may read."""

    streams: list[SyncStream]
