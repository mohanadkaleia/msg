"""user profile fields

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-09 00:00:00.000000

Additive, non-breaking (ENG-164, D3). Adds the richer self-profile columns to
``users``: ``title`` / ``description`` (free text, bounded by the Pydantic
request models — 422 at the HTTP boundary, mirroring ``display_name``) and the
custom status trio ``status_emoji`` / ``status_text`` / ``status_expires_at``.

All five are NULLABLE with no default: absence means "unset", exactly like the
pre-existing rows (no backfill needed). They are OPERATIONAL state written only
by the self-only ``PATCH /v1/me`` handler (never a reducer — same split
ownership as ``display_name``); each write is mirrored by a server-authored
``user.profile_updated`` meta event carrying the resulting values, which is
what client directory folds consume.

**Lazy status expiry:** there is deliberately NO expiry job or trigger — a
status with ``status_expires_at <= now()`` is treated as CLEARED at read time
(``GET /v1/me``) and at render time (the web fold/UI). Paired with the ``User``
model columns so the permanent ``test_migrations`` ``compare_metadata`` drift
gate stays green.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("title", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("description", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("status_emoji", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("status_text", sa.Text(), nullable=True))
    op.add_column(
        "users", sa.Column("status_expires_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("users", "status_expires_at")
    op.drop_column("users", "status_text")
    op.drop_column("users", "status_emoji")
    op.drop_column("users", "description")
    op.drop_column("users", "title")
