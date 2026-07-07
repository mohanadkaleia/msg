"""thread_participants_proj

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-06 00:00:00.000000

Additive, non-breaking (ENG-99, M3). Adds the ``thread_participants_proj`` set
projection for flat-channel threads (D7): one row per ``(root_message_id,
user_id)`` — the DISTINCT authors of the NON-DELETED replies sharing that
``thread_root_id``. The companion counters ``reply_count`` (count of non-deleted
replies) and ``last_reply_seq`` (max ``created_seq`` among them) reuse the
PRE-EXISTING ``messages_proj`` columns from M1 (ENG-69), so NO ``messages_proj``
alteration is needed — only this new table.

Both the counters and this set are RECOMPUTED from the current ``messages_proj``
state on any reply create / reply delete (delete-aware), which makes the derived
thread state a pure function of the log and ``rebuild ≡ incremental`` by
construction (ENG-99 apply.py). Paired with the ``ThreadParticipantProj`` model
so the permanent ``test_migrations`` ``compare_metadata`` drift gate stays green.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "thread_participants_proj",
        sa.Column("root_message_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint(
            "root_message_id", "user_id", name=op.f("pk_thread_participants_proj")
        ),
    )


def downgrade() -> None:
    op.drop_table("thread_participants_proj")
