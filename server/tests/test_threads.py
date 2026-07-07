"""Flat-channel threads server side (ENG-99, D7).

Two surfaces, mirroring ``test_edits_deletes.py`` / ``test_reactions.py``:

* **Validation (§3.2 / ENG-99).** A ``message.created`` with a non-null
  ``thread_root_id`` is a THREAD REPLY: the root must EXIST, live in the exact
  stream the reply is homed in, and be a NON-reply (flat threads — a reply may not
  root on another reply). A never-existed root, a cross-stream/unreadable root, and
  a reply-of-reply all collapse to an identical non-disclosing ``unknown_message``.
  Replying into a DELETED root's thread is ALLOWED (the tombstone row still exists).
* **``messages_proj`` + ``thread_participants_proj`` apply.** ``reply_count`` = the
  number of NON-DELETED replies; ``last_reply_seq`` = the max ``created_seq`` among
  them; participants = the DISTINCT authors of them. Deleting a reply DECREMENTS the
  count / drops a ghost participant (delete-aware); deleting a root keeps its replies
  (tombstone with ``reply_count`` intact). All RECOMPUTED from state, so
  ``rebuild ≡ incremental`` holds.
"""

from __future__ import annotations

from typing import Any

from eventsutil import message_deleted_body, message_edited_body
from msgd.core import ids
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.models import MessageProj, Stream, ThreadParticipantProj, Workspace
from msgd.events.insert import insert_event
from msgd.events.validate import Accepted, validate_event
from msgd.projections.dump import (
    dump_messages_proj,
    dump_thread_participants_proj,
)
from msgd.projections.rebuild import rebuild_projections
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

# Reuse the seeded validation world (workspace + streams + role contexts).
from test_events_validate import _expect_rejected, _seed, _World

# =============================================================================
# projection apply (direct, via insert_event) — reducer semantics
# =============================================================================


async def _seed_stream(db: AsyncSession, *, workspace_id: str, stream_id: str) -> None:
    db.add(Workspace(workspace_id=workspace_id, name="Acme"))
    await db.flush()
    db.add(
        Stream(
            stream_id=stream_id,
            workspace_id=workspace_id,
            kind="channel",
            name="c",
            visibility="public",
        )
    )
    await db.flush()


def _created(
    *, ws: str, stream: str, author: str | None = None, text: str = "hi", root: str | None = None
) -> dict[str, Any]:
    """A ``message.created`` body (optionally a reply carrying ``thread_root_id``)."""
    return build_message_created_body(
        workspace_id=ws,
        stream_id=stream,
        author_user_id=author if author is not None else ids.new_user_id(),
        author_device_id=ids.new_device_id(),
        client_created_at=now_rfc3339(),
        text=text,
        thread_root_id=root,
    ).model_dump(mode="json")


async def _row(db: AsyncSession, mid: str) -> MessageProj:
    row = await db.scalar(select(MessageProj).where(MessageProj.message_id == mid))
    assert row is not None
    return row


async def _participants(db: AsyncSession, root: str) -> set[str]:
    rows = await db.execute(
        select(ThreadParticipantProj.user_id).where(ThreadParticipantProj.root_message_id == root)
    )
    return set(rows.scalars().all())


async def test_reply_increments_root_counter_and_participants(db_session: AsyncSession) -> None:
    """A reply sets the ROOT row's reply_count/last_reply_seq and adds a participant;
    the reply's OWN row keeps default counters (it is not a root)."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    root_body = _created(ws=ws, stream=stream, text="root")
    root = root_body["payload"]["message_id"]
    await insert_event(db_session, stream_id=stream, body=root_body)

    # Root starts with zero replies.
    r = await _row(db_session, root)
    assert r.reply_count == 0 and r.last_reply_seq is None
    assert await _participants(db_session, root) == set()

    replier = ids.new_user_id()
    reply_body = _created(ws=ws, stream=stream, author=replier, text="re", root=root)
    reply = reply_body["payload"]["message_id"]
    env = await insert_event(db_session, stream_id=stream, body=reply_body)
    assert env.server is not None

    r = await _row(db_session, root)
    assert r.reply_count == 1
    assert r.last_reply_seq == env.server.server_sequence
    assert await _participants(db_session, root) == {replier}
    # The reply's own row is not a root: default counters, no participant rows.
    reply_row = await _row(db_session, reply)
    assert reply_row.reply_count == 0 and reply_row.last_reply_seq is None
    assert reply_row.thread_root_id == root


async def test_participants_are_distinct_authors(db_session: AsyncSession) -> None:
    """Two replies by the same author = one participant; last_reply_seq = the latest."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    root_body = _created(ws=ws, stream=stream, text="root")
    root = root_body["payload"]["message_id"]
    await insert_event(db_session, stream_id=stream, body=root_body)

    a, b = ids.new_user_id(), ids.new_user_id()
    await insert_event(
        db_session, stream_id=stream, body=_created(ws=ws, stream=stream, author=a, root=root)
    )
    await insert_event(
        db_session, stream_id=stream, body=_created(ws=ws, stream=stream, author=a, root=root)
    )
    last = await insert_event(
        db_session, stream_id=stream, body=_created(ws=ws, stream=stream, author=b, root=root)
    )
    assert last.server is not None

    r = await _row(db_session, root)
    assert r.reply_count == 3  # three non-deleted replies
    assert r.last_reply_seq == last.server.server_sequence
    assert await _participants(db_session, root) == {a, b}  # a deduped


async def test_deleting_a_reply_decrements_and_drops_ghost_participant(
    db_session: AsyncSession,
) -> None:
    """Deleting a reply recomputes count/last_reply_seq DOWN and removes an author
    whose only reply was deleted — a deleted reply never inflates the count."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    root_body = _created(ws=ws, stream=stream, text="root")
    root = root_body["payload"]["message_id"]
    await insert_event(db_session, stream_id=stream, body=root_body)

    a, b = ids.new_user_id(), ids.new_user_id()
    reply_a = _created(ws=ws, stream=stream, author=a, root=root)
    await insert_event(db_session, stream_id=stream, body=reply_a)
    reply_b = _created(ws=ws, stream=stream, author=b, root=root)
    env_b = await insert_event(db_session, stream_id=stream, body=reply_b)
    assert env_b.server is not None

    r = await _row(db_session, root)
    assert r.reply_count == 2 and await _participants(db_session, root) == {a, b}

    # Delete a's reply: count drops to 1, a is no longer a participant, and
    # last_reply_seq recomputes to b's reply (the surviving max).
    del_a = message_deleted_body(
        auth={"workspace_id": ws, "user_id": a, "device_id": ids.new_device_id()},
        stream_id=stream,
        message_id=reply_a["payload"]["message_id"],
    )
    await insert_event(db_session, stream_id=stream, body=del_a)

    r = await _row(db_session, root)
    assert r.reply_count == 1
    assert r.last_reply_seq == env_b.server.server_sequence
    assert await _participants(db_session, root) == {b}


async def test_deleting_last_reply_zeroes_counter(db_session: AsyncSession) -> None:
    """When every reply is deleted, reply_count → 0 and last_reply_seq → NULL, with
    no participant rows left."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    root_body = _created(ws=ws, stream=stream, text="root")
    root = root_body["payload"]["message_id"]
    await insert_event(db_session, stream_id=stream, body=root_body)
    a = ids.new_user_id()
    reply = _created(ws=ws, stream=stream, author=a, root=root)
    await insert_event(db_session, stream_id=stream, body=reply)

    await insert_event(
        db_session,
        stream_id=stream,
        body=message_deleted_body(
            auth={"workspace_id": ws, "user_id": a, "device_id": ids.new_device_id()},
            stream_id=stream,
            message_id=reply["payload"]["message_id"],
        ),
    )
    r = await _row(db_session, root)
    assert r.reply_count == 0 and r.last_reply_seq is None
    assert await _participants(db_session, root) == set()


async def test_deleting_root_keeps_replies_and_counter(db_session: AsyncSession) -> None:
    """Deleting a ROOT tombstones it but keeps its replies: reply_count stays, the
    root row survives (its own deletion does not touch the thread counter)."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    owner = ids.new_user_id()
    root_body = _created(ws=ws, stream=stream, author=owner, text="root")
    root = root_body["payload"]["message_id"]
    await insert_event(db_session, stream_id=stream, body=root_body)
    replier = ids.new_user_id()
    await insert_event(
        db_session, stream_id=stream, body=_created(ws=ws, stream=stream, author=replier, root=root)
    )

    # Delete the root itself.
    await insert_event(
        db_session,
        stream_id=stream,
        body=message_deleted_body(
            auth={"workspace_id": ws, "user_id": owner, "device_id": ids.new_device_id()},
            stream_id=stream,
            message_id=root,
        ),
    )
    r = await _row(db_session, root)
    assert r.deleted is True and r.text == ""
    assert r.reply_count == 1  # replies survive the root's tombstone
    assert await _participants(db_session, root) == {replier}


async def test_editing_a_reply_does_not_change_counter(db_session: AsyncSession) -> None:
    """A ``message.edited`` of a reply changes text only — no thread-counter change."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    root_body = _created(ws=ws, stream=stream, text="root")
    root = root_body["payload"]["message_id"]
    await insert_event(db_session, stream_id=stream, body=root_body)
    a = ids.new_user_id()
    reply = _created(ws=ws, stream=stream, author=a, root=root)
    reply_id = reply["payload"]["message_id"]
    env = await insert_event(db_session, stream_id=stream, body=reply)
    assert env.server is not None
    before_seq = (await _row(db_session, root)).last_reply_seq

    await insert_event(
        db_session,
        stream_id=stream,
        body=message_edited_body(
            auth={"workspace_id": ws, "user_id": a, "device_id": ids.new_device_id()},
            stream_id=stream,
            message_id=reply_id,
            text="edited reply",
        ),
    )
    r = await _row(db_session, root)
    assert r.reply_count == 1 and r.last_reply_seq == before_seq
    assert await _participants(db_session, root) == {a}


async def test_thread_state_rebuild_equivalent(db_session: AsyncSession) -> None:
    """An interleaved thread log (replies + a deleted reply + a deleted root) rebuilds
    byte-identically — proving the delete-aware counters/participants are a pure
    function of the log (``rebuild ≡ incremental``)."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    a, b = ids.new_user_id(), ids.new_user_id()

    root1_body = _created(ws=ws, stream=stream, author=a, text="root1")
    root1 = root1_body["payload"]["message_id"]
    root2_body = _created(ws=ws, stream=stream, author=b, text="root2")
    root2 = root2_body["payload"]["message_id"]
    await insert_event(db_session, stream_id=stream, body=root1_body)
    await insert_event(db_session, stream_id=stream, body=root2_body)

    reply_a = _created(ws=ws, stream=stream, author=a, root=root1)
    reply_b = _created(ws=ws, stream=stream, author=b, root=root1)
    reply_c = _created(ws=ws, stream=stream, author=a, root=root2)
    await insert_event(db_session, stream_id=stream, body=reply_a)
    await insert_event(db_session, stream_id=stream, body=reply_b)
    await insert_event(db_session, stream_id=stream, body=reply_c)
    # Delete a reply of root1 and the root2 message itself.
    await insert_event(
        db_session,
        stream_id=stream,
        body=message_deleted_body(
            auth={"workspace_id": ws, "user_id": a, "device_id": ids.new_device_id()},
            stream_id=stream,
            message_id=reply_a["payload"]["message_id"],
        ),
    )
    await insert_event(
        db_session,
        stream_id=stream,
        body=message_deleted_body(
            auth={"workspace_id": ws, "user_id": b, "device_id": ids.new_device_id()},
            stream_id=stream,
            message_id=root2,
        ),
    )

    dump_msgs = await dump_messages_proj(db_session)
    dump_parts = await dump_thread_participants_proj(db_session)

    await rebuild_projections(db_session)
    assert await dump_messages_proj(db_session) == dump_msgs
    assert await dump_thread_participants_proj(db_session) == dump_parts

    # Sanity on the folded state: root1 has 1 surviving reply (b), root2 tombstoned
    # but keeps its 1 reply (a).
    assert (await _row(db_session, root1)).reply_count == 1
    assert await _participants(db_session, root1) == {b}
    assert (await _row(db_session, root2)).reply_count == 1
    assert await _participants(db_session, root2) == {a}


# =============================================================================
# validation: thread-root referential check (§3.2)
# =============================================================================


async def _insert_real_message(
    db: AsyncSession, w: _World, stream_id: str, *, author: Any, root: str | None = None
) -> str:
    """Insert a real ``message.created`` (populating ``messages_proj``); return its id."""
    body = _created(ws=w.ws, stream=stream_id, author=author.user_id, root=root, text="m")
    # author_device_id must match the ctx for the reply-validation path; rebuild body
    # with the ctx device so identity binding passes when we later validate.
    body["author_device_id"] = author.device_id
    await insert_event(db, stream_id=stream_id, body=body)
    return str(body["payload"]["message_id"])


def _reply_item(w: _World, ctx: Any, stream_id: str, root: str | None) -> dict[str, Any]:
    from eventsutil import wire_item

    return wire_item(_reply_body(w, ctx, stream_id, root))


def _reply_body(w: _World, ctx: Any, stream_id: str, root: str | None) -> dict[str, Any]:
    return build_message_created_body(
        workspace_id=w.ws,
        stream_id=stream_id,
        author_user_id=ctx.user_id,
        author_device_id=ctx.device_id,
        client_created_at=now_rfc3339(),
        text="reply",
        thread_root_id=root,
    ).model_dump(mode="json")


async def test_reply_to_existing_same_stream_root_accepted(db_session: AsyncSession) -> None:
    """A reply rooting on an existing top-level message in the SAME stream is Accepted."""
    w = await _seed(db_session)
    root = await _insert_real_message(db_session, w, w.pub, author=w.member)
    out = await validate_event(db_session, ctx=w.member, item=_reply_item(w, w.member, w.pub, root))
    assert isinstance(out, Accepted), out


async def test_reply_to_nonexistent_root_unknown_message(db_session: AsyncSession) -> None:
    """A reply rooting on a never-existed message → non-disclosing unknown_message."""
    w = await _seed(db_session)
    out = _expect_rejected(
        await validate_event(
            db_session, ctx=w.member, item=_reply_item(w, w.member, w.pub, ids.new_message_id())
        ),
        "unknown_message",
    )
    assert out.detail == "no such message in this stream"


async def test_reply_cross_stream_root_unknown_message(db_session: AsyncSession) -> None:
    """A reply rooting on a message that lives in a DIFFERENT stream than the reply is
    homed in → unknown_message (same-stream homing, non-disclosing). Identical outcome
    to the nonexistent case — no cross-stream existence oracle (D13)."""
    w = await _seed(db_session)
    # A real root in the PRIVATE stream; the reply is homed in the PUBLIC stream.
    root = await _insert_real_message(db_session, w, w.priv, author=w.member)
    absent = _expect_rejected(
        await validate_event(
            db_session, ctx=w.member, item=_reply_item(w, w.member, w.pub, ids.new_message_id())
        ),
        "unknown_message",
    )
    cross = _expect_rejected(
        await validate_event(db_session, ctx=w.member, item=_reply_item(w, w.member, w.pub, root)),
        "unknown_message",
    )
    # Byte-identical outcome for absent vs. cross-stream (non-disclosure).
    assert absent.code == cross.code and absent.detail == cross.detail


async def test_reply_of_reply_rejected_flat_threads(db_session: AsyncSession) -> None:
    """Flat threads: a reply may NOT root on another reply. Rooting on a message that is
    itself a reply → the same non-disclosing unknown_message."""
    w = await _seed(db_session)
    root = await _insert_real_message(db_session, w, w.pub, author=w.member)
    first_reply = await _insert_real_message(db_session, w, w.pub, author=w.member, root=root)
    # Now try to root a new reply on ``first_reply`` (itself a reply).
    _expect_rejected(
        await validate_event(
            db_session, ctx=w.member, item=_reply_item(w, w.member, w.pub, first_reply)
        ),
        "unknown_message",
    )


async def test_reply_to_deleted_root_allowed(db_session: AsyncSession) -> None:
    """Replying into a DELETED root's thread is ALLOWED — the tombstone row still
    exists with its stream_id + null thread_root_id, so it resolves as a valid root."""
    w = await _seed(db_session)
    root = await _insert_real_message(db_session, w, w.pub, author=w.member)
    # Delete the root.
    await insert_event(
        db_session,
        stream_id=w.pub,
        body=message_deleted_body(auth=w.auth(w.member), stream_id=w.pub, message_id=root),
    )
    out = await validate_event(db_session, ctx=w.member, item=_reply_item(w, w.member, w.pub, root))
    assert isinstance(out, Accepted), out


async def test_null_thread_root_is_top_level_accepted(db_session: AsyncSession) -> None:
    """A null thread_root_id is a plain top-level message — nothing to resolve, Accepted."""
    w = await _seed(db_session)
    out = await validate_event(db_session, ctx=w.member, item=_reply_item(w, w.member, w.pub, None))
    assert isinstance(out, Accepted), out


async def test_reply_into_unreadable_stream_refused(db_session: AsyncSession) -> None:
    """Permission isolation: a non-member cannot reply into a private stream it cannot
    read. The reply is homed in the private stream, so step iii (can_write == can_read)
    refuses it BEFORE the thread-root check — existence not disclosed (permission_denied
    with the uniform stream-denied detail)."""
    w = await _seed(db_session)
    # A real root in the private stream (owner is NOT a member of priv).
    root = await _insert_real_message(db_session, w, w.priv, author=w.member)
    out = _expect_rejected(
        await validate_event(db_session, ctx=w.owner, item=_reply_item(w, w.owner, w.priv, root)),
        "permission_denied",
    )
    assert out.detail == "not permitted to write to this stream"


async def test_reply_counter_projected_on_real_accept_path(db_session: AsyncSession) -> None:
    """End-to-end through insert_event on a validated stream: a reply lands and the
    root's messages_proj counter reflects it, one row per created message."""
    w = await _seed(db_session)
    root = await _insert_real_message(db_session, w, w.pub, author=w.member)
    reply_body = _reply_body(w, w.member, w.pub, root)
    await insert_event(db_session, stream_id=w.pub, body=reply_body)

    r = await _row(db_session, root)
    assert r.reply_count == 1 and r.last_reply_seq is not None
    assert await _participants(db_session, root) == {w.member.user_id}
    total = await db_session.scalar(select(func.count()).select_from(MessageProj))
    assert total == 2  # root + reply
