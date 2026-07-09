"""Shared time helper: :func:`now_rfc3339` (ENG-65 D1).

Server-authored event bodies (``workspace.created``, ``user.joined``) need an
RFC 3339 ``client_created_at`` string, and the hash is computed over that
verbatim string.  The CLI already mints one via its own ``now_rfc3339`` in
``cli/`` — but the server cannot import the CLI (§1.1 layering), so the shared
formatter lives here in ``core/`` (next to :func:`_validate_rfc3339` in
``envelope.py``) and the CLI may re-export it later.

Kept a trivial pure formatter (no new deps): UTC, millisecond precision, ``Z``
suffix — exactly the shape :func:`msgd.core.envelope._validate_rfc3339` accepts
and byte-identical to what the web client emits (``2026-07-04T18:22:10.123Z``).
"""

from __future__ import annotations

from datetime import UTC, datetime

__all__ = ["now_rfc3339", "to_rfc3339"]


def now_rfc3339() -> str:
    """Return the current UTC time as an RFC 3339 string (millisecond ``Z``)."""
    return to_rfc3339(datetime.now(UTC))


def to_rfc3339(moment: datetime) -> str:
    """Render a server timestamp as RFC 3339 (millisecond ``Z``), matching D1.

    The ONE formatter for server metadata timestamps (ENG-155): the dedupe of
    ``events.insert._format_rfc3339`` and ``api.schemas.events_read._to_rfc3339``
    that the events_read docstring earmarked for ``core/time``. A TIMESTAMPTZ
    read-back is always tz-aware; the naive fallback mirrors the origin helpers
    for total safety (``server`` metadata is unhashed — D1 — so the fallback is a
    liveness convenience, never an integrity concern).
    """
    if moment.tzinfo is None:
        moment = datetime.now(UTC)
    # ``isoformat(timespec="milliseconds")`` yields ``…+00:00``; swap the offset
    # for ``Z`` so the string matches the client wire form exactly.
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
