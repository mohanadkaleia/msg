"""Request/response schemas for ``/v1/prefs`` (ENG-124, D3).

Notification prefs are the **synced per-user KV** message class — the SAME third
kind of state as read-state, distinct from durable events (the log) and ephemeral
presence. A pref records the notification ``level`` a user wants for a stream
(``all`` / ``mentions`` / ``mute``); it syncs with a same-user cross-device WS
echo, but it is **NOT an event**: never appended to the log, never hashed, never
projected or rebuilt (the D3 negative guard proves a PUT touches no ``events``
row and no projection).

Contrast with read-state: read-state upserts **monotonically** (``GREATEST`` — a
lower value cannot rewind a marker); a pref is **last-write-wins** — a new
``level`` simply REPLACES the old one, with no ordering over the enum.

Three shapes:

* :class:`PrefLevel` — the validated enum ``all|mentions|mute``. A value outside
  it is a 422 at the request boundary (the DB ``ck_prefs_level_valid`` CHECK is
  defense-in-depth).
* :class:`PrefPut` — the ``PUT`` body ``{stream_id, level}``. No ``user_id``: the
  row is keyed on the authenticated ``ctx.user_id`` in the router, so a caller
  can neither address nor observe another user's pref (own-user by construction).
* :class:`PrefEntry` / :class:`PrefsResponse` — one explicit pref and the ``GET``
  envelope ``{prefs: [...]}``. ABSENCE of an entry means the default level
  ``all`` (the notifications consumer applies that default; GET returns only
  EXPLICIT rows, scoped to streams the caller can read).
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel

__all__ = [
    "PrefLevel",
    "PrefPut",
    "PrefEntry",
    "PrefsResponse",
]


class PrefLevel(StrEnum):
    """The notification level for a stream — the validated ``all|mentions|mute`` enum.

    ``all`` notifies on every message, ``mentions`` only on @-mentions, ``mute``
    on nothing. A request ``level`` outside these three fails validation with 422
    at the boundary; the ``ck_prefs_level_valid`` DB CHECK is defense-in-depth.
    """

    all = "all"
    mentions = "mentions"
    mute = "mute"


class PrefPut(BaseModel):
    """The ``PUT /v1/prefs`` body: set the caller's notification level for one stream.

    ``level`` is the validated :class:`PrefLevel` enum (a bad value → 422). The
    upsert is **last-write-wins** (NOT monotonic like read-state): the new
    ``level`` replaces any previous one for ``(ctx.user_id, stream_id)``. There is
    no ``user_id`` field — the row is keyed on the authenticated principal, so a
    caller can only ever set their OWN pref and there is nothing to spoof.
    """

    stream_id: str
    level: PrefLevel


class PrefEntry(BaseModel):
    """One explicit ``(stream_id, level)`` pref in the ``GET`` snapshot.

    Only streams the caller can READ and has an EXPLICIT pref row for appear —
    absence of an entry means the default level ``all`` (applied by the
    notifications consumer, not stored). No other user's pref and no pref on an
    unreadable stream is ever returned.
    """

    stream_id: str
    level: PrefLevel


class PrefsResponse(BaseModel):
    """The ``GET /v1/prefs`` snapshot: the caller's explicit prefs on readable streams.

    Also the ``PUT`` echo shape is :class:`PrefEntry`; this envelope wraps the
    GET list. Own-user only (keyed on ``ctx.user_id`` in the router).
    """

    prefs: list[PrefEntry]
