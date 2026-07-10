"""workspace description

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-09 00:00:00.000000

Additive, non-breaking (ENG-152). Adds ``workspaces.description`` — the
free-text workspace description an owner/admin sets via
``PATCH /v1/admin/workspace``. Nullable: NULL means "never set" (every
pre-existing row); clearing an existing description stores ``""`` (the API
stores exactly what it was given, so the row and the emitted
``workspace.updated`` payload never disagree). Paired with the ``Workspace``
model change so the permanent ``test_migrations`` ``compare_metadata`` drift
gate stays green.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("workspaces", sa.Column("description", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("workspaces", "description")
