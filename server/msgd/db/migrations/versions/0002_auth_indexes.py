"""auth indexes

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-05 00:00:00.000000

Additive, non-breaking (ENG-64). Adds ``ix_sessions_user_id`` to back the
non-PK lookups the auth surface needs — ``GET /v1/auth/sessions`` and future
bulk-revoke both filter ``sessions`` by ``user_id``. Paired with the model index
so the permanent ``test_migrations`` compare_metadata parity gate stays green.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_sessions_user_id", table_name="sessions")
