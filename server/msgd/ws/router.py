"""``GET /v1/ws`` — the authenticated WebSocket surface: fanout target + heartbeat.

Flow (§7):

1. **Auth, pre-accept.** The bearer token arrives via ``Sec-WebSocket-Protocol:
   bearer, <token>`` — surfaced as ``websocket.scope["subprotocols"]`` — **not** the
   query string. The exact list *shape* is backend-dependent (ENG-92: uvicorn's
   default ``websockets`` backend yields the un-split ``["bearer, <token>"]``, while
   ``wsproto`` / the ASGI test transport yield ``["bearer", "<token>"]``); see
   :func:`_bearer_token`, which normalizes both. This overturns the plan's ``?token=…``
   after security round 1 (finding b): a query token leaks the raw session token
   into ``uvicorn.error`` request-line logs (and any proxy access log / browser
   history / ``Referer``), defeating ENG-64 D2. The subprotocol form is the
   idiomatic browser-WS bearer pattern (``new WebSocket(url, ["bearer", token])``)
   and keeps the secret out of the URL entirely — do **not** "clean up" back to a
   query param. The raw token is subprotocol-safe (``token_urlsafe`` → tchar-clean,
   no padding). Resolve it exactly as ``require_auth`` does — ``hash_token`` +
   ``lookup_session`` + the same expiry/deactivation checks + the throttled
   ``bump_session`` (D4) — using the standard, test-overridable ``get_session``.
   Any failure (missing/malformed subprotocol, unknown/expired token, deactivated
   user) closes the socket **before** ``accept()`` with app code ``4401`` (uniform,
   non-disclosing). Session-loading is re-called inline rather than factored out of
   the merged ``deps.require_auth``.
2. **Accept + register (cap, §5).** ``accept(subprotocol="bearer")`` — the echo is
   REQUIRED or a real browser aborts the handshake — then register in the hub. Over
   the per-user cap → accept-then-close ``4029`` (so the client receives the code).
3. **Serve.** Two concurrent coroutines for the socket's lifetime — a tolerant
   receive loop (client ``ping`` → server ``pong``; client ``pong`` clears the
   outstanding-ping flag; every other frame ignored, D9) and a 30 s heartbeat
   (send ``ping``; if the previous one is still unanswered, close ``4408``).
   Whichever ends first tears the other down; a single ``finally`` deregisters.

Identity-snapshot caveat (security round 1, hardening note 2): the connection
captures ``user_id``/``role``/``workspace_id``/``device_id`` (+ the session's
``token_hash``) at connect. **Stream membership is live per-send** (the hub re-runs
the read predicate on every event), so a member removed from a channel stops
receiving its fanout on the next event. Session *revocation* and account
*deactivation* now tear the live socket down via the hub close-signal (ENG-153):
``PATCH /v1/admin/members/{id}`` ``active:false`` calls ``hub.disconnect_user`` and
``DELETE /v1/auth/sessions/{id}`` calls ``hub.disconnect_session`` — both after
their commit, both closing ``4401`` (re-authenticate; the reconnect then fails the
same uniform pre-accept way). Workspace-*role* changes remain un-re-checked
mid-socket (deferred).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Annotated

from fastapi import APIRouter, Depends, WebSocket
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect

from msgd.auth.bot_tokens import bump_bot_token, lookup_bot_token
from msgd.auth.sessions import bump_session, lookup_session, utcnow
from msgd.auth.tokens import hash_token
from msgd.db.engine import get_session
from msgd.settings import Settings
from msgd.ws.frames import PING, PONG, WSCloseCode
from msgd.ws.hub import hub
from msgd.ws.registry import Connection

__all__ = ["router"]

router = APIRouter()

DbSession = Annotated[AsyncSession, Depends(get_session)]

#: The WS subprotocol carrying the bearer token: ``Sec-WebSocket-Protocol: bearer,
#: <token>`` (security round 1 — token off the URL). Echoed on ``accept``.
_BEARER_SUBPROTOCOL = "bearer"


def _bearer_token(websocket: WebSocket) -> str | None:
    """Return the bearer token from a ``bearer, <token>`` subprotocol offer, else None.

    The token rides in ``Sec-WebSocket-Protocol: bearer, <token>``, surfaced by the
    ASGI server as ``scope["subprotocols"]``. Crucially, **different WS backends
    represent that list differently** (ENG-92):

    * uvicorn's default ``websockets`` sans-io backend surfaces the *raw, un-split*
      header value(s) — ``event.headers.get_all("Sec-WebSocket-Protocol")`` — so a
      ``bearer, <token>`` offer arrives as a **single** element ``["bearer, <token>"]``.
    * ``wsproto`` and the in-process Starlette/httpx ASGI test transport pre-split on
      commas, arriving as ``["bearer", "<token>"]`` (the transport may also leave a
      leading OWS: ``["bearer", " <token>"]``).

    So we normalize *both* shapes: split every element on commas and strip the RFC 7230
    optional whitespace (OWS), flattening to a canonical ``["bearer", "<token>"]``. A
    subprotocol token is ``tchar`` only (``token_urlsafe`` output has no whitespace or
    commas), so splitting/stripping is loss-free. A well-formed offer normalizes to
    exactly ``[_BEARER_SUBPROTOCOL, <token>]``; anything else (absent, ``["bearer"]``
    with no token, a non-``bearer`` first element) yields ``None`` → the uniform
    pre-accept ``4401``.

    Reading the raw ``scope["subprotocols"]`` without this flatten is the ENG-92 bug:
    under a real uvicorn on the default backend the single-element form failed the
    ``len >= 2`` check and 403'd a valid token, while the in-process WS tests (which
    use the pre-split transport) stayed green.
    """
    raw: list[str] = list(websocket.scope.get("subprotocols") or [])
    protocols = [item.strip() for element in raw for item in element.split(",") if item.strip()]
    if len(protocols) >= 2 and protocols[0] == _BEARER_SUBPROTOCOL:
        token = protocols[1]
        if token:
            return token
    return None


class _HeartbeatState:
    """Shared liveness flag between the receive loop and the heartbeat loop."""

    __slots__ = ("awaiting_pong",)

    def __init__(self) -> None:
        self.awaiting_pong = False


@router.websocket("/v1/ws")
async def websocket_endpoint(websocket: WebSocket, db: DbSession) -> None:
    """Authenticate, register, and serve one client socket (see the module docstring)."""
    settings: Settings = websocket.app.state.settings

    connection = await _authenticate(websocket, db, settings)
    if connection is None:
        return  # already closed pre-accept with 4401

    # Echo the negotiated subprotocol — a real browser aborts the handshake without
    # it (the token travelled in Sec-WebSocket-Protocol, security round 1).
    await websocket.accept(subprotocol=_BEARER_SUBPROTOCOL)
    # Sample presence BEFORE registering: if the user held no socket, this connect is
    # the 0→1 transition that makes them online (D3 — presence is DERIVED from the
    # live registry, never persisted). register/deregister are sync; the relay is the
    # async router's job.
    was_online = hub.is_online(connection.user_id)
    if not hub.try_register(connection, max_connections=settings.ws_max_connections_per_user):
        # Accept-then-close so the client receives the 4029 close frame (§5).
        await websocket.close(code=WSCloseCode.TOO_MANY_CONNECTIONS)
        return

    if not was_online:
        # 0→1: relay online to same-workspace peers. Best-effort — a relay failure
        # must never break the connection lifecycle (the frame is a hint, §3.3).
        await _relay_presence_safely(connection, status="online")

    try:
        await _serve(websocket, connection, settings)
    finally:
        hub.deregister(connection)
        if not hub.is_online(connection.user_id):
            # 1→0: that was the user's last socket → relay offline. Best-effort in the
            # teardown path — never let a relay failure escape the finally.
            await _relay_presence_safely(connection, status="offline")


async def _relay_presence_safely(connection: Connection, *, status: str) -> None:
    """Relay a presence transition, swallowing any failure (best-effort, D3).

    Presence is a convenience hint, never authoritative — a wedged peer socket or a
    resolver hiccup must never fail this connection's accept or teardown path.

    Guest exclusion (ENG-125 follow-up, §3.6 roster-consistency): a GUEST subject
    broadcasts NO presence — their connect/disconnect produces no frame to anyone.
    Presence is a workspace-ROSTER signal (opaque ``user_id`` + online bit) that
    ``permissions.py`` withholds from guests (guests get no ``workspace-meta``
    roster), so a guest is scoped out of presence on BOTH sides: this no-broadcast
    guard, plus the non-guest recipient filter in :meth:`Hub.publish_presence`.
    Typing is unaffected (stream-membership-scoped — guests still type in joined
    streams).
    """
    if connection.role == "guest":
        return
    with contextlib.suppress(Exception):
        await hub.publish_presence(
            user_id=connection.user_id,
            workspace_id=connection.workspace_id,
            status=status,
        )


async def _authenticate(
    websocket: WebSocket, db: AsyncSession, settings: Settings
) -> Connection | None:
    """Resolve the subprotocol token → :class:`Connection`, or close ``4401`` (None).

    The token is the second value of ``Sec-WebSocket-Protocol: bearer, <token>`` —
    read from ``scope["subprotocols"]`` (security round 1: never the URL, so it
    cannot leak into request-line logs). A missing/malformed subprotocol is the
    uniform, non-disclosing ``4401`` — identical to an unknown token, an expired
    session, or a deactivated user — and always closed **before** ``accept()`` so no
    unauthenticated socket is ever accepted. The ``?token=`` query param is
    deliberately never consulted (no fallback that could re-expose the secret).
    """
    token = _bearer_token(websocket)
    if not token:
        await websocket.close(code=WSCloseCode.UNAUTHENTICATED)
        return None
    token_hash = hash_token(token)

    loaded = await lookup_session(db, token_hash)
    if loaded is None:
        # ENG-159: a session MISS falls through to the bot-token family, exactly
        # like require_auth — same hash, same uniform 4401 for every failure.
        return await _authenticate_bot(websocket, db, settings, token_hash)
    session, user, device = loaded

    now = utcnow()
    if now >= session.expires_at or user.deactivated_at is not None:
        await websocket.close(code=WSCloseCode.UNAUTHENTICATED)
        return None

    # Throttled rolling bump for parity with require_auth (D4); the overridden
    # get_session is savepoint-isolated in tests, so a bump-commit lands on a
    # savepoint, not the outer per-test transaction (R8).
    if await bump_session(db, session, settings=settings, now=now):
        await db.commit()

    return Connection(
        websocket=websocket,
        user_id=user.user_id,
        role=user.role,
        workspace_id=user.workspace_id,
        device_id=device.device_id,
        # The session's own revoke handle (ENG-153): DELETE /v1/auth/sessions/{id}
        # targets exactly this socket via hub.disconnect_session — never the
        # user's other valid sessions' sockets.
        session_token_hash=session.token_hash,
    )


async def _authenticate_bot(
    websocket: WebSocket, db: AsyncSession, settings: Settings, token_hash: str
) -> Connection | None:
    """The bot-token half of WS auth (ENG-159) — mirrors ``deps._bot_token_auth``.

    Every authentication failure (unknown hash, revoked token, deactivated bot)
    is the SAME pre-accept ``4401`` a bad session gets — no oracle for which
    credential family the token would have belonged to. A VALID bot token that
    lacks the ``events:read`` scope is an authorization failure over the
    caller's own credential, so it closes ``4403`` (the WS mirror of the HTTP
    403 scope gate on pull/sync) — still pre-accept, still resource-blind. The
    throttled ``last_used_at`` bump mirrors the session-bump parity above.
    """
    loaded = await lookup_bot_token(db, token_hash)
    if loaded is None:
        await websocket.close(code=WSCloseCode.UNAUTHENTICATED)
        return None
    bot_token, user, device = loaded

    if bot_token.revoked_at is not None or user.deactivated_at is not None:
        await websocket.close(code=WSCloseCode.UNAUTHENTICATED)
        return None

    # The WS surface is a read surface (fanout): the events:read verb gate,
    # exactly like GET /v1/events and GET /v1/sync (humans bypass — they never
    # reach this branch).
    if "events:read" not in set(bot_token.scopes):
        await websocket.close(code=WSCloseCode.FORBIDDEN)
        return None

    if await bump_bot_token(db, bot_token, settings=settings):
        await db.commit()

    return Connection(
        websocket=websocket,
        user_id=user.user_id,
        role=user.role,
        workspace_id=user.workspace_id,
        device_id=device.device_id,
        # Bot tokens are not sessions — no session revoke handle. A bot socket is
        # torn down by user-level deactivation (hub.disconnect_user, ENG-153).
        session_token_hash=None,
    )


async def _serve(websocket: WebSocket, connection: Connection, settings: Settings) -> None:
    """Run the receive loop + heartbeat concurrently; first to finish tears down."""
    state = _HeartbeatState()
    receive_task = asyncio.create_task(_receive_loop(websocket, connection, state))
    heartbeat_task = asyncio.create_task(_heartbeat_loop(websocket, settings, state))
    tasks = (receive_task, heartbeat_task)
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task


async def _receive_loop(
    websocket: WebSocket, connection: Connection, state: _HeartbeatState
) -> None:
    """Tolerant inbound loop: ``ping`` → ``pong``, ``pong`` clears the flag, ``typing`` relays.

    Any non-text / non-JSON / unknown frame is dropped without crashing (D9). Exits
    cleanly on client disconnect.
    """
    while True:
        try:
            raw = await websocket.receive_text()
        except WebSocketDisconnect:
            return
        except (RuntimeError, KeyError):
            # A binary frame (no "text") or a post-disconnect receive → ignore.
            continue
        try:
            message = json.loads(raw)
        except (ValueError, TypeError):
            continue
        if not isinstance(message, dict):
            continue
        t = message.get("t")
        if t == "ping":
            with contextlib.suppress(Exception):
                await websocket.send_json(PONG)
        elif t == "pong":
            state.awaiting_pong = False
        elif t == "typing":
            await _handle_typing(connection, message)
        # Every other / reserved / unknown frame is ignored (D9 tolerance). An
        # inbound ``presence`` frame stays IGNORED — presence is server-derived,
        # never client-asserted.


async def _handle_typing(connection: Connection, message: dict[str, object]) -> None:
    """Handle an inbound ``{"t":"typing","stream_id":…}`` signal (D3 ephemeral, ENG-125).

    Order matters: (1) validate the shape — a missing / non-str / empty ``stream_id``
    is silently ignored (D9, never crash); (2) rate-limit per user BEFORE any DB work
    so a spammer cannot hammer the resolver (:meth:`Hub.allow_typing`); (3+4) the
    permission gate + relay are folded into :meth:`Hub.publish_typing`, which resolves
    the stream's readable connections with the SAME predicate event fanout uses, drops
    if the sender isn't among them (``can_read`` gate, no oracle), and relays to the
    OTHER readers only. Typing is WS-only and ephemeral — this path NEVER writes an
    event or touches a projection.
    """
    stream_id = message.get("stream_id")
    if not isinstance(stream_id, str) or not stream_id:
        return
    if not hub.allow_typing(connection.user_id):
        return
    await hub.publish_typing(
        sender_user_id=connection.user_id,
        workspace_id=connection.workspace_id,
        stream_id=stream_id,
    )


async def _heartbeat_loop(websocket: WebSocket, settings: Settings, state: _HeartbeatState) -> None:
    """Every interval: if the prior ping is unanswered close ``4408``; else send ``ping``."""
    interval = settings.ws_heartbeat_interval_seconds
    while True:
        await asyncio.sleep(interval)
        if state.awaiting_pong:
            with contextlib.suppress(Exception):
                await websocket.close(code=WSCloseCode.HEARTBEAT_TIMEOUT)
            return
        try:
            await websocket.send_json(PING)
        except Exception:
            return
        state.awaiting_pong = True
