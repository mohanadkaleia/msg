"""SQLAlchemy 2 typed ORM models — the full §4.2 Postgres schema.

Every table in TDD §4.2 is defined here, column-for-column. Ids are TEXT
(client-mintable typed ULIDs from :mod:`msgd.core.ids`; the DB never generates
them), timestamps are ``TIMESTAMPTZ`` (``DateTime(timezone=True)``), and JSON is
``JSONB``. Foreign keys are declared *only* where §4.2 writes ``REFERENCES`` and
nowhere else — adding FKs the schema omits would diverge from the contract and
churn ``compare_metadata``.

Single-file for M1 (11 readable tables); split later if it grows. No ORM
relationships yet — query-layer tickets add them if useful.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
)
from sqlalchemy import text as sa_text
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column

from msgd.db.base import Base


class Workspace(Base):
    __tablename__ = "workspaces"

    workspace_id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )
    file_quota_bytes: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default=sa_text("10737418240"),  # 10 GiB
    )


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('owner','admin','member','guest')", name="role_valid"),
        UniqueConstraint("workspace_id", "email"),
    )

    user_id: Mapped[str] = mapped_column(Text, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        Text, ForeignKey("workspaces.workspace_id"), nullable=False
    )
    email: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)  # argon2id
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    is_bot: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_text("false"))
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Device(Base):
    __tablename__ = "devices"

    device_id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[str] = mapped_column(Text, ForeignKey("users.user_id"), nullable=False)
    label: Mapped[str | None] = mapped_column(Text, nullable=True)  # "Chrome on macOS"
    public_key: Mapped[str | None] = mapped_column(  # reserved, null in MVP
        Text, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )


class Session(Base):
    __tablename__ = "sessions"
    # Non-PK lookup path: GET /v1/auth/sessions and future bulk-revoke filter by
    # user_id (ENG-64). Paired with migration 0002; keeps compare_metadata green.
    __table_args__ = (Index("ix_sessions_user_id", "user_id"),)

    token_hash: Mapped[str] = mapped_column(  # sha256 of the opaque token
        Text, primary_key=True
    )
    user_id: Mapped[str] = mapped_column(Text, ForeignKey("users.user_id"), nullable=False)
    device_id: Mapped[str] = mapped_column(Text, ForeignKey("devices.device_id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )
    expires_at: Mapped[datetime] = mapped_column(  # 90 days rolling
        DateTime(timezone=True), nullable=False
    )


class Stream(Base):
    __tablename__ = "streams"
    __table_args__ = (
        CheckConstraint("kind IN ('workspace-meta','channel','dm')", name="kind_valid"),
        CheckConstraint("visibility IN ('public','private')", name="visibility_valid"),
    )

    stream_id: Mapped[str] = mapped_column(Text, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        Text, ForeignKey("workspaces.workspace_id"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)  # channels only
    visibility: Mapped[str | None] = mapped_column(Text, nullable=True)
    head_seq: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default=sa_text("0"))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StreamMember(Base):
    __tablename__ = "stream_members"

    stream_id: Mapped[str] = mapped_column(Text, ForeignKey("streams.stream_id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(Text, ForeignKey("users.user_id"), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )


class Event(Base):
    """The append-only event log (§4.2).

    HASH INVARIANT (D1/D14) — READ BEFORE TOUCHING THIS TABLE:
    ``body`` (JSONB) is stored **verbatim** and is the **sole** input to
    ``event_hash`` (SHA-256 over RFC 8785 JCS of ``body`` only). The server
    never mutates an accepted ``body``. ``client_created_at`` is a *derived,
    lossy* convenience copy of the timestamp string that lives inside ``body``:
    at accept time (ENG-65) it is parsed out for SQL-level filtering, and it is
    **untrusted for ordering** (D14 — ordering is ``server_sequence`` only).
    Postgres TIMESTAMPTZ normalizes the textual offset/precision, so the column
    would not reproduce the client's verbatim string — nobody ever computes
    ``event_hash`` from the column. This ticket only *defines* the column; the
    accept path populates it. Any engineer touching hashing reads ``body``.
    """

    __tablename__ = "events"
    __table_args__ = (
        UniqueConstraint("workspace_id", "event_id"),  # idempotency
    )

    workspace_id: Mapped[str] = mapped_column(Text, nullable=False)
    event_id: Mapped[str] = mapped_column(Text, nullable=False)
    stream_id: Mapped[str] = mapped_column(
        Text, ForeignKey("streams.stream_id"), nullable=False, primary_key=True
    )
    server_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False, primary_key=True)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    type_version: Mapped[int] = mapped_column(Integer, nullable=False)
    author_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    author_device_id: Mapped[str] = mapped_column(Text, nullable=False)
    # Derived/lossy/untrusted — see the HASH INVARIANT docstring above.
    client_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    server_received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )
    event_hash: Mapped[str] = mapped_column(Text, nullable=False)
    payload_redacted: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=sa_text("false")
    )
    # Full client body, verbatim — the sole hash source (D1).
    body: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)


class MessageProj(Base):
    """Server-side message projection for search + message APIs (rebuildable)."""

    __tablename__ = "messages_proj"
    __table_args__ = (Index("ix_messages_proj_search_tsv", "search_tsv", postgresql_using="gin"),)

    message_id: Mapped[str] = mapped_column(Text, primary_key=True)
    stream_id: Mapped[str] = mapped_column(Text, nullable=False)
    thread_root_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    author_user_id: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    created_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    edited_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_text("false"))
    reply_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sa_text("0"))
    last_reply_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # GENERATED ALWAYS AS (...) STORED — non-insertable; no code ever writes it.
    # Nullable because §4.2 declares no NOT NULL on this column (in practice the
    # generation expression over a NOT NULL `text` never yields NULL).
    search_tsv: Mapped[str | None] = mapped_column(
        TSVECTOR,
        Computed("to_tsvector('english', text)", persisted=True),
        nullable=True,
    )


class ReadState(Base):
    __tablename__ = "read_state"

    user_id: Mapped[str] = mapped_column(Text, primary_key=True)
    stream_id: Mapped[str] = mapped_column(Text, primary_key=True)
    last_read_seq: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=sa_text("0")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )


class File(Base):
    __tablename__ = "files"
    __table_args__ = (Index("ix_files_workspace_id_sha256", "workspace_id", "sha256"),)

    file_id: Mapped[str] = mapped_column(Text, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(Text, nullable=False)
    sha256: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    mime_type: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    uploaded_by: Mapped[str] = mapped_column(Text, nullable=False)
    stream_id: Mapped[str | None] = mapped_column(  # null = orphan (GC candidate)
        Text, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )


class Invite(Base):
    __tablename__ = "invites"

    token_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False, server_default=sa_text("'member'"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_by: Mapped[str | None] = mapped_column(Text, nullable=True)  # single-use
