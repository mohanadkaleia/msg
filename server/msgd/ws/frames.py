"""Pure WebSocket frame builders + protocol constants (TDD §3.3).

No socket I/O lives here — every helper is a pure transform, so frame shaping is
unit-testable without a connection (the §6a hash-fidelity guard runs directly
against :func:`event_frame`).

**Server → client frames (M1):**

* ``{"t": "event", "event": {envelope}}`` — a stored event, byte-shaped
  identically to the pull endpoint (``events_read._serialize_event``):
  ``{"body": <raw body>, "event_hash": <str>, "signature": null,
  "server": {"server_sequence", "server_received_at", "payload_redacted"}}``.
  Raw-body-faithful + hash-valid for **every** event, including unknown types.
* ``{"t": "pong"}`` — reply to a client ``{"t": "ping"}``.
* ``{"t": "ping"}`` — server heartbeat probe.

**Client → server frames:** ``{"t": "ping"}`` / ``{"t": "pong"}`` and the inbound
``{"t": "typing", "stream_id": …}`` signal (ENG-125). An inbound ``presence`` frame
stays IGNORED — presence is server-derived, never client-asserted. Any other /
unknown / malformed inbound frame is ignored (D9 tolerance).

**Signal-class ``t`` values** (the non-event surface, D3): server→client
``read_state`` (ENG-123, synced KV) / ``prefs`` (ENG-124, synced KV) / ``presence``
+ ``typing`` (ENG-125, EPHEMERAL — WS-only, never persisted/projected/exported).
All are named in ``RESERVED_*`` so each ticket *extends* rather than redefines the
``t`` space.
"""

from __future__ import annotations

from enum import IntEnum
from typing import Any, Final

from msgd.core.envelope import Envelope

__all__ = [
    "WSCloseCode",
    "PING",
    "PONG",
    "RESERVED_SERVER_FRAME_TYPES",
    "RESERVED_CLIENT_FRAME_TYPES",
    "event_frame",
    "read_state_frame",
    "prefs_frame",
    "presence_frame",
    "typing_frame",
]


class WSCloseCode(IntEnum):
    """Application WebSocket close codes (the 4000–4999 private range, §3.3/§4.3).

    Each mirrors the HTTP status it corresponds to so the code is self-documenting
    to a client: 401 → 4401, 429 → 4029, 408 → 4408.
    """

    # Missing/unknown/expired token or deactivated user — pre-accept reject AND the
    # mid-socket revocation close (ENG-153): the hub closes a live socket with this
    # same code when its user is deactivated or its session is revoked, telling the
    # client to re-authenticate (which then fails the same uniform way pre-accept).
    UNAUTHENTICATED = 4401
    FORBIDDEN = 4403  # authenticated bot token lacking the events:read scope (ENG-159)
    TOO_MANY_CONNECTIONS = 4029  # over the per-user connection cap (§5)
    HEARTBEAT_TIMEOUT = 4408  # missed the server heartbeat ping (§7)


#: Heartbeat / liveness frames (both directions).
PING: Final[dict[str, str]] = {"t": "ping"}
PONG: Final[dict[str, str]] = {"t": "pong"}

#: Server→client signal-class ``t`` values. ``read_state`` (ENG-123) and ``prefs``
#: (ENG-124) are the ACTIVATED synced-per-user-KV echoes; ``presence`` / ``typing``
#: remain reserved (documented, not built — §13/D3).
RESERVED_SERVER_FRAME_TYPES: Final[tuple[str, ...]] = ("read_state", "prefs", "presence", "typing")
RESERVED_CLIENT_FRAME_TYPES: Final[tuple[str, ...]] = ("typing", "presence")


def event_frame(envelope: Envelope) -> dict[str, Any]:
    """Build the ``{"t": "event", "event": {…}}`` fanout frame for ``envelope``.

    The ``event`` object is byte-shaped identically to what the pull endpoint
    serves. ``body`` is rebuilt via ``model_dump(mode="json")`` — faithful for
    every M1 typed field, with ``payload`` a pass-through dict and unknown fields
    surviving through ``extra="allow"`` — so
    ``hash_event(frame["event"]["body"]) == frame["event"]["event_hash"]`` holds
    for known **and** unknown types (§6a, guarded by the hash-fidelity test).
    """
    server = envelope.server
    server_meta: dict[str, Any] | None = (
        None
        if server is None
        else {
            "server_sequence": server.server_sequence,
            "server_received_at": server.server_received_at,
            "payload_redacted": server.payload_redacted,
        }
    )
    return {
        "t": "event",
        "event": {
            "body": envelope.body.model_dump(mode="json"),
            "event_hash": envelope.event_hash,
            "signature": envelope.signature,
            "server": server_meta,
        },
    }


def read_state_frame(*, stream_id: str, last_read_seq: int) -> dict[str, Any]:
    """Build the ``{"t": "read_state", …}`` per-user cross-device echo frame (D3).

    This ACTIVATES the reserved ``read_state`` ``t`` value: the server now SENDS it.
    It is the wire form of the **synced per-user KV** message class — a THIRD kind
    of state distinct from durable events and ephemeral presence. A read marker is
    NOT an event: it is never appended to the log, never hashed, never projected or
    rebuilt (the D3 negative guard). ``PUT /v1/read-state`` writes the authoritative
    marker to the ``read_state`` table and then echoes THIS frame to the caller's
    OWN other connections so a user's devices converge (§3.3). ``last_read_seq`` is
    the EFFECTIVE (monotonic-``GREATEST``) value after the upsert — never a lower
    incoming value. The echo reaches only that same user's sockets (the hub touches
    only ``_by_user[user_id]``); no other user ever sees another's read marker.
    """
    return {"t": "read_state", "stream_id": stream_id, "last_read_seq": last_read_seq}


def prefs_frame(*, stream_id: str, level: str) -> dict[str, Any]:
    """Build the ``{"t": "prefs", …}`` per-user cross-device echo frame (D3).

    This ACTIVATES the reserved ``prefs`` ``t`` value: the server now SENDS it. It
    is the wire form of the **synced per-user KV** message class — the SAME third
    kind of state as ``read_state``, distinct from durable events and ephemeral
    presence. A pref is NOT an event: never appended to the log, never hashed,
    never projected or rebuilt (the D3 negative guard). ``PUT /v1/prefs`` writes
    the authoritative ``level`` to the ``prefs`` table (last-write-wins — NOT the
    monotonic ``GREATEST`` of read-state) and then echoes THIS frame to the
    caller's OWN other connections so a user's devices converge (§3.3). ``level``
    is the stored value (``all`` / ``mentions`` / ``mute``). The echo reaches only
    that same user's sockets (the hub touches only ``_by_user[user_id]``); no
    other user ever sees another's pref.
    """
    return {"t": "prefs", "stream_id": stream_id, "level": level}


def presence_frame(*, user_id: str, status: str) -> dict[str, Any]:
    """Build the ``{"t": "presence", …}`` online/offline frame (D3 ephemeral, ENG-125).

    This ACTIVATES the reserved ``presence`` ``t`` value: the server now SENDS it.
    Presence is the D3 **ephemeral** message class — a THIRD kind distinct from BOTH
    durable events and synced per-user KV: WS-only, **never** appended to the log,
    hashed, projected, rebuilt, or exported (the load-bearing negative guard). It is
    not even persisted — it is DERIVED live from the connection registry (a user is
    online iff they hold ≥1 live socket) and re-derived from scratch on reconnect
    with ZERO persistence (there is no presence table). The hub emits this on the
    0→1 (``online``) and 1→0 (``offline``) connection transitions to every OTHER
    connection in the SAME workspace — presence never crosses a workspace boundary.
    ``status`` is ``online`` / ``offline`` (no last-seen / custom status in scope;
    an ``away`` state is deferred — it does not fall trivially out of the heartbeat).
    """
    return {"t": "presence", "user_id": user_id, "status": status}


def typing_frame(*, stream_id: str, user_id: str) -> dict[str, Any]:
    """Build the ``{"t": "typing", …}`` stream-scoped typing frame (D3 ephemeral, ENG-125).

    This ACTIVATES the reserved ``typing`` ``t`` value: the server now SENDS it.
    Typing is the SAME D3 **ephemeral** class as presence — WS-only, **never**
    appended to the log, hashed, projected, rebuilt, or exported (the negative
    guard), and never persisted. It originates as an inbound client ``typing`` frame
    for a ``stream_id``; the hub rate-limits it, gates the sender on ``can_read`` of
    that stream (the SAME readable-streams predicate event fanout uses, so typing
    scoping cannot diverge from read scoping), and relays THIS frame to the stream's
    OTHER connected readers — EXCLUDING the sender's own sockets, and never across a
    workspace. ``user_id`` is the SENDER. TTL is a pure CLIENT concern (the client
    shows "X is typing" for ~5 s then auto-clears); the server only relays, so no
    TTL rides on the wire.
    """
    return {"t": "typing", "stream_id": stream_id, "user_id": user_id}
