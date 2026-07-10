"""workspace icon

Revision ID: 0013
Revises: 0012
Create Date: 2026-07-10 00:00:00.000000

Additive, non-breaking (ENG-152 workspace icon). Adds ``workspaces.icon_sha256``
— the content-addressed blob digest of the workspace's SERVER-RE-ENCODED icon,
set only by the owner/admin-gated ``POST /v1/admin/workspace/icon`` (never the
raw upload's hash) and cleared to NULL by ``DELETE /v1/admin/workspace/icon``.
Nullable: NULL means "no icon" (every pre-existing row, and every cleared icon).
Paired with the ``Workspace`` model change so the permanent ``test_migrations``
``compare_metadata`` drift gate stays green.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("workspaces", sa.Column("icon_sha256", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("workspaces", "icon_sha256")
