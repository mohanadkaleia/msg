"""Focused unit tests for ``rebuild_projections`` (ENG-69).

Covers rebuild ≡ incremental on a small log, interrupt safety (a raise mid-replay
leaves the prior projection intact — the MVCC analogue of ENG-59's os.replace
guarantee), and order independence (per-stream sequencing, hence the dump, is
invariant under cross-stream insert interleaving).
"""

from __future__ import annotations

from typing import Any

import pytest
from msgd.core import ids
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.models import Stream, Workspace
from msgd.events.insert import insert_event
from msgd.projections import apply as apply_mod
from msgd.projections.dump import dump_messages_proj
from msgd.projections.rebuild import rebuild_projections
from msgd.settings import Settings
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

_RESET = "TRUNCATE messages_proj, events, stream_members, streams, workspaces CASCADE"


async def _truncate(engine: Any) -> None:
    async with engine.begin() as conn:
        await conn.execute(text(_RESET))


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


def _message_body(
    *,
    workspace_id: str,
    stream_id: str,
    text_: str,
    message_id: str | None = None,
    author_user_id: str | None = None,
) -> dict[str, Any]:
    return build_message_created_body(
        workspace_id=workspace_id,
        stream_id=stream_id,
        author_user_id=author_user_id if author_user_id is not None else ids.new_user_id(),
        author_device_id=ids.new_device_id(),
        client_created_at=now_rfc3339(),
        text=text_,
        message_id=message_id,
    ).model_dump(mode="json")


async def test_rebuild_equals_incremental(db_session: AsyncSession) -> None:
    """Incremental build then rebuild → byte-identical dumps."""
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    for t in ["one", "two", "three"]:
        await insert_event(
            db_session,
            stream_id=stream,
            body=_message_body(workspace_id=ws, stream_id=stream, text_=t),
        )
    dump_incremental = await dump_messages_proj(db_session)
    assert dump_incremental  # non-empty

    await rebuild_projections(db_session)
    assert await dump_messages_proj(db_session) == dump_incremental


async def test_rebuild_interrupt_safe(
    settings: Settings, migrated_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A raise mid-replay rolls the rebuild txn back; the prior projection is intact.

    Uses a real committing engine (not the rolled-back ``db_session``) so the
    incremental projection is genuinely committed before the failed rebuild —
    the interrupt-safety property is only meaningful against committed prior state.
    """
    engine = create_async_engine(settings.database_url)
    cleanup = create_async_engine(settings.database_url)
    await _truncate(cleanup)
    try:
        maker = async_sessionmaker(engine, expire_on_commit=False)
        ws, stream = ids.new_workspace_id(), ids.new_stream_id()

        async with maker() as s:
            await _seed_stream(s, workspace_id=ws, stream_id=stream)
            for t in ["a", "b", "c"]:
                await insert_event(
                    s,
                    stream_id=stream,
                    body=_message_body(workspace_id=ws, stream_id=stream, text_=t),
                )
            await s.commit()
            dump_before = await dump_messages_proj(s)

        # Patch the handler to raise on the 2nd replayed event during rebuild.
        real = apply_mod._HANDLERS[("message.created", 1)]
        calls = {"n": 0}

        async def _flaky(db: AsyncSession, *, body: dict[str, Any], server_sequence: int) -> None:
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("interrupted mid-replay")
            await real(db, body=body, server_sequence=server_sequence)

        monkeypatch.setitem(apply_mod._HANDLERS, ("message.created", 1), _flaky)
        async with maker() as s:
            with pytest.raises(RuntimeError, match="interrupted mid-replay"):
                await rebuild_projections(s)
            await s.rollback()
        monkeypatch.undo()

        # TRUNCATE + partial replay rolled back → the old projection survives.
        async with maker() as s:
            assert await dump_messages_proj(s) == dump_before
    finally:
        await _truncate(cleanup)
        await engine.dispose()
        await cleanup.dispose()


async def test_rebuild_order_independent(settings: Settings, migrated_db: str) -> None:
    """Same events, different cross-stream insert interleaving → identical rebuilt dump.

    Fixed stream + message ids are reused across two runs (a truncate resets the
    DB between them) so the two dumps are directly byte-comparable; only the
    insert order differs. Per-stream ``server_sequence`` — hence the dump — is
    invariant under interleaving.
    """
    engine = create_async_engine(settings.database_url)
    cleanup = create_async_engine(settings.database_url)
    await _truncate(cleanup)
    try:
        maker = async_sessionmaker(engine, expire_on_commit=False)
        ws = ids.new_workspace_id()
        author = ids.new_user_id()
        s_a, s_b = ids.new_stream_id(), ids.new_stream_id()
        m1, m2, m3 = ids.new_message_id(), ids.new_message_id(), ids.new_message_id()
        # (stream, message_id, text)
        events = [(s_a, m1, "a1"), (s_a, m2, "a2"), (s_b, m3, "b1")]

        async def _run(order: list[int]) -> str:
            await _truncate(cleanup)
            async with maker() as s:
                await _seed_stream(s, workspace_id=ws, stream_id=s_a)
                s.add(
                    Stream(
                        stream_id=s_b,
                        workspace_id=ws,
                        kind="channel",
                        name="c",
                        visibility="public",
                    )
                )
                await s.flush()
                for i in order:
                    stream, mid, txt = events[i]
                    await insert_event(
                        s,
                        stream_id=stream,
                        body=_message_body(
                            workspace_id=ws,
                            stream_id=stream,
                            text_=txt,
                            message_id=mid,
                            author_user_id=author,
                        ),
                    )
                await s.commit()
                await rebuild_projections(s)
                return await dump_messages_proj(s)

        dump1 = await _run([0, 1, 2])
        dump2 = await _run([2, 0, 1])
        assert dump1 == dump2
        assert dump1  # non-empty sanity
    finally:
        await _truncate(cleanup)
        await engine.dispose()
        await cleanup.dispose()
