"""incoming webhooks

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-09 00:00:00.000000

Additive, non-breaking (ENG-161, M5-2). Adds the ``incoming_webhooks`` table:
capability-URL hook registrations keyed by the sha256 hex of the raw path
token (the ``sessions``/``invites``/``bot_tokens`` D2 discipline — the raw
token is embedded in the capability URL returned exactly once at create and
never persisted). Each hook binds ONE bot author to ONE channel: the public
``POST /v1/hooks/<token>`` receiver may only ever produce a ``message.created``
authored by ``bot_user_id`` into ``stream_id`` — the payload can never choose
either. ``disabled_at`` is a soft kill-switch the receiver folds into the SAME
uniform 404 as a never-existed token; the revoke endpoint hard-deletes (the
invites discipline). ``ix_incoming_webhooks_workspace_id`` backs the
workspace-scoped management listing. Paired with the ``IncomingWebhook`` model
so the permanent ``test_migrations`` ``compare_metadata`` drift gate stays
green.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "incoming_webhooks",
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.Column("stream_id", sa.Text(), nullable=False),
        sa.Column("bot_user_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["stream_id"],
            ["streams.stream_id"],
            name=op.f("fk_incoming_webhooks_stream_id_streams"),
        ),
        sa.ForeignKeyConstraint(
            ["bot_user_id"],
            ["users.user_id"],
            name=op.f("fk_incoming_webhooks_bot_user_id_users"),
        ),
        sa.PrimaryKeyConstraint("token_hash", name=op.f("pk_incoming_webhooks")),
    )
    op.create_index(
        "ix_incoming_webhooks_workspace_id", "incoming_webhooks", ["workspace_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_incoming_webhooks_workspace_id", table_name="incoming_webhooks")
    op.drop_table("incoming_webhooks")
