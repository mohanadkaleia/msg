"""files.present

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-07 00:00:00.000000

Additive, non-breaking (ENG-116). Adds the ``files.present`` boolean tracking
whether a file row's content-addressed blob has actually landed in the
``BlobStore``. ``POST /v1/files/initiate`` inserts a row NOT present; a
successful ``PUT /v1/files/{file_id}/blob`` (server-recomputed-hash verified)
flips it present. The download and workspace-scoped dedup surfaces both gate on
this flag, so a not-present row is never downloadable and never leaks its bytes
to a same-``sha256`` initiate.

``server_default=false`` so the column is NOT NULL over any pre-existing rows
(there are none in practice — the HTTP surface is new). Paired with the ``File``
model column so the permanent ``test_migrations`` ``compare_metadata`` +
``compare_server_default`` drift gate stays green.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "files",
        sa.Column(
            "present",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("files", "present")
