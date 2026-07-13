"""WebSocket fanout seam (ENG-66 ships the seam; ENG-68 fills the body).

:func:`publish_event` is a module-level async callable the upload router invokes
**after each per-event commit, exactly once per newly accepted event** — never on
the idempotent re-accept path (a re-upload of an already-stored ``event_id`` was
already published on its first acceptance, D7/D9).

It is a deliberate no-op here so the M1 write path is complete without a live WS
hub. ENG-68 replaces the body with permission-scoped fanout via the in-memory
connection registry **without touching the router loop** — the router depends
only on this name and its post-commit call site, keeping the two tickets from
colliding on ``ws/`` files.
"""

from __future__ import annotations

from collections.abc import Iterable

from msgd.core.envelope import Envelope

__all__ = ["publish_event", "publish_events"]


async def publish_event(envelope: Envelope) -> None:
    """Permission-scoped WebSocket fanout for one newly accepted event (ENG-68).

    Invoked by the upload router after each per-event commit, once per newly
    accepted event (never on the idempotent re-accept path). Delegates to the
    process-global ``ws`` hub, which resolves recipients per-send against the live
    DB predicate and pushes the wire frame to every eligible connected socket.

    The signature is frozen (the seam carries no DB/app handle — the hub reaches
    the DB via its own injectable session factory). The hub is imported
    **function-locally** to avoid an ``events`` ↔ ``ws`` import cycle at module
    load (the only back-edge; ``ws`` never imports ``events.fanout``).
    """
    from msgd.ws.hub import hub

    await hub.publish(envelope)


async def publish_events(envelopes: Iterable[Envelope]) -> None:
    """Fan a run of committed server-authored meta events over WS, in log order.

    The server-authored ``emit_event`` sites (bot provisioning + grants in the
    plugins router, invite-accept ``user.joined`` in auth, deactivation /
    role-change in admin) persist inside the request transaction but — unlike the
    ``store_event`` message path — did NOT fan out, so a connected client only
    learned of the change on its next bootstrap (a new member / bot / role stayed
    invisible until reload). Callers collect the ``emit_event`` envelopes and pass
    them here AFTER ``db.commit()`` (mirroring ``store_event``'s emit→commit→publish
    order) so the hub's per-send readability resolve sees the committed rows.
    Delivery is a hint (§3.3) — the hub timeout-guards + isolates each socket.
    """
    for envelope in envelopes:
        await publish_event(envelope)
