"""prefs

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-08 00:00:00.000000

Additive, non-breaking (ENG-124, D3). Adds the ``prefs`` table: the per-user,
per-stream notification preference — the SAME D3 **synced per-user KV** message
class as ``read_state`` (neither a durable/hashed/projected event nor ephemeral
presence). One row per ``(user_id, stream_id)`` carrying ``level`` ∈
``{all, mentions, mute}``; ABSENCE of a row means the default ``all``.

**LWW, not monotonic.** Unlike ``read_state`` (a ``GREATEST`` monotonic marker),
a pref is a plain last-write-wins overwrite (``ON CONFLICT DO UPDATE SET level =
EXCLUDED.level``). ``level`` is guarded twice: the Pydantic request model (422 on
a bad value) and the ``ck_prefs_level_valid`` CHECK here as defense-in-depth,
mirroring ``users.role`` / ``streams.kind``. Composite PK ``(user_id,
stream_id)``. Paired with the ``Pref`` model so the permanent ``test_migrations``
``compare_metadata`` drift gate stays green.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "prefs",
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("stream_id", sa.Text(), nullable=False),
        sa.Column("level", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # Defense-in-depth enum guard (the Pydantic model 422s first); mirrors
        # users.role / streams.kind.
        sa.CheckConstraint("level IN ('all','mentions','mute')", name=op.f("ck_prefs_level_valid")),
        sa.PrimaryKeyConstraint("user_id", "stream_id", name=op.f("pk_prefs")),
    )


def downgrade() -> None:
    op.drop_table("prefs")
