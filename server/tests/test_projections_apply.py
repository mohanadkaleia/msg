"""Focused unit tests for the incremental ``messages_proj`` apply hook (ENG-69).

Covers dispatch (only ``message.created`` v1 projects), the column mapping,
``thread_root_id`` set/null, D9 skips (unknown type, ``message.created`` v2, meta
events), ``ON CONFLICT`` idempotence, and the accept-txn failure semantics (a
projection raise rolls back the ``events`` insert + ``head_seq`` bump — Pin 5).
"""

from __future__ import annotations

from typing import Any

import pytest
from msgd.core import ids
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.models import Event, MessageProj, Stream, Workspace
from msgd.events.emit import emit_event
from msgd.events.insert import insert_event
from msgd.projections import apply as apply_mod
from msgd.projections.apply import apply_projection
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession


async def _seed_stream(db: AsyncSession, *, workspace_id: str, stream_id: str) -> None:
    """Bootstrap a committed-in-session workspace + channel stream row."""
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


def _message_body(
    *, workspace_id: str, stream_id: str, text: str = "hi", thread_root_id: str | None = None
) -> dict[str, Any]:
    return build_message_created_body(
        workspace_id=workspace_id,
        stream_id=stream_id,
        author_user_id=ids.new_user_id(),
        author_device_id=ids.new_device_id(),
        client_created_at=now_rfc3339(),
        text=text,
        thread_root_id=thread_root_id,
    ).model_dump(mode="json")


async def _proj_count(db: AsyncSession) -> int:
    count = await db.scalar(select(func.count()).select_from(MessageProj))
    assert count is not None
    return count


async def test_message_created_projects_one_row(db_session: AsyncSession) -> None:
    """A ``message.created`` v1 through ``insert_event`` writes one row with the right columns."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    body = _message_body(workspace_id=ws, stream_id=stream, text="hello")

    env = await insert_event(db_session, stream_id=stream, body=body)
    assert env.server is not None

    row = await db_session.get(MessageProj, body["payload"]["message_id"])
    assert row is not None
    assert row.stream_id == stream
    assert row.author_user_id == body["author_user_id"]
    assert row.text == "hello"
    assert row.thread_root_id is None
    assert row.created_seq == env.server.server_sequence
    # Later-milestone columns stay at their defaults.
    assert row.edited_seq is None
    assert row.last_reply_seq is None
    assert row.deleted is False
    assert row.reply_count == 0
    assert await _proj_count(db_session) == 1


async def test_thread_root_id_preserved(db_session: AsyncSession) -> None:
    """A set ``thread_root_id`` lands in the projection row (null case covered above)."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    root = ids.new_message_id()
    body = _message_body(workspace_id=ws, stream_id=stream, thread_root_id=root)

    await insert_event(db_session, stream_id=stream, body=body)

    row = await db_session.get(MessageProj, body["payload"]["message_id"])
    assert row is not None
    assert row.thread_root_id == root


async def test_unknown_type_no_row(db_session: AsyncSession) -> None:
    """An unknown type is a D9 no-op: no row, no crash, dispatch returns False."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    body = {
        "event_id": ids.new_event_id(),
        "workspace_id": ws,
        "stream_id": stream,
        "type": "widget.exploded",
        "type_version": 7,
        "author_user_id": ids.new_user_id(),
        "author_device_id": ids.new_device_id(),
        "client_created_at": now_rfc3339(),
        "payload": {"blast_radius": 3},
    }
    applied = await apply_projection(db_session, body=body, server_sequence=1)
    assert applied is False
    assert await _proj_count(db_session) == 0


async def test_message_created_v2_no_row(db_session: AsyncSession) -> None:
    """``message.created`` v2 has no handler → skipped (unknown-version D9)."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    body = _message_body(workspace_id=ws, stream_id=stream)
    body["type_version"] = 2
    applied = await apply_projection(db_session, body=body, server_sequence=1)
    assert applied is False
    assert await _proj_count(db_session) == 0


async def test_meta_event_no_row(db_session: AsyncSession) -> None:
    """A meta event (``channel.created``) projects no message row."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    body = {
        "event_id": ids.new_event_id(),
        "workspace_id": ws,
        "stream_id": stream,
        "type": "channel.created",
        "type_version": 1,
        "author_user_id": ids.new_user_id(),
        "author_device_id": ids.new_device_id(),
        "client_created_at": now_rfc3339(),
        "payload": {"channel_stream_id": stream, "name": "general", "visibility": "public"},
    }
    applied = await apply_projection(db_session, body=body, server_sequence=1)
    assert applied is False
    assert await _proj_count(db_session) == 0


async def test_reapply_is_idempotent(db_session: AsyncSession) -> None:
    """Re-applying the same ``message.created`` (ON CONFLICT DO NOTHING) inserts no duplicate."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    body = _message_body(workspace_id=ws, stream_id=stream)

    assert await apply_projection(db_session, body=body, server_sequence=1) is True
    # Same message_id, a different (irrelevant) sequence — must not duplicate.
    assert await apply_projection(db_session, body=body, server_sequence=2) is True
    assert await _proj_count(db_session) == 1


async def test_projection_failure_rolls_back_event(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A projection raise rolls back the ``events`` insert + ``head_seq`` bump (Pin 5).

    Drives ``emit_event`` inside a ``begin_nested()`` SAVEPOINT exactly like the
    router. The apply raise propagates out of the savepoint, so the whole
    per-event emit is undone: no ``events`` row, ``head_seq`` unmoved.
    """
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    body = _message_body(workspace_id=ws, stream_id=stream)

    async def _boom(db: AsyncSession, *, body: dict[str, Any], server_sequence: int) -> None:
        raise RuntimeError("projection bug")

    monkeypatch.setitem(apply_mod._HANDLERS, ("message.created", 1), _boom)

    with pytest.raises(RuntimeError, match="projection bug"):
        async with db_session.begin_nested():
            await emit_event(db_session, home_stream_id=stream, body=body)
    monkeypatch.undo()

    # The event is rejected, not stored without its projection.
    assert await _proj_count(db_session) == 0
    events = await db_session.scalar(
        select(func.count()).select_from(Event).where(Event.event_id == body["event_id"])
    )
    assert events == 0
    stream_row = await db_session.get(Stream, stream)
    assert stream_row is not None
    assert stream_row.head_seq == 0  # the bump rolled back with the savepoint
