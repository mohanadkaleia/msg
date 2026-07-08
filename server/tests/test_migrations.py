"""Migration-drift and GENERATED-column tests (ENG-63 test plan).

These are the permanent gates that lock the ORM models, the initial migration,
and TDD §4.2 together, and that prove the tsvector GENERATED DDL is real.
"""

from __future__ import annotations

import msgd.db.models  # noqa: F401  (register tables on Base.metadata)
import pytest
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from msgd.db.base import Base
from sqlalchemy import inspect, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine


@pytest.mark.filterwarnings(
    # Alembic cannot compare a Computed (GENERATED) column's default and says so;
    # informational only — the tsvector test below covers that column's DDL.
    "ignore:Computed default on messages_proj.search_tsv:UserWarning"
)
async def test_migration_matches_models(migrated_db: str) -> None:
    """After ``run_migrations`` from empty, models == migration == §4.2 (no drift).

    A non-empty diff means the ORM models and the committed migration disagree —
    i.e. the migration no longer reproduces §4.2. ``compare_server_default=True``
    extends the gate to DEFAULT clauses (``now()``, quotas, flags). This gate is
    permanent.
    """
    engine = create_async_engine(migrated_db)
    try:
        async with engine.connect() as conn:
            diffs = await conn.run_sync(
                lambda sync_conn: compare_metadata(
                    MigrationContext.configure(
                        sync_conn,
                        opts={"compare_type": True, "compare_server_default": True},
                    ),
                    Base.metadata,
                )
            )
    finally:
        await engine.dispose()

    assert diffs == [], f"schema drift between models and migration: {diffs}"


async def test_check_constraints_present(migrated_db: str) -> None:
    """The three §4.2 CHECK constraints exist in the migrated DB, by reflection.

    Supplementary to the ``compare_metadata`` gate: Alembic does not reliably
    autocompare CHECK-constraint SQL text, so their presence (and the enum
    values inside) is asserted directly.
    """
    expected = {
        ("users", "ck_users_role_valid"): ("owner", "admin", "member", "guest"),
        ("streams", "ck_streams_kind_valid"): ("workspace-meta", "channel", "dm"),
        ("streams", "ck_streams_visibility_valid"): ("public", "private"),
        # ENG-124: the prefs level enum is CHECK-guarded (defense-in-depth behind
        # the Pydantic 422); compare_metadata does not reliably compare CK text.
        ("prefs", "ck_prefs_level_valid"): ("all", "mentions", "mute"),
    }

    def _reflect(sync_conn: Connection) -> dict[tuple[str, str], str]:
        inspector = inspect(sync_conn)
        found: dict[tuple[str, str], str] = {}
        for table in ("users", "streams", "prefs"):
            for ck in inspector.get_check_constraints(table):
                name = ck["name"]
                assert name is not None
                found[(table, name)] = ck["sqltext"]
        return found

    engine = create_async_engine(migrated_db)
    try:
        async with engine.connect() as conn:
            found = await conn.run_sync(_reflect)
    finally:
        await engine.dispose()

    for key, values in expected.items():
        assert key in found, f"missing CHECK constraint {key}; found: {sorted(found)}"
        for value in values:
            assert value in found[key], f"{key} lost enum value {value!r}: {found[key]}"


async def test_tsvector_generated_column_populates(db_session: AsyncSession) -> None:
    """Inserting a messages_proj row auto-populates the GENERATED search_tsv.

    Proves the ``GENERATED ALWAYS AS (to_tsvector('english', text)) STORED``
    DDL applied for real (not merely a nullable column).
    """
    await db_session.execute(
        text(
            "INSERT INTO messages_proj "
            "(message_id, stream_id, author_user_id, text, created_seq) "
            "VALUES (:mid, :sid, :uid, :txt, :seq)"
        ),
        {
            "mid": "m_test",
            "sid": "s_test",
            "uid": "u_test",
            "txt": "the quick brown fox jumps",
            "seq": 1,
        },
    )
    tsv = await db_session.scalar(
        text("SELECT search_tsv FROM messages_proj WHERE message_id = :mid"),
        {"mid": "m_test"},
    )
    assert tsv is not None
    # to_tsvector('english', ...) stems and drops stopwords; "quick" survives.
    assert "quick" in tsv
