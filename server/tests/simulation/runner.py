"""Apply an op sequence, settle, snapshot server truth, assert all four invariants.

The default driver is **randomized-sequential** (ops applied one at a time in the
hypothesis-drawn order) for CI-reproducible determinism; ``ConcurrentSendBurst`` is
the one op that fans out via ``asyncio.gather`` for the true streams-row-lock probe
(§3).  After the ops, every client reconnects, flushes its outbox, and catches up
(the §3.3 delivery contract); then server truth is read through a fresh committing
session and the four §12-subset invariants are asserted.

Lifecycle (R2): the sim commits real rows, so it starts from a truncated server and
``truncate_auth_tables`` runs in a ``finally`` — the ``test_events_batch_concurrency``
discipline, so committed rows never leak into other integration tests.
"""

from __future__ import annotations

import asyncio

from authutil import committing_app, truncate_auth_tables
from eventsutil import message_edited_body, post_batch, reaction_body, wire_item
from msgd.db.models import Event, MessageProj, ReactionProj
from msgd.projections.dump import dump_messages_proj, dump_reactions_proj
from msgd.projections.rebuild import rebuild_projections
from msgd.settings import Settings
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from simulation.client import SimClient
from simulation.invariants import MessageRows, ReactionRows, Truth, assert_all
from simulation.setup import World, build_world
from simulation.strategies import (
    REACT_EMOJIS,
    ConcurrentReactBurst,
    ConcurrentSendBurst,
    Delete,
    DisconnectMidFlush,
    DuplicateSend,
    Edit,
    Op,
    Plan,
    React,
    ReconnectCatchup,
    Send,
    Unreact,
)


async def _apply_op(world: World, op: Op) -> None:
    """Dispatch one op against the world (sequential; bursts fan out internally)."""
    if isinstance(op, Send):
        actor = world.actors[op.actor]
        await actor.send(world.stream_id(op.stream), text=op.text)
        if actor.connected:
            await actor.flush()
    elif isinstance(op, DuplicateSend):
        actor = world.actors[op.actor]
        await actor.duplicate_send(world.stream_id(op.stream))
        if actor.connected:
            await actor.flush()
    elif isinstance(op, DisconnectMidFlush):
        actor = world.actors[op.actor]
        if not actor.outbox:
            await actor.send(world.public_stream)  # ensure a payload to lose the ack on
        actor.simulate_disconnect()
        await actor.flush()  # POST issued, ack discarded → items stay in the outbox
    elif isinstance(op, ReconnectCatchup):
        await world.actors[op.actor].reconnect()
    elif isinstance(op, ConcurrentSendBurst):
        stream = world.stream_id(op.stream)
        participants = [a for a in world.actors if a.connected][: op.count]
        for actor in participants:
            await actor.send(stream)
        # True concurrency: K simultaneous flushes to the SAME stream race on the
        # streams-row lock — the gaplessness/idempotency probe.
        await asyncio.gather(*(actor.flush() for actor in participants))
    elif isinstance(op, (React, Unreact)):
        actor = world.actors[op.actor]
        stream = world.stream_id(op.stream)
        if actor.connected:
            await actor.catchup_pull(stream)  # learn the stream's messages first
        message_id = _resolve_message(actor, stream, op.msg)
        if message_id is None:
            return  # no message to react to yet → the op is a no-op
        await actor.react(
            stream, message_id, REACT_EMOJIS[op.emoji], removed=isinstance(op, Unreact)
        )
        if actor.connected:
            await actor.flush()
    elif isinstance(op, (Edit, Delete)):
        actor = world.actors[op.actor]
        stream = world.stream_id(op.stream)
        if actor.connected:
            await actor.catchup_pull(stream)  # learn the actor's own messages first
        message_id = _resolve_own_message(actor, stream, op.msg)
        if message_id is None:
            return  # the actor has authored no message here yet → a no-op
        if isinstance(op, Edit):
            await actor.edit(stream, message_id, op.text)
        else:
            await actor.delete(stream, message_id)
        if actor.connected:
            await actor.flush()
    elif isinstance(op, ConcurrentReactBurst):
        stream = world.stream_id(op.stream)
        participants = [a for a in world.actors if a.connected]
        for actor in participants:
            await actor.catchup_pull(stream)
        participants = participants[: op.count]
        if not participants:
            return
        message_id = _resolve_message(participants[0], stream, op.msg)
        if message_id is None:
            return
        emoji = REACT_EMOJIS[op.emoji]
        for actor in participants:
            await actor.react(stream, message_id, emoji)
        # True concurrency: K simultaneous reactions to the SAME (message, emoji)
        # race on the streams-row lock (sequencing) and land distinct membership
        # rows — the reaction idempotency/convergence probe.
        await asyncio.gather(*(actor.flush() for actor in participants))


def _resolve_message(actor: SimClient, stream: str, msg_index: int) -> str | None:
    """The ``message_id`` a reaction op targets: ``msg_index`` modulo the messages
    the actor knows in ``stream`` (or ``None`` when it knows none yet)."""
    known = actor.known_message_ids(stream)
    if not known:
        return None
    return known[msg_index % len(known)]


def _resolve_own_message(actor: SimClient, stream: str, msg_index: int) -> str | None:
    """The ``message_id`` an edit/delete op targets: ``msg_index`` modulo the
    messages the actor AUTHORED in ``stream`` (or ``None`` when it authored none).

    Edits/deletes target only own messages (the author-or-admin rule) so every
    generated edit/delete is a legitimately-writable event that sequences normally.
    """
    known = actor.known_own_message_ids(stream)
    if not known:
        return None
    return known[msg_index % len(known)]


async def _settle(world: World) -> None:
    """Reconnect + flush every writer, catch up all readable streams, probe adversary."""
    for actor in world.actors:
        actor.connected = True
        await actor.flush()
    for actor in world.actors:
        for stream in await actor.sync():
            await actor.catchup_pull(stream)

    # Adversary probes for the permission-isolation invariant (every run).
    world.adversary.connected = True
    visible = await world.adversary.sync()
    world.adversary_visible = set(visible)
    for stream in visible:
        await world.adversary.catchup_pull(stream)
    # Direct existence probe: a private stream the adversary can't read → 404.
    readable = await world.adversary.catchup_pull(world.private_stream)
    world.adversary_private_forbidden = not readable

    # ENG-97 reaction isolation probe: the adversary tries to react to a message in
    # the private stream it cannot read. The reaction is homed in the private
    # stream, so can_write(private) == can_read(private) == False → the upload is
    # rejected (permission_denied) and no reactions_proj row is written. The
    # private message id is sourced from the owner (a private member) — the
    # adversary never legitimately learns it.
    priv_msgs = world.owner.known_message_ids(world.private_stream)
    if priv_msgs:
        body = reaction_body(
            auth=world.adversary.auth,
            stream_id=world.private_stream,
            message_id=priv_msgs[0],
            emoji=REACT_EMOJIS[0],
        )
        resp = await post_batch(world.adversary.http, world.adversary.token, [wire_item(body)])
        world.adversary_reaction_forbidden = (
            resp.status_code == 200 and len(resp.json()["accepted"]) == 0
        )

    # ENG-98 edit/delete isolation probe: the adversary tries to edit a PUBLIC
    # message it did NOT author. Unlike the reaction/private probe (blocked at the
    # stream gate), the adversary CAN read the public stream — so this specifically
    # exercises the author-or-admin rule: a non-author non-admin edit is refused
    # (permission_denied) even on a readable stream, and lands zero projection
    # changes. The target is an OWNER-authored public message the adversary pulled.
    pub_msgs = [
        ev["body"]["payload"]["message_id"]
        for ev in world.adversary.pulled.get(world.public_stream, [])
        if ev["body"].get("type") == "message.created"
        and ev["body"].get("author_user_id") == world.owner.user_id
    ]
    if pub_msgs:
        edit = message_edited_body(
            auth=world.adversary.auth,
            stream_id=world.public_stream,
            message_id=pub_msgs[0],
            text="adversary-was-here",
        )
        resp = await post_batch(world.adversary.http, world.adversary.token, [wire_item(edit)])
        world.adversary_edit_forbidden = (
            resp.status_code == 200 and len(resp.json()["accepted"]) == 0
        )


async def _snapshot_truth(world: World) -> Truth:
    """Read the stored event set per shared stream via a fresh committing session."""
    maker = async_sessionmaker(world.engine, expire_on_commit=False)
    truth: Truth = {}
    async with maker() as db:
        for stream in world.shared_streams:
            rows = (
                (
                    await db.execute(
                        select(Event)
                        .where(Event.stream_id == stream)
                        .order_by(Event.server_sequence)
                    )
                )
                .scalars()
                .all()
            )
            truth[stream] = [
                {
                    "event_id": row.event_id,
                    "server_sequence": row.server_sequence,
                    "event_hash": row.event_hash,
                    "body": row.body,
                    "stream_id": row.stream_id,
                }
                for row in rows
            ]
    return truth


async def _snapshot_messages(world: World) -> MessageRows:
    """Read ``messages_proj`` as ``(message_id, stream_id, author, text, created_seq,
    edited_seq, deleted)`` rows — the surface the LWW + tombstone invariants fold the
    log against (ENG-98).
    """
    maker = async_sessionmaker(world.engine, expire_on_commit=False)
    async with maker() as db:
        rows = await db.execute(
            select(
                MessageProj.message_id,
                MessageProj.stream_id,
                MessageProj.author_user_id,
                MessageProj.text,
                MessageProj.created_seq,
                MessageProj.edited_seq,
                MessageProj.deleted,
            )
        )
        return [(r[0], r[1], r[2], r[3], r[4], r[5], r[6]) for r in rows.all()]


async def _snapshot_reactions(world: World) -> ReactionRows:
    """Read ``reactions_proj`` as a list of ``(message_id, author_user_id, emoji)``.

    A list (not a set) so the invariant can assert the projection carries NO
    duplicate membership row (the PK enforces it, but the sim proves it too).
    """
    maker = async_sessionmaker(world.engine, expire_on_commit=False)
    async with maker() as db:
        rows = await db.execute(
            select(ReactionProj.message_id, ReactionProj.author_user_id, ReactionProj.emoji)
        )
        return [(r[0], r[1], r[2]) for r in rows.all()]


async def _assert_rebuild_equivalence(world: World) -> None:
    """§12 invariant 6 for BOTH projections: rebuild ≡ incremental, byte for byte.

    Dump the incrementally-built ``messages_proj`` + ``reactions_proj``, run a full
    ``rebuild_projections`` (TRUNCATE + replay the whole log through the same
    ``apply_projection``), then dump again — the dumps must be byte-identical.
    ``rebuild_projections`` commits, so the post-rebuild dumps are read on a fresh
    session. The runner truncates everything in its ``finally``, so the rebuilt
    committed rows never leak to sibling examples.
    """
    maker = async_sessionmaker(world.engine, expire_on_commit=False)
    async with maker() as db:
        before_messages = await dump_messages_proj(db)
        before_reactions = await dump_reactions_proj(db)
        await rebuild_projections(db)
    async with maker() as db:
        assert await dump_messages_proj(db) == before_messages, (
            "rebuild ≠ incremental for messages_proj"
        )
        assert await dump_reactions_proj(db) == before_reactions, (
            "rebuild ≠ incremental for reactions_proj"
        )


async def run_plan(settings: Settings, plan: Plan) -> None:
    """Run one full example: bootstrap → apply ops → settle → assert all invariants.

    Raises ``AssertionError`` if any of the four §12-subset invariants fails (the
    teeth test relies on this).  Always truncates + disposes in ``finally`` (R2).
    """
    cleanup_engine = create_async_engine(settings.database_url)
    await truncate_auth_tables(cleanup_engine)  # start from an empty server (R2)

    http, engine = committing_app(settings)
    try:
        async with http:
            world = await build_world(http, engine, n_members=plan.n_members)
            for op in plan.ops:
                await _apply_op(world, op)
            await _settle(world)
            truth = await _snapshot_truth(world)
            reaction_rows = await _snapshot_reactions(world)
            message_rows = await _snapshot_messages(world)
            assert_all(world, truth, reaction_rows, message_rows)
            # §12 invariant 6 (reactions + messages): rebuild ≡ incremental. Run
            # last — it TRUNCATEs + replays the committed log (reproducing identical
            # state), which the finally-block truncation then clears.
            await _assert_rebuild_equivalence(world)
    finally:
        await truncate_auth_tables(cleanup_engine)
        await engine.dispose()
        await cleanup_engine.dispose()
