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
    # Free-text workspace description (ENG-152). NULL = never set (pre-0010
    # rows); an admin clearing it stores "" — the API stores what it was given
    # verbatim so the `workspace.updated` payload and the row never disagree.
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )
    file_quota_bytes: Mapped[int] = mapped_column(
        BigInteger,
        nullable=False,
        server_default=sa_text("10737418240"),  # 10 GiB
    )
    # Workspace icon (ENG-152): the content-addressed digest of the workspace's
    # SERVER-RE-ENCODED icon blob (256×256 WEBP minted by the owner/admin-only
    # POST /v1/admin/workspace/icon — never the raw upload's hash). NULL = no
    # icon. Serving is by ``ctx.workspace_id → this column`` only
    # (GET /v1/workspace/icon), the same no-sha-oracle discipline as
    # ``users.avatar_sha256`` (migration 0013).
    icon_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)


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
    # ENG-164 richer profile — all nullable (absence = unset), written ONLY by the
    # self-only PATCH /v1/me handler (operational state, like display_name). A
    # status whose `status_expires_at <= now` is treated as CLEARED lazily at
    # read/render time (GET /v1/me and the client fold/UI) — there is NO
    # background expiry job (migration 0010).
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_emoji: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Profile picture (ENG-152): the content-addressed digest of the user's
    # SERVER-RE-ENCODED avatar blob (256×256 WEBP minted by POST /v1/me/avatar —
    # never the raw upload's hash). NULL = no avatar. Serving is by
    # ``user_id → this column`` only (GET /v1/users/{id}/avatar), so a blob is
    # reachable through the avatar route iff some same-workspace row names it
    # here — the route can never become a general blob-read oracle (migration
    # 0012).
    avatar_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)


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


class ReactionProj(Base):
    """Server-side reaction-set projection (ENG-97, M3) — rebuildable.

    Stores the reaction **set** as one row per ``(message_id, author_user_id,
    emoji)`` membership, from which both the aggregated ``(message_id, emoji) ->
    count`` and the who-reacted list are pure derivations (``COUNT(*)`` /
    ``array_agg`` grouped by ``(message_id, emoji)``). Because the projection is
    exactly the set, ``reaction.added`` is an idempotent set-insert and
    ``reaction.removed`` an idempotent set-delete (§2.4), so the aggregated counts
    are a **pure function of the log** and ``rebuild ≡ incremental`` holds by
    construction (single :func:`~msgd.projections.apply.apply_projection`, one
    deterministic per-stream replay order — all reaction events for a message are
    homed in that message's stream, ENG-97 validation).

    **EMOJI IS OPAQUE BYTES (ENG-96 security note).** The ``emoji`` domain is the
    no-whitelist ``<= 64``-byte Unicode string — it may contain control chars and
    is NOT assumed to be a clean grapheme. ``emoji`` is declared ``TEXT COLLATE
    "C"`` so the uniqueness key ``(message_id, author_user_id, emoji)`` compares
    **byte-exactly**: a deterministic ``C`` collation guarantees two distinct
    emoji byte sequences never collide (no locale/ICU canonical-equivalence merge)
    and the identical bytes always dedup. The value is only ever bound as a
    parameterized column value (never interpolated). NUL (U+0000) cannot reach
    this table: Postgres text/JSONB rejects it at the ``events`` insert, before
    the projection runs.
    """

    __tablename__ = "reactions_proj"
    __table_args__ = (
        # The who-reacted / count read path filters + groups by (message_id, emoji);
        # emoji inherits the column's C collation, so the index is byte-exact too.
        Index("ix_reactions_proj_message_emoji", "message_id", "emoji"),
    )

    message_id: Mapped[str] = mapped_column(Text, primary_key=True)
    author_user_id: Mapped[str] = mapped_column(Text, primary_key=True)
    #: Opaque bytes — ``COLLATE "C"`` makes the uniqueness key byte-exact.
    emoji: Mapped[str] = mapped_column(Text(collation="C"), primary_key=True)


class ThreadParticipantProj(Base):
    """Server-side thread-participant projection (ENG-99, M3) — rebuildable.

    One row per ``(root_message_id, user_id)``: the DISTINCT authors of the
    NON-DELETED replies that share ``thread_root_id == root_message_id``. The
    companion ``messages_proj.reply_count`` (count of those non-deleted replies)
    and ``messages_proj.last_reply_seq`` (max ``created_seq`` among them) live on
    the ROOT message's row; this table carries the participant *set*.

    **Delete-aware + rebuild-equivalent by RECOMPUTE (see
    :func:`msgd.projections.apply._recompute_thread_root`).** Both the count and
    this set are RECOMPUTED from the current ``messages_proj`` state on every event
    that can change the non-deleted-reply set of a root — a reply ``message.created``
    (adds an author) and a reply ``message.deleted`` (may drop the last non-deleted
    reply of an author). Because each recompute is a pure function of committed
    ``messages_proj`` rows (``WHERE thread_root_id = root AND deleted = false``), and
    ``messages_proj``'s own ``(thread_root_id, deleted)`` state is already proven
    ``rebuild ≡ incremental`` (ENG-98 gate), the derived thread state is
    rebuild-equivalent by construction — a blind ``+1`` on create (which a later
    delete could not undo) is deliberately NOT used.

    A deleted reply therefore neither inflates ``reply_count`` nor keeps a ghost
    participant. Deleting a ROOT keeps its replies (the root row survives as a
    tombstone with ``reply_count`` intact — §2.4 / D7): a root's own deletion does
    not touch ``count(thread_root_id = root)``, so no recompute of the root's
    counters is triggered by it.
    """

    __tablename__ = "thread_participants_proj"

    root_message_id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[str] = mapped_column(Text, primary_key=True)


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


class Pref(Base):
    """Per-user, per-stream notification preference — synced KV, LWW (ENG-124, D3).

    The D3 **synced per-user KV** message class, the SAME third kind of state as
    ``read_state`` (neither a durable, hashed, projected event nor ephemeral
    presence): a ``(user_id, stream_id) -> level`` row that syncs with a
    same-user cross-device WS echo but is NEVER appended to the log, hashed,
    projected, or rebuilt (the D3 negative guard proves a PUT touches no
    ``events`` row and no projection). ``level`` selects the notification
    behaviour for that stream — ``all`` (every message), ``mentions`` (only
    @-mentions), or ``mute`` (nothing). ABSENCE of a row means the default level
    ``all``; the notifications consumer applies that default, so only EXPLICIT
    prefs are stored here (and returned by ``GET /v1/prefs``).

    **LWW, NOT monotonic — the key contrast with ``read_state``.** A read marker
    upserts with ``GREATEST`` (a lower incoming ``last_read_seq`` cannot rewind
    it); a pref is a plain last-write-wins overwrite — setting ``mute`` after
    ``all`` simply REPLACES ``all`` (``ON CONFLICT DO UPDATE SET level =
    EXCLUDED.level``). There is no ordering over the enum; the newest write is the
    truth.

    ``level`` is guarded twice: the Pydantic request model rejects a value outside
    ``{all,mentions,mute}`` with 422, and the ``ck_prefs_level_valid``
    CheckConstraint here is defense-in-depth at the DB (mirroring ``users.role`` /
    ``streams.kind``). Composite PK ``(user_id, stream_id)`` — one pref per user
    per stream.
    """

    __tablename__ = "prefs"
    __table_args__ = (CheckConstraint("level IN ('all','mentions','mute')", name="level_valid"),)

    user_id: Mapped[str] = mapped_column(Text, primary_key=True)
    stream_id: Mapped[str] = mapped_column(Text, primary_key=True)
    level: Mapped[str] = mapped_column(Text, nullable=False)
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
    # Whether the content-addressed blob for this row's ``sha256`` has actually
    # landed in the BlobStore (ENG-116). A row is created NOT present by
    # ``POST /v1/files/initiate`` and flipped present by a successful
    # ``PUT /v1/files/{file_id}/blob`` (server-recomputed-hash verified). The
    # download + workspace-scoped dedup surfaces gate on this flag: a not-present
    # row is NEVER downloadable and NEVER reveals its bytes to a same-sha initiate
    # (so an initiate that never completed its upload is invisible as content).
    present: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sa_text("false"))
    # sha256 of the server-GENERATED WEBP thumbnail blob for this file, or NULL
    # (ENG-118). Set best-effort in the PUT path when the uploaded bytes decode as a
    # raster image (Pillow); a non-image, a hostile/undecodable input, or a decode
    # that trips the decompression-bomb guard all leave it NULL — thumbnails never
    # fail an upload. The thumbnail is a DERIVED, content-addressed blob in the same
    # BlobStore (its own sha256, re-encoded by us to a known-safe WEBP raster, so it
    # carries no active content). ``GET /v1/files/{id}/thumbnail`` gates on this
    # being non-NULL and returns the uniform 404 otherwise — a NULL thumbnail is
    # indistinguishable from an unknown/forbidden file (no existence oracle). A
    # deduped initiate copies this from the readable present row so the derived blob
    # is generated at most once per content sha.
    thumbnail_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
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


class BotToken(Base):
    """A scoped bot bearer credential (M5, ENG-159).

    Same token discipline as ``sessions`` / ``invites`` (D2): the PK is the
    sha256 hex of the raw ``secrets.token_urlsafe(32)`` token, which is returned
    exactly once at mint time and never persisted. Unlike a session there is no
    ``expires_at`` — a bot credential lives until it is REVOKED (``revoked_at``,
    kept as an auditable tombstone by the per-token revoke endpoint) or its bot
    is DEACTIVATED (which hard-deletes every row, mirroring the session
    bulk-revoke). ``scopes`` is the JSONB list of verb scopes this credential
    carries (``events:read`` / ``events:write`` / ``files:write``, §10);
    ``require_auth`` surfaces it as ``AuthContext.scopes``. ``last_used_at`` is
    a throttled observability bump (the ``bump_session`` pattern), never an
    authorization input.
    """

    __tablename__ = "bot_tokens"
    # Non-PK lookup paths: the deactivation bulk-revoke + the plugins listing
    # both filter by bot_user_id (the sessions ``ix_sessions_user_id`` precedent).
    __table_args__ = (Index("ix_bot_tokens_bot_user_id", "bot_user_id"),)

    token_hash: Mapped[str] = mapped_column(  # sha256 of the opaque token
        Text, primary_key=True
    )
    bot_user_id: Mapped[str] = mapped_column(Text, ForeignKey("users.user_id"), nullable=False)
    workspace_id: Mapped[str] = mapped_column(Text, nullable=False)
    scopes: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class IncomingWebhook(Base):
    """An incoming-webhook registration (M5, ENG-161 — TDD §10).

    A hook is a CAPABILITY URL: ``POST /v1/hooks/<raw_token>`` needs no other
    credential, so the token discipline is the strictest we have (D2, the
    ``sessions``/``invites``/``bot_tokens`` pattern): the PK is the sha256 hex
    of the raw ``secrets.token_urlsafe(32)`` path token, which is embedded in
    the URL returned exactly once at create time and never persisted.

    The row pins the ONLY two authorities the public receiver ever exercises —
    ``bot_user_id`` (the fixed author; a bot ``users`` row from the M5-1
    provisioning path) and ``stream_id`` (the fixed target channel). An
    external payload can choose neither: the receiver builds the
    ``message.created`` body server-side from these columns and runs it
    through the same ``validate_event`` pipeline as every client upload.

    ``disabled_at`` is a soft kill-switch: the receiver folds a disabled hook
    into the SAME uniform 404 as a never-existed token (no oracle). The revoke
    endpoint hard-deletes the row (the invites discipline) — revoked is
    indistinguishable from never-existed.
    """

    __tablename__ = "incoming_webhooks"
    # Non-PK lookup path: the workspace-scoped management listing.
    __table_args__ = (Index("ix_incoming_webhooks_workspace_id", "workspace_id"),)

    token_hash: Mapped[str] = mapped_column(  # sha256 of the raw path token
        Text, primary_key=True
    )
    workspace_id: Mapped[str] = mapped_column(Text, nullable=False)
    stream_id: Mapped[str] = mapped_column(Text, ForeignKey("streams.stream_id"), nullable=False)
    bot_user_id: Mapped[str] = mapped_column(Text, ForeignKey("users.user_id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=sa_text("now()")
    )
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
