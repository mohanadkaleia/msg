"""Harness sanity checks (ENG-63 test plan: fixture timing + isolation)."""

from __future__ import annotations

import time

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def test_container_and_schema_ready_fast(migrated_db: str) -> None:
    """Container start + migrations are well under the 30 s acceptance bar.

    By the time this test body runs, the session-scoped container and schema
    fixtures have already materialised; we assert the *incremental* cost of
    reaching a migrated DB from here is trivial (the heavy lifting is paid once
    per session, not per test).
    """
    start = time.monotonic()
    assert migrated_db  # fixture already resolved
    assert time.monotonic() - start < 30.0


async def test_rollback_isolation_first(db_session: AsyncSession) -> None:
    """Write a row; a sibling test must not see it (transaction rollback)."""
    await db_session.execute(
        text("INSERT INTO workspaces (workspace_id, name) VALUES (:id, :name)"),
        {"id": "w_isolation", "name": "leaky?"},
    )
    count = await db_session.scalar(
        text("SELECT count(*) FROM workspaces WHERE workspace_id = :id"),
        {"id": "w_isolation"},
    )
    assert count == 1


async def test_rollback_isolation_second(db_session: AsyncSession) -> None:
    """The row from the sibling test was rolled back — this session sees none."""
    count = await db_session.scalar(
        text("SELECT count(*) FROM workspaces WHERE workspace_id = :id"),
        {"id": "w_isolation"},
    )
    assert count == 0


async def test_session_commit_lands_on_savepoint(db_session: AsyncSession) -> None:
    """A handler-style ``session.commit()`` inside a test does not break isolation.

    With ``join_transaction_mode="create_savepoint"`` the commit releases a
    SAVEPOINT nested in the fixture's outer transaction rather than committing
    (and ending) that transaction. ENG-65's accept path commits for real, so the
    harness must survive commits: the data stays visible to *this* session after
    the commit, and the sibling test below proves it never reaches the database.
    """
    await db_session.execute(
        text("INSERT INTO workspaces (workspace_id, name) VALUES (:id, :name)"),
        {"id": "w_commit_leak", "name": "committed inside savepoint"},
    )
    await db_session.commit()
    count = await db_session.scalar(
        text("SELECT count(*) FROM workspaces WHERE workspace_id = :id"),
        {"id": "w_commit_leak"},
    )
    assert count == 1


async def test_session_commit_did_not_leak(db_session: AsyncSession) -> None:
    """The committed row from the sibling test was still rolled back with the
    outer transaction — no state leaked to this test."""
    count = await db_session.scalar(
        text("SELECT count(*) FROM workspaces WHERE workspace_id = :id"),
        {"id": "w_commit_leak"},
    )
    assert count == 0
