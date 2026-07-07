"""``SimClient`` — the simulated M2 web client, pull-based (ENG-71 §1).

A library object wrapping **one shared** :class:`httpx.AsyncClient` (the committing
app's client — every ``SimClient`` hits the same in-process server / same
Postgres, so one client's committed upload is visible to another's pull).  It is
**not** an ``msgctl`` subprocess.

State model — the exact contract §3.3 pins for the real web client, so the M2
SharedWorker/Dexie outbox is *this* object with a different transport:

* **cursors are truth** — ``cursors[stream]`` is the last-contiguous
  ``server_sequence`` this client has pulled; it is advanced **only** by
  :meth:`catchup_pull`, never derived from an upload ack or a (future) WS frame.
* **the outbox is a dumb idempotent retry loop** — :meth:`flush` re-POSTs the
  whole outbox; the server's ``UNIQUE(workspace_id, event_id)`` makes re-sends
  safe; an item leaves the outbox only when the server returns its ``event_id`` in
  ``accepted[]``.  The ``event_id`` is minted **once** in :meth:`send` and is
  stable across every retry — that is what makes idempotency real.
* the client trusts nothing but a pulled, sequenced event.

No WebSocket in the M1 skeleton — pull only (WS is an ENG-68 transport seam that
rides the same cursor-truth state model, not a rewrite).
"""

from __future__ import annotations

from typing import Any

from authutil import auth_header
from eventsutil import (
    Auth,
    message_body,
    message_deleted_body,
    message_edited_body,
    post_batch,
    reaction_body,
    wire_item,
)
from httpx import AsyncClient

#: A §3.2 upload item: ``{body, event_hash}``.
WireItem = dict[str, Any]
#: A served wire event: ``{body, event_hash, signature, server:{...}}``.
WireEvent = dict[str, Any]

#: Bounded retries so a stuck outbox can never hang CI (§1 / R3).
MAX_FLUSH_RETRIES = 5
#: The biggest legal pull page (§4.3) — catch-up wants the largest page.
PULL_LIMIT = 500


class SimClient:
    """One simulated device: real session token, cursors-as-truth, dumb outbox."""

    def __init__(self, http: AsyncClient, auth: Auth, *, is_adversary: bool = False) -> None:
        self.http = http
        self.auth = auth
        self.is_adversary = is_adversary
        #: per-stream last-contiguous pulled ``server_sequence`` (source of truth).
        self.cursors: dict[str, int] = {}
        #: local materialized log per stream, ascending — the convergence anchor.
        self.pulled: dict[str, list[WireEvent]] = {}
        #: un-acked ``{body, event_hash}`` items awaiting a successful flush.
        self.outbox: list[WireItem] = []
        #: disconnect-simulation flag (see :meth:`simulate_disconnect`).
        self.connected: bool = True
        #: distinct ``event_id`` -> ``stream_id`` this client *intended* to send.
        #: Idempotency invariant reads it: exactly one stored row per entry.
        self.intended: dict[str, str] = {}
        #: last item enqueued by :meth:`send`, replayed by :meth:`duplicate_send`.
        self._last_item: WireItem | None = None

    @property
    def token(self) -> str:
        token: str = self.auth["token"]
        return token

    @property
    def user_id(self) -> str:
        user_id: str = self.auth["user_id"]
        return user_id

    # --- write path (outbox) --------------------------------------------------

    async def send(self, stream_id: str, *, text: str = "hello") -> None:
        """Mint a ``message.created`` and enqueue it (no network — mirrors the real
        client appending to its outbox).  The ``event_id`` is minted here, once.
        """
        body = message_body(auth=self.auth, stream_id=stream_id, text=text)
        item = wire_item(body)
        self.outbox.append(item)
        self._last_item = item
        self.intended[body["event_id"]] = stream_id

    def known_message_ids(self, stream_id: str) -> list[str]:
        """The ``message_id``s this client has PULLED in ``stream_id`` (ascending).

        A reaction can only target a message the client has actually observed —
        the same constraint the real web client has (you react to a message on
        screen). Resolved from ``pulled`` (cursor-truth), never from an unacked
        local send.
        """
        return [
            ev["body"]["payload"]["message_id"]
            for ev in self.pulled.get(stream_id, [])
            if ev["body"].get("type") == "message.created"
        ]

    def known_own_message_ids(self, stream_id: str) -> list[str]:
        """The ``message_id``s this client PULLED in ``stream_id`` that IT authored.

        Edits/deletes target only own messages (the author-or-admin rule), so the
        strategy resolves a target from this list — the same constraint the real
        client has (you edit your own message on screen), sourced from cursor-truth.
        """
        return [
            ev["body"]["payload"]["message_id"]
            for ev in self.pulled.get(stream_id, [])
            if ev["body"].get("type") == "message.created"
            and ev["body"].get("author_user_id") == self.user_id
        ]

    def known_root_message_ids(self, stream_id: str) -> list[str]:
        """The ``message_id``s this client PULLED in ``stream_id`` that are NON-reply
        top-level messages (``thread_root_id`` is null).

        A thread reply may only root on a NON-reply message (flat-channel threads,
        D7 / ENG-99), so the strategy resolves a reply's root from this list — every
        generated reply then targets a valid flat root and is Accepted, so the thread
        counters/participants are actually exercised (not silently rejected).
        """
        return [
            ev["body"]["payload"]["message_id"]
            for ev in self.pulled.get(stream_id, [])
            if ev["body"].get("type") == "message.created"
            and ev["body"]["payload"].get("thread_root_id") is None
        ]

    async def react(
        self, stream_id: str, message_id: str, emoji: str, *, removed: bool = False
    ) -> None:
        """Mint a ``reaction.added``/``reaction.removed`` and enqueue it (§2.4).

        Homed in ``stream_id`` (the message's stream). Rides the same dumb outbox
        as :meth:`send`: a fresh ``event_id`` minted once, idempotent under retry.
        Deliberately does NOT touch ``_last_item`` — ``duplicate_send`` must keep
        replaying the last *message*, not a reaction.
        """
        body = reaction_body(
            auth=self.auth,
            stream_id=stream_id,
            message_id=message_id,
            emoji=emoji,
            removed=removed,
        )
        self.outbox.append(wire_item(body))

    async def edit(self, stream_id: str, message_id: str, text: str) -> None:
        """Mint a ``message.edited`` and enqueue it (§2.4, LWW by server_sequence).

        Homed in ``stream_id`` (the message's stream). Rides the same dumb outbox as
        :meth:`send`. Does NOT touch ``_last_item`` — ``duplicate_send`` must keep
        replaying the last *message*, not an edit.
        """
        body = message_edited_body(
            auth=self.auth, stream_id=stream_id, message_id=message_id, text=text
        )
        self.outbox.append(wire_item(body))

    async def delete(self, stream_id: str, message_id: str) -> None:
        """Mint a ``message.deleted`` (tombstone) and enqueue it (§2.4)."""
        body = message_deleted_body(auth=self.auth, stream_id=stream_id, message_id=message_id)
        self.outbox.append(wire_item(body))

    async def reply(self, stream_id: str, root_message_id: str, *, text: str = "reply") -> None:
        """Mint a threaded ``message.created`` (``thread_root_id`` set) and enqueue it.

        A reply IS a ``message.created`` (D7 — no ``thread.created`` type), so it rides
        the same dumb outbox as :meth:`send` and counts as an INTENDED message (the
        idempotency invariant must see exactly one stored row for it). Homed in
        ``stream_id`` (the root's stream — §2.2 same-stream). Does NOT touch
        ``_last_item`` (``duplicate_send`` keeps replaying the last plain message).
        """
        body = message_body(
            auth=self.auth, stream_id=stream_id, text=text, thread_root_id=root_message_id
        )
        self.outbox.append(wire_item(body))
        self.intended[body["event_id"]] = stream_id

    async def duplicate_send(self, stream_id: str) -> None:
        """Re-enqueue the last already-sent item (**same** ``event_id``), forcing a
        duplicate upload attempt.  No new intended event — it must collapse to one
        stored row (idempotency).  Falls back to a fresh send if nothing sent yet.
        """
        if self._last_item is None:
            await self.send(stream_id)
            return
        self.outbox.append(self._last_item)

    async def flush(self) -> None:
        """Re-POST the whole outbox; drop every item the server ``accepted``.

        A dumb idempotent retry loop.  On a simulated disconnect **mid-flush** the
        request may or may not have committed server-side, but the client never
        sees the ack — items **stay** in the outbox and are retried on reconnect
        (idempotency makes the re-send safe).  Retries are bounded (CI-safe).
        """
        for _ in range(MAX_FLUSH_RETRIES):
            if not self.outbox:
                return
            resp = await post_batch(self.http, self.token, list(self.outbox))
            if not self.connected:
                # Ack lost mid-flight: discard the client's view of the response.
                return
            if resp.status_code == 200:
                acked = {e["event_id"] for e in resp.json()["accepted"]}
                self.outbox = [it for it in self.outbox if it["body"]["event_id"] not in acked]
            # Any non-200 (transient) → keep items, retry within the bound.

    # --- read path (cursors are truth) ----------------------------------------

    async def catchup_pull(self, stream_id: str) -> bool:
        """Forward catch-up: page ``GET /v1/events?after=cursor`` until drained.

        Appends each page to ``pulled[stream_id]`` and advances ``cursors`` to the
        last pulled ``server_sequence``.  Returns ``True`` when the stream was read;
        a **404** (an adversary on a private stream) returns ``False`` without
        mutating state — the permission-isolation signal (§3.6.2: existence not
        disclosed).
        """
        cursor = self.cursors.get(stream_id, 0)
        while True:
            resp = await self.http.get(
                "/v1/events",
                params={"stream_id": stream_id, "after": cursor, "limit": PULL_LIMIT},
                headers=auth_header(self.token),
            )
            if resp.status_code == 404:
                # Forbidden/absent: leave state untouched (no phantom pulled entry).
                return False
            resp.raise_for_status()
            page = resp.json()
            log = self.pulled.setdefault(stream_id, [])
            for ev in page["events"]:
                log.append(ev)
                cursor = ev["server"]["server_sequence"]
            self.cursors[stream_id] = cursor
            if not page["has_more"]:
                return True

    async def sync(self) -> list[str]:
        """``GET /v1/sync`` → the ids of every stream the caller may read.

        Unreadable streams are simply **absent** (never 404) — the adversary's
        private channel never appears here.
        """
        resp = await self.http.get("/v1/sync", headers=auth_header(self.token))
        resp.raise_for_status()
        return [s["stream_id"] for s in resp.json()["streams"]]

    # --- disconnect / reconnect ----------------------------------------------

    def simulate_disconnect(self) -> None:
        """Flip to disconnected: the next flush issues its POST but the ack is lost."""
        self.connected = False

    async def reconnect(self) -> None:
        """Reconnect per the §3.3 delivery contract: flush the outbox, then sync +
        catch up every readable stream (trust cursors, recover exactly the tail).
        """
        self.connected = True
        await self.flush()
        for stream_id in await self.sync():
            await self.catchup_pull(stream_id)
