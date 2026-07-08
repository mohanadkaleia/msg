"""files.thumbnail_sha256

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-07 12:00:00.000000

Additive, non-breaking (ENG-118). Adds the nullable ``files.thumbnail_sha256``
column: the sha256 of the server-GENERATED WEBP thumbnail derived blob for an
image file, or NULL when the upload is not a decodable raster image (a non-image,
a hostile/undecodable input, or one that trips the decompression-bomb guard).

Thumbnails are strictly best-effort — a failed decode never fails the upload and
simply leaves this NULL — so the column is ``nullable=True`` with no server
default and every existing row defaults to NULL (no thumbnail). Paired with the
``File.thumbnail_sha256`` model column so the permanent ``test_migrations``
``compare_metadata`` drift gate stays green.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "files",
        sa.Column(
            "thumbnail_sha256",
            sa.Text(),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("files", "thumbnail_sha256")
