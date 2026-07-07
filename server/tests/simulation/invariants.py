"""The four §12-subset skeleton invariants, asserted **every** run (§2).

The full six land at M2; §12 invariants 5 (pending settling) and 6 (rebuild
equivalence) are documented seams (see ``test_simulation`` docstring), not asserted
here.  Each ``assert_*`` is a small pure function over the clients + a server-truth
snapshot; :func:`assert_all` runs all four after every hypothesis example.

``Truth`` is the server's stored event set per shared stream, ascending
``server_sequence`` — read by the runner through a fresh committing session
(direct ``select(Event)``), exactly as ``test_events_batch_concurrency`` does.
"""

from __future__ import annotations

from collections import Counter
from typing import Any, cast

from msgd.core.hashing import hash_event

from simulation.client import SimClient
from simulation.setup import World

#: One stored event, projected to the fields the invariants compare.
TruthEvent = dict[str, Any]
#: stream_id -> ascending list of stored events.
Truth = dict[str, list[TruthEvent]]
#: A ``reactions_proj`` snapshot: ``(message_id, author_user_id, emoji)`` rows.
ReactionRows = list[tuple[str, str, str]]
#: A ``messages_proj`` snapshot row: ``(message_id, stream_id, author_user_id, text,
#: created_seq, edited_seq, deleted)`` (ENG-98).
MessageRow = tuple[str, str, str, str, int, int | None, bool]
MessageRows = list[MessageRow]


def assert_idempotency(world: World, truth: Truth) -> None:
    """§12.1 — no duplicate ``event_id``; exactly one stored row per intended send.

    Retried (:meth:`SimClient.flush` re-POSTs) and duplicated
    (:meth:`SimClient.duplicate_send`) uploads must each collapse to a single
    stored event — proving the server's ``UNIQUE(workspace_id, event_id)`` +
    idempotent re-accept holds under the dumb-outbox retry loop.
    """
    for stream in world.shared_streams:
        events = truth[stream]
        event_ids = [e["event_id"] for e in events]
        assert len(event_ids) == len(set(event_ids)), f"duplicate event_id stored in {stream}"

        stored_messages = {
            e["event_id"] for e in events if e["body"].get("type") == "message.created"
        }
        intended = {
            eid for actor in world.actors for eid, sid in actor.intended.items() if sid == stream
        }
        assert stored_messages == intended, (
            f"idempotency: stored message set != intended in {stream}; "
            f"stored={stored_messages!r} intended={intended!r}"
        )


def assert_convergence(world: World, truth: Truth) -> None:
    """§12.2 (subset) — every member's ``pulled`` == server truth == each other.

    Byte-equal envelopes (``body`` dict, ``event_hash``, ``server_sequence`` all
    equal) and gapless (``[server_sequence] == range(1, n+1)``).  ``hash_event(body)
    == event_hash`` is re-checked on the stored body as the byte-equality anchor.
    (M1 compares pulled event sets; the rebuilt-projection half is invariant 6, M2.)
    """
    for stream in world.shared_streams:
        events = truth[stream]
        seqs = [e["server_sequence"] for e in events]
        assert seqs == list(range(1, len(events) + 1)), (
            f"convergence: server truth not gapless in {stream}: {seqs}"
        )
        for e in events:
            assert hash_event(e["body"]) == e["event_hash"], (
                f"convergence: stored body does not hash to its event_hash in {stream}"
            )

        for actor in world.actors:
            pulled = actor.pulled.get(stream, [])
            assert len(pulled) == len(events), (
                f"convergence: {actor.user_id} pulled {len(pulled)} events, "
                f"server has {len(events)} in {stream}"
            )
            for got, want in zip(pulled, events, strict=True):
                assert got["server"]["server_sequence"] == want["server_sequence"], (
                    f"convergence: sequence mismatch in {stream} for {actor.user_id}"
                )
                assert got["event_hash"] == want["event_hash"], (
                    f"convergence: event_hash mismatch in {stream} for {actor.user_id}"
                )
                assert got["body"] == want["body"], (
                    f"convergence: body not byte-equal in {stream} for {actor.user_id}"
                )


def assert_cursor_integrity(world: World, truth: Truth) -> None:
    """§12.3 — each client's per-stream ``pulled`` sequence is gapless + dup-free.

    After arbitrary disconnect / reconnect / missed events, the reconnect catch-up
    recovered exactly the missed tail: strictly-ascending contiguous
    ``server_sequence`` with no repeats, and the cursor equals the last pulled seq.
    Checked for every client, adversary included (its public pull must be clean).
    """
    clients: list[SimClient] = [*world.actors, world.adversary]
    for client in clients:
        for stream, pulled in client.pulled.items():
            seqs = [e["server"]["server_sequence"] for e in pulled]
            assert len(seqs) == len(set(seqs)), (
                f"cursor: duplicate sequence for {client.user_id} in {stream}: {seqs}"
            )
            assert seqs == sorted(seqs), (
                f"cursor: non-ascending sequence for {client.user_id} in {stream}: {seqs}"
            )
            if seqs:
                assert seqs == list(range(seqs[0], seqs[0] + len(seqs))), (
                    f"cursor: gap for {client.user_id} in {stream}: {seqs}"
                )
            assert client.cursors.get(stream, 0) == (seqs[-1] if seqs else 0), (
                f"cursor: cursor != last pulled seq for {client.user_id} in {stream}"
            )


def _expected_reaction_set(world: World, truth: Truth) -> set[tuple[str, str, str]]:
    """Replay the log's ``reaction.*`` events → the expected membership set.

    A pure fold over server truth in ``server_sequence`` order per stream:
    ``reaction.added`` is a set-add, ``reaction.removed`` a set-discard (§2.4).
    All reactions for a given message are homed in that message's stream (ENG-97
    validation), so a single-stream ordered replay is exact and order-independent
    across streams. The result is what a correct ``reactions_proj`` MUST equal.
    """
    membership: set[tuple[str, str, str]] = set()
    for stream in world.shared_streams:
        for event in truth[stream]:  # ascending server_sequence
            body = event["body"]
            event_type = body.get("type")
            if event_type not in ("reaction.added", "reaction.removed"):
                continue
            payload = body.get("payload") or {}
            key = cast(
                "tuple[str, str, str]",
                (payload.get("message_id"), body.get("author_user_id"), payload.get("emoji")),
            )
            if event_type == "reaction.added":
                membership.add(key)  # idempotent add: duplicate = no-op
            else:
                membership.discard(key)  # idempotent remove: absent = no-op
    return membership


def assert_reaction_convergence(world: World, truth: Truth, reactions: ReactionRows) -> None:
    """§12.2/§2.4 (reactions) — ``reactions_proj`` == the set folded from the log.

    Proves three things at once:

    * **convergence** — the incremental projection equals the deterministic replay
      of the same log (and every client already converged on that log via
      :func:`assert_convergence`, which compares the full pulled event stream);
    * **idempotency** — duplicate ``reaction.added`` and absent ``reaction.removed``
      collapse to the set, so a byte-noisy log yields the exact membership set;
    * **counts are a pure function of the log** — the ``(message_id, emoji) → count``
      aggregate derived from the projection equals the one derived from the replay.
    """
    # The projection is a genuine set — no duplicate membership row (PK-enforced,
    # asserted directly so a regression that drops the PK would bite here too).
    assert len(reactions) == len(set(reactions)), (
        f"reactions: duplicate membership row in reactions_proj: {reactions}"
    )
    projected = set(reactions)
    expected = _expected_reaction_set(world, truth)
    assert projected == expected, (
        f"reactions: reactions_proj set != log replay; "
        f"projected={projected!r} expected={expected!r}"
    )

    # Aggregated counts (the read-model derivation) match the log's, both ways.
    projected_counts = Counter((mid, emoji) for (mid, _user, emoji) in projected)
    expected_counts = Counter((mid, emoji) for (mid, _user, emoji) in expected)
    assert projected_counts == expected_counts, (
        f"reactions: (message,emoji) counts diverge; "
        f"projected={projected_counts!r} expected={expected_counts!r}"
    )


def _expected_messages(world: World, truth: Truth) -> dict[str, MessageRow]:
    """Replay the log's ``message.*`` events → the expected ``messages_proj`` state.

    A pure fold over server truth in ``server_sequence`` order per stream, mirroring
    the projection apply (ENG-98):

    * ``message.created`` seeds the row (text, created_seq, edited_seq=None,
      deleted=False).
    * ``message.edited`` is last-writer-wins by ``server_sequence`` — it overwrites
      text + edited_seq ONLY when its seq exceeds ``edited_seq or created_seq``, and
      NEVER on a deleted row (delete is terminal).
    * ``message.deleted`` tombstones: deleted=True, text='' (content redacted).

    All edits/deletes of a message are homed in that message's stream (ENG-98
    validation), so a single-stream ordered replay is exact. The result is what a
    correct ``messages_proj`` MUST equal.
    """
    state: dict[str, dict[str, Any]] = {}
    for stream in world.shared_streams:
        for event in truth[stream]:  # ascending server_sequence
            body = event["body"]
            event_type = body.get("type")
            seq = event["server_sequence"]
            payload = body.get("payload") or {}
            mid = cast("str", payload.get("message_id"))
            if event_type == "message.created":
                state[mid] = {
                    "stream_id": body.get("stream_id"),
                    "author_user_id": body.get("author_user_id"),
                    "text": payload.get("text"),
                    "created_seq": seq,
                    "edited_seq": None,
                    "deleted": False,
                }
            elif event_type == "message.edited":
                s = state.get(mid)
                if s is None or s["deleted"]:
                    continue  # unknown target (rejected) or terminal tombstone
                if seq > (s["edited_seq"] or s["created_seq"]):
                    s["text"] = payload.get("text")
                    s["edited_seq"] = seq
            elif event_type == "message.deleted":
                s = state.get(mid)
                if s is None:
                    continue
                s["deleted"] = True
                s["text"] = ""  # content redaction
    return {
        mid: (
            mid,
            s["stream_id"],
            s["author_user_id"],
            s["text"],
            s["created_seq"],
            s["edited_seq"],
            s["deleted"],
        )
        for mid, s in state.items()
    }


def assert_message_convergence(world: World, truth: Truth, messages: MessageRows) -> None:
    """§12.2/§2.4 (edits/deletes) — ``messages_proj`` == the state folded from the log.

    Proves at once:

    * **LWW convergence** — every edited row carries the HIGHEST-``server_sequence``
      edit's text (out-of-order deliveries still converge, since the fold and the
      apply share the same seq-guarded rule).
    * **tombstone** — every deleted message is ``deleted=True`` with redacted
      (empty) ``text``: its content is not observable through the projection, and a
      later edit did not un-delete it (deleted is terminal).
    * **rebuild-equivalence** is proved separately by the runner's invariant 6.
    """
    projected = {row[0]: row for row in messages}
    expected = _expected_messages(world, truth)
    assert projected == expected, (
        f"messages: messages_proj state != log replay (LWW/tombstone); "
        f"projected={projected!r} expected={expected!r}"
    )
    # Content redaction, stated directly: no deleted row serves non-empty content.
    for _mid, _stream, _author, text, _cseq, _eseq, deleted in messages:
        assert not (deleted and text != ""), (
            "messages: a deleted message still serves content through messages_proj"
        )


def assert_permission_isolation(world: World, reactions: ReactionRows) -> None:
    """§12.4 — the adversary observes ZERO private-stream data (ACCEPTANCE, every run).

    The adversary is a workspace member but a non-member of the private channel.
    (a) the private stream is **absent** from its ``GET /v1/sync``; (b) a direct
    ``GET /v1/events?stream_id=<private>`` returned **404** (existence not
    disclosed, §3.6.2 — not 403); (c) its ``pulled`` contains no event whose
    ``body.stream_id`` is the private channel.  (a)/(b) are collected during settle.

    ENG-97 extends the surface to reactions: (d) the adversary could NOT react to
    a message in the private stream it cannot read (the reaction upload was
    refused, collected during settle), and (e) it authored ZERO ``reactions_proj``
    rows anywhere — a client cannot react to, nor leave any observable reaction on,
    a stream it may not read.
    """
    priv = world.private_stream
    assert priv not in world.adversary_visible, (
        "isolation: adversary's sync exposed the private stream"
    )
    assert world.adversary_private_forbidden, "isolation: adversary's private pull was not a 404"
    for stream, pulled in world.adversary.pulled.items():
        assert stream != priv or not pulled, "isolation: adversary pulled the private stream"
        for ev in pulled:
            assert ev["body"].get("stream_id") != priv, (
                "isolation: a private-stream event reached the adversary's pulled log"
            )

    # (d) the adversary's react to an unreadable private message was refused.
    assert world.adversary_reaction_forbidden, (
        "isolation: adversary reacted to a message in the private stream it cannot read"
    )
    # (e) no reaction authored by the adversary landed in the projection.
    adversary_id = world.adversary.user_id
    assert all(author != adversary_id for (_mid, author, _emoji) in reactions), (
        "isolation: a reaction authored by the adversary landed in reactions_proj"
    )

    # ENG-98 (f): the adversary could NOT edit a PUBLIC message it did not author —
    # the author-or-admin rule refuses a non-author non-admin edit even on a stream
    # the adversary can read (so this is NOT merely the stream gate). The refusal
    # leaves zero projection changes: assert_message_convergence already proves
    # messages_proj == the log replay, and the refused edit never entered the log.
    assert world.adversary_edit_forbidden, (
        "isolation: adversary edited a message it did not author (author-or-admin bypass)"
    )


def assert_all(world: World, truth: Truth, reactions: ReactionRows, messages: MessageRows) -> None:
    """Run the invariants after every example (four skeleton + reaction + message).

    The four §12-subset invariants, reaction convergence/idempotency (ENG-97), and
    message LWW/tombstone convergence (ENG-98); the reaction + edit/delete
    permission-isolation checks are folded into :func:`assert_permission_isolation`.
    Rebuild ≡ incremental (invariant 6) for all projections is asserted separately
    by the runner.
    """
    assert_idempotency(world, truth)
    assert_convergence(world, truth)
    assert_cursor_integrity(world, truth)
    assert_reaction_convergence(world, truth, reactions)
    assert_message_convergence(world, truth, messages)
    assert_permission_isolation(world, reactions)
