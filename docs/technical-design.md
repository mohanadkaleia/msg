# msg — Implementation Technical Design Document

**Status:** Ready for implementation
**Version:** 1.0
**Date:** 2026-07-04
**Inputs:** [`design-doc.md`](design-doc.md) (product/architecture design, 2026-07-03) and [`tech-lead-assessment.md`](tech-lead-assessment.md) (pre-implementation review, 2026-07-04)
**Linear project:** [msg](https://linear.app/kurras/project/msg-f5d31047691f/overview)

---

## 0. The one-page version

We are building a modern team messaging app for 5–50-person technical teams, where the source of truth is an **append-only event log** and every rendering surface is a **rebuildable projection** of it. A self-hosted **sync server** validates, sequences, stores, and fans out events; clients replicate per-stream and render locally.

**The layering rule that governs everything** (resolves the design doc's web-vs-local-first tension):

> **Local-first *architecture* is universal. Local-first *storage* is per-platform.**
>
> - The *protocol* — client-generated event IDs, per-stream cursors, idempotent upload, outbox, projection rebuild — applies to every client.
> - The *files* — NDJSON logs, SQLite, "workspace is a folder" — exist on the **server** (as the export format) and later on the **desktop client** (Tauri, M6). The MVP **web client is online-first**: IndexedDB cache + outbox, no SQLite-WASM, no browser NDJSON, no airplane-mode promise.

**Locked decisions** (rationale in the assessment; do not relitigate during implementation):

| # | Decision |
|---|----------|
| D1 | Event envelope split into **hashed client body** + **unhashed server metadata**; canonicalization = **RFC 8785 (JCS)**; **no `prev_event_hash`**; `signature` reserved null |
| D2 | **Per-stream `server_sequence`** + one `workspace-meta` stream per workspace; `GET /v1/sync` returns stream heads |
| D3 | Three message classes: **durable events** (log), **synced per-user state** (read markers, prefs — KV API), **ephemeral signals** (presence/typing — WebSocket only, never stored) |
| D4 | Web client: **online-first**, Dexie/IndexedDB cache, outbox, SharedWorker-owned WebSocket |
| D5 | Stack: **FastAPI + Postgres** (single uvicorn process), **Vue 3 + TS + Pinia + Tailwind + TipTap** |
| D6 | Auth: argon2id + opaque per-device session tokens + single-use invite links; **no JWT, no SMTP dependency** |
| D7 | Threads: `thread_root_id` on `message.created`, same stream (flat-channel thread model) |
| D8 | Attachments: content-addressed blobs on **local disk**, download authorized via `file_id` → membership, **never by hash**; no GC in MVP; size/quota caps |
| D9 | Event schema evolution: per-type versions, additive-only, unknown types preserved-but-skipped; projection version bump ⇒ rebuild |
| D10 | Search: **server-side Postgres FTS** for MVP; client FTS5 arrives with desktop |
| D11 | Export format: **NDJSON per stream per month** + content-addressed blobs + `manifest.json` |
| D12 | Plugins: server-side only, out-of-process, webhook-shaped, de-facto-standard incoming payloads |
| D13 | Stream access requires **current membership**; removal cuts all server-side history access; local copies are not retractable (documented property) |
| D14 | Ordering and display timestamps derive from **server sequence / server time only**; `client_created_at` is untrusted metadata |

---

## 1. System overview

```mermaid
flowchart LR
    subgraph Browser["Web client (Vue 3)"]
        UI[Tabs / UI views]
        SW[SharedWorker<br/>WebSocket + cache owner]
        IDB[(IndexedDB<br/>events, projections,<br/>cursors, outbox)]
        UI <--> SW
        SW <--> IDB
    end

    subgraph Server["Sync server (FastAPI, 1 process)"]
        API[HTTP API /v1]
        WS[WebSocket hub<br/>in-memory registry]
        SEQ[Validator + sequencer]
        FTS[Postgres FTS search]
        EXP[Export/import]
        PLG[Plugin gateway<br/>webhooks in/out]
    end

    PG[(Postgres<br/>events, users, streams,<br/>read-state, files)]
    DISK[(Local disk<br/>content-addressed blobs)]

    SW <-->|"POST /v1/events/batch<br/>GET /v1/events, /v1/sync"| API
    SW <-->|events + ephemeral frames| WS
    API --> SEQ --> PG
    WS --> PG
    API --> DISK
    EXP --> PG
    EXP --> DISK
    PLG <-->|HTTP| EXT[External plugin processes]
```

Two deployed containers: `app` and `postgres`. Blobs live on a bind-mounted volume. **One uvicorn worker** — WebSocket fanout is an in-process registry; this constraint is documented in the compose file and revisited only when a real workspace outgrows it.

### 1.1 Repository layout

```text
msg/
  server/
    msgd/
      api/            # FastAPI routers: auth, events, sync, files, search, read_state, admin, plugins
      core/           # event envelope, JCS canonicalization, hashing, schemas (shared with CLI)
      db/             # SQLAlchemy models, Alembic migrations
      ws/             # WebSocket hub, connection registry, fanout, ephemeral signals
      projections/    # server-side projections (message table, FTS, unread heads)
      export/         # NDJSON export/import
      plugins/        # webhook receiver, event subscriptions, bot tokens
    tests/
      simulation/     # property-based convergence suite (the M2 gate)
  cli/                # msgctl: M0 spike, then ops tool (export, import, verify, admin)
  web/                # Vue 3 app
    src/
      worker/         # SharedWorker: socket, sync engine, outbox, Dexie
                      #   + desktop seams (M6): SqliteDb/SqlDriver, mirror (NDJSON), SecretStore
      stores/         # Pinia
      components/
  desktop/            # Tauri shell (M6-5, ENG-170): thin native host around the SAME Vue app —
                      #   window + rusqlite/fs/keychain commands; the manually-validated
                      #   native layer (per-platform human sign-off, not CI)
  docs/
  docker-compose.yml
```

The `core/` event library is written once in Python and consumed by both server and CLI. The web client re-implements only the envelope construction + hashing (small, spec-tested against shared JSON test vectors in `core/testdata/` — both implementations must pass the same vectors).

---

## 2. Event model

### 2.1 Envelope: client body vs. server metadata

An event as stored and transmitted has two sections. **`event_hash` = SHA-256 over the RFC 8785 (JCS) canonicalization of the `body` object only.** The server never mutates `body`; everything the server knows goes in `server`.

```json
{
  "body": {
    "event_id": "01JZ7N6A4M6Y8W5K2H7DGKX4PA",
    "workspace_id": "w_01JZ...",
    "stream_id": "s_01JZ...",
    "type": "message.created",
    "type_version": 1,
    "author_user_id": "u_01JZ...",
    "author_device_id": "d_01JZ...",
    "client_created_at": "2026-07-04T18:22:10.123Z",
    "payload": {
      "message_id": "m_01JZ...",
      "text": "Hello everyone",
      "format": "markdown",
      "thread_root_id": null,
      "file_ids": [],
      "mentions": ["u_01JZ..."]
    }
  },
  "event_hash": "sha256:9f2c...",
  "signature": null,
  "server": {
    "server_sequence": 9284,
    "server_received_at": "2026-07-04T18:22:10.456Z",
    "payload_redacted": false
  }
}
```

Rules:

- `event_id` is a **ULID** minted by the client (sortable, offline-safe). All entity IDs (`u_`, `s_`, `m_`, `f_`, `d_`, `w_` + ULID) are client- or server-minted ULIDs with type prefixes.
- `signature` is **reserved, always null in MVP**. When device keys arrive (federation era), it signs `event_hash`. No `prev_event_hash` anywhere (assessment §3.4).
- `server.payload_redacted` is **reserved for post-MVP redaction**: the server may null `body.payload` and set this true; redacted events are exempt from hash verification. The field ships now so exports and clients handle it from day one. At M0 there is no redaction authority, so `msgctl verify` treats any event with `payload_redacted` set as a **failure**: the flag is client-writable in-band and cannot be allowed to waive its own hash check. The exemption described above is the **target** semantics — it re-activates at M1 only for authenticated, audited server redactions validated against their audit record, never the bare flag. (ENG-60 security ruling.)
- **`client_created_at` is untrusted** (D14). It may be displayed as "composed at" detail; all ordering, display timestamps, and "new since" logic use `server_sequence` and `server_received_at`.
- Max serialized event size: **64 KB** (hard reject at upload). The limit is measured over the §3.2 upload wire form — the UTF-8 bytes of `{ "body": …, "event_hash": … }` serialized compactly — **not** the full stored envelope; `signature` and `server` metadata are excluded, so the measured size is stable for a given `body` regardless of any server-attached metadata. (ENG-54 review clarification.)
- **JCS canonicalization depth cap (D1):** container nesting inside `body` is capped at **128 levels** (`MAX_DEPTH`); deeper input is rejected before hashing. The cap is a fixed protocol constant, not an implementation artifact, so the accept/reject boundary is identical across server processes and across the Python and TypeScript implementations. (ENG-55 security round.)
- **Integer interop cap (D1):** every integer appearing in a canonicalized `body` must lie within ±(2^53 − 1); values outside this range are rejected before hashing. This is inherent to RFC 8785's ECMAScript number model and is restated here because it is a hard wire-format constraint the TypeScript client must enforce on **magnitude** — its `JSON.parse` silently truncates values beyond 2^53 rather than raising. In practice a real `body` cannot reach the cap: all IDs are ULID strings and `type_version` is small, while sequences/counts live in `server` metadata, which is never canonicalized. (ENG-55 ruling.)

### 2.2 MVP event types

All flow through the same envelope; `payload` schemas are Pydantic models in `core/` (mirrored as JSON Schema in `docs/schemas/` for the web client and plugin authors).

**Channel/DM streams:**

| Type | Payload (required fields) | Notes |
|---|---|---|
| `message.created` | `message_id`, `text`, `format`, `thread_root_id?`, `file_ids?`, `mentions?` | First reply to a root message *is* thread creation; no `thread.created` type |
| `message.edited` | `message_id`, `text`, `mentions?` | LWW by server order; history retained |
| `message.deleted` | `message_id` | Tombstone; projection hides |
| `reaction.added` | `message_id`, `emoji` | Idempotent on `(message_id, author_user_id, emoji)` |
| `reaction.removed` | `message_id`, `emoji` | Idempotent remove |
| `pin.added` / `pin.removed` | `message_id` | |
| `file.uploaded` | `file_id`, `sha256`, `name`, `mime_type`, `size_bytes` | Emitted after blob upload confirmed (§6) |

> **`message.created.format` domain (locked at `type_version` 1):** `format` is exactly `"markdown"` or `"plain"`. New format values arrive via a `type_version` bump (§2.3), **not** an additive enum widening — an older reader must never receive a `format` it cannot render. (ENG-54 ruling.) **`message.edited.format` shares this exact locked domain** (ENG-96).

> **`reaction.*.emoji` domain (locked at `type_version` 1):** `emoji` is a bounded **Unicode string** — non-empty and at most **64 bytes** when UTF-8 encoded — validated in the payload model. There is deliberately **no server-side emoji whitelist**: any non-empty ≤64-byte Unicode grapheme (base emoji, ZWJ sequence, skin-tone modifier, keycap, or even a short non-emoji string) is accepted; the byte bound is the only gate. Widening or narrowing this domain later (adding a whitelist, changing the byte cap) is a breaking change under D9 and must arrive via a `type_version` bump, exactly like `format`. The idempotency key `(message_id, author_user_id, emoji)` (§2.4) is enforced at projection time (ENG-97), not in the payload model. (ENG-96 ruling.)

**`workspace-meta` stream** (one per workspace; every **non-guest** member is subscribed):

| Type | Payload | Notes |
|---|---|---|
| `workspace.created` | `name` | First event, sequence 1 |
| `user.joined` / `user.left` | `user_id`, `display_name?` | Workspace membership |
| `user.profile_updated` | `user_id`, changed fields | |
| `channel.created` | `channel_stream_id`, `name`, `visibility` (`public`/`private`) | |
| `channel.renamed` / `channel.archived` | `channel_stream_id`, … | |
| `channel.member_added` / `channel.member_removed` | `channel_stream_id`, `user_id` | Only these events grant/revoke private-channel access |
| `dm.created` | `dm_stream_id`, `member_user_ids` | DM/group-DM streams are created lazily on first message |
| `bot.installed` / `bot.removed` | `bot_user_id`, `name`, `scopes` | Plugin-era (M5) |

> **Guest exclusion (ENG-65 / §3.6):** "every member" here means every **non-guest** member (owner/admin/member). A `guest` is a member with restricted scope — §3.6: a guest sees only streams they are explicitly added to — so granting guests `workspace-meta` would leak the full public-channel and member roster. Guests read `workspace-meta` only via an explicit `stream_members` row, which they are never given for meta. The read predicate enforces this directly as `kind == 'workspace-meta' AND role != 'guest'`. (Consequence for the M2 member-list projection: guests do not receive meta.)

Membership events for **private** channels are visible in `workspace-meta` only to members of that channel? **No — simpler MVP rule:** private channel lifecycle events go into the **private channel's own stream**, not `workspace-meta`; `workspace-meta` carries only public-channel and workspace-level events. This keeps `workspace-meta` universally readable with zero filtering. (Consequence: a user's list of private channels is learned from `GET /v1/sync`, which only returns streams they can read.)

### 2.3 Schema evolution contract (D9)

1. `type_version` is **per event type**, starting at 1.
2. Within a version, changes are **additive-only**; all readers ignore unknown fields.
3. Unknown event *types* (or versions above a reader's max): **preserve in log/cache, skip in projection, never crash.** This is what lets old clients coexist with new servers.
4. Breaking change ⇒ increment `type_version`; the server may up-convert old versions at read time; clients send `max_supported_versions` at WebSocket connect (map of type → version) — the server uses it only for telemetry in MVP.
5. Every projection (server and client) declares a `PROJECTION_VERSION`. Bumping it forces a rebuild from the log/cache. **`rebuild` is a first-class, tested operation from M0 onward** — it is the escape hatch for every projection bug.

### 2.4 Conflict semantics (unchanged from design doc §12)

- Message creation: no conflict.
- Reactions: idempotent set ops keyed `(message_id, user_id, emoji)`.
- Edits: last write wins by `server_sequence`; prior payloads remain in the log (edit history UI reads them).
- Deletes: tombstones.
- Concurrent offline edits: server order decides; no merge UI in MVP.

---

## 3. Streams, sequencing, and the sync protocol

### 3.1 Streams and sequences (D2)

- A **stream** is the unit of ordering, permissioning, and sync: one per channel, one per DM/group-DM, one `workspace-meta` per workspace.
- The server assigns a **gapless, monotonically increasing `server_sequence` per stream** at accept time (Postgres: `UPDATE streams SET head_seq = head_seq + 1 ... RETURNING head_seq` inside the insert transaction — trivially correct under concurrency at this scale).
- **Client guarantee: per-stream sequences visible to an authorized member have no gaps.** A gap means data loss, not permissions — this is the integrity property per-workspace sequencing would have destroyed.

### 3.2 HTTP API

All endpoints under `/v1`, authenticated by `Authorization: Bearer <session_token>` (§7). Errors are RFC 9457 problem+json.

**`POST /v1/events/batch`** — upload client events.

```jsonc
// request
{ "events": [ { "body": {...}, "event_hash": "sha256:..." } ] }   // ≤ 100 events, ≤ 1 MB total
// response 200
{
  "accepted": [ { "event_id": "01JZ...", "stream_id": "s_...", "server_sequence": 9284, "server_received_at": "..." } ],
  "rejected": [ { "event_id": "01JZ...", "code": "permission_denied" | "invalid_schema" | "hash_mismatch" | "payload_too_large" | "unknown_stream", "detail": "..." } ]
}
```

- **Idempotency:** `event_id` is unique per workspace (Postgres unique index). A re-upload of an already-accepted event returns the *original* accepted record (same sequence), not an error and not a duplicate. This makes the client outbox a dumb retry loop.
- Validation order: session → workspace membership → stream write permission → schema (type + version) → `event_hash` recomputation (JCS) → payload referential checks (e.g., `file_ids` exist and were uploaded by this user; `message_id` exists for reactions/edits — or the event is rejected, no "pending reference" support in MVP) → size caps.
- Author fields (`author_user_id`, `author_device_id`) must match the session; mismatch ⇒ reject. Bot tokens (M5) may author only as their bot user.
- **Storability gate (envelope scalars, ENG-66):** the lax `Body` shape gate (`extra="allow"`) and a verifying `event_hash` are necessary but not sufficient — the envelope's scalar fields must also be **storable as typed** or the event is rejected `invalid_schema`. `type_version` must be a JSON **integer** within Postgres `INT4` range, and `client_created_at` must be a parseable RFC 3339 timestamp. An honestly-hashed but non-conforming form (e.g. a string `"1"` for `type_version`, hashed faithfully) is rejected **after** the hash check: the hash proves the bytes are the client's, not that they are storable. A JSONB-fatal body (e.g. a ` ` NUL inside a string — JSON-valid and JCS-hashable but rejected by Postgres JSONB) is likewise a per-event `invalid_schema`, isolated from the rest of the batch. This makes acceptance **total**: an event the server reports `accepted` is guaranteed round-trippable from storage. This narrows the §2.1 scalar domain (`type_version`, `client_created_at`) at the accept boundary. (ENG-66 deviation-1; supersedes that plan's "stored verbatim" companion ruling.)

**`GET /v1/sync`** — reconnect bootstrap.

```jsonc
// response: every stream the caller can currently read
{
  "streams": [
    { "stream_id": "s_meta...", "kind": "workspace-meta", "head_seq": 4102 },
    { "stream_id": "s_gen...",  "kind": "channel", "name": "general", "visibility": "public", "head_seq": 9284, "member": true },
    { "stream_id": "s_dm1...",  "kind": "dm", "member_user_ids": ["u_a","u_b"], "head_seq": 121 }
  ]
}
```

One round trip tells a reconnecting client exactly what to pull. Public channels the user hasn't joined appear (for the channel browser) with `member: false`.

**`GET /v1/events?stream_id=…&after=N&limit=500`** — forward catch-up (cursor pull).
**`GET /v1/events?stream_id=…&before=N&limit=500`** — **backward backfill** for cold start and scrollback: newest page first, lazily walk history. Both return `{ "events": [...], "has_more": bool }` in ascending sequence order within the page.

**Cold-start rule (assessment §3.14):** a new device does *not* replay full history. It pulls `GET /v1/sync`, then for each visible stream fetches the newest page (`before=head+1`), renders immediately, and backfills on scroll. `workspace-meta` alone is always synced from sequence 1 (it is small and the client needs full channel/member state).

**Other endpoints** (specified in their sections): `/v1/auth/*`, `/v1/read-state`, `/v1/prefs`, `/v1/files/*`, `/v1/search`, `/v1/admin/*`, `/v1/plugins/*`, `/v1/export`.

### 3.3 WebSocket

`GET /v1/ws` — one socket per client (per SharedWorker), authenticated via the **`Sec-WebSocket-Protocol: bearer, <token>`** subprotocol header, **not** a `?token=` query parameter: the raw session token must never appear in a URL, where it leaks into reverse-proxy access logs, browser history, and `Referer` headers that no in-process log filter can reach. The server echoes `Sec-WebSocket-Protocol: bearer` on accept (required for the browser handshake to complete). The M2 web client opens the socket as `new WebSocket(url, ["bearer", token])`; the session token is `secrets.token_urlsafe(32)`, whose alphabet (`[A-Za-z0-9-_]`, no `=` padding) is entirely valid subprotocol characters, so it rides the header unencoded. The delivery contract and frame set below are unchanged. (ENG-68 security ruling; supersedes the `?token=` form.) Messages are JSON frames:

**Server → client:**
- `{"t": "event", "event": {envelope}}` — a newly sequenced event on a stream the connection's user can read. Fanout is permission-scoped at send time: the hub resolves recipients from the in-memory membership map (invalidated by membership events).
- `{"t": "read_state", "stream_id": ..., "last_read_seq": ...}` — another device of the same user moved a read marker.
- `{"t": "presence", "user_id": ..., "state": "active"|"away"|"offline"}` — **excludes guests entirely** (ENG-125 follow-up): a guest neither broadcasts their own presence nor receives anyone else's. Presence is a workspace-**roster** signal (opaque `user_id` + online bit), so it is scoped out of guests exactly like the `workspace-meta` roster (§3.6).
- `{"t": "typing", "stream_id": ..., "user_id": ...}` — server relays, TTL 5 s, client-side expiry. Stream-membership-scoped (unchanged): a guest still gets/sends typing in streams they explicitly joined.

**Client → server:**
- `{"t": "typing", "stream_id": ...}` (rate-limited 1/3 s per stream)
- `{"t": "presence", "state": "active"|"away"}`
- `{"t": "ping"}` / server `{"t": "pong"}` — 30 s heartbeat; missed heartbeats close the socket.

**Delivery contract:** WebSocket push is an optimization, not the source of truth. The client treats frames as hints and trusts only cursors: on every (re)connect it runs `GET /v1/sync` + catch-up pulls; any pushed event with `server_sequence != cursor + 1` for its stream triggers a pull for that stream instead of blind application. This one rule eliminates the entire class of missed/duplicate-push bugs.

### 3.4 The three message classes (D3)

| Class | Examples | Store | Transport | In export? |
|---|---|---|---|---|
| **Durable events** | messages, reactions, edits, membership | Postgres `events` (+ client caches) | batch upload / pull / WS push | **Yes** |
| **Synced per-user state** | read markers, notification prefs | Postgres KV tables | `PUT/GET /v1/read-state`, `/v1/prefs` + WS echo to own devices | No |
| **Ephemeral signals** | presence, typing | in-memory only | WebSocket frames | No |

Anything new must be assigned to a class before it is built. "Is this an event?" is answered by: *would it belong in a 30-year archive of the workspace?*

### 3.5 Read state and unread counts (assessment §3.5)

```
PUT /v1/read-state          { "stream_id": "s_...", "last_read_seq": 9280 }
GET /v1/read-state          → [ { "stream_id": ..., "last_read_seq": ..., "updated_at": ... } ]
```

- Server stores `(user_id, stream_id) → last_read_seq` (monotonic: a PUT with a lower seq is ignored).
- Unread badge = `head_seq − last_read_seq` (client computes from its projection; server computes for the sidebar bootstrap payload).
- Mention badges: client projection indexes `payload.mentions` at apply time; a mention with `seq > last_read_seq` sets the red badge. No server round trip.
- Notification preferences (per-stream: `all` / `mentions` / `mute`) use the same shape: `PUT/GET /v1/prefs`.

### 3.6 Permissions (D13)

Roles: `owner`, `admin`, `member`, `guest` (workspace) — `guest` sees only streams they're explicitly added to. Stream-level: membership set per private channel/DM; public channels are readable/writable by all non-guest members (join = subscribe, but reading a public channel doesn't require joining).

Enforcement points (each independently tested):
1. **Upload:** write permission on the target stream.
2. **Pull (`/v1/events`, `/v1/sync`):** current read permission; non-member of a private stream gets `404` (not `403` — existence is not disclosed).
3. **WebSocket fanout:** recipient set recomputed on membership events.
4. **Files (§6):** via `file_id` → stream → membership.
5. **Search:** filtered by readable streams in the query itself.

Removal from a private channel cuts server-side access to *all* of its history immediately (mainstream team-chat semantics). Already-synced local copies are not retractable — this is documented user-facing behavior, inherent to local-first.

---

## 4. Server design

### 4.1 Stack

Python 3.12, FastAPI, uvicorn (**one worker**), SQLAlchemy 2 async + asyncpg, Alembic migrations, Pydantic v2 for all payload schemas, `argon2-cffi`, `rfc8785` (or vendored ~100-line JCS implementation with test vectors). No Redis, no queue, no Celery — background work (webhook delivery, export jobs) uses `asyncio` tasks in-process.

### 4.2 Postgres schema (core tables)

```sql
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  file_quota_bytes BIGINT NOT NULL DEFAULT 10737418240  -- 10 GiB
);

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,            -- argon2id
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  deactivated_at TIMESTAMPTZ,
  UNIQUE (workspace_id, email)
);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users,
  label TEXT,                              -- "Chrome on macOS"
  public_key TEXT,                         -- reserved, null in MVP
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,             -- sha256 of the opaque token
  user_id TEXT NOT NULL REFERENCES users,
  device_id TEXT NOT NULL REFERENCES devices,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL          -- 90 days rolling
);

CREATE TABLE streams (
  stream_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces,
  kind TEXT NOT NULL CHECK (kind IN ('workspace-meta','channel','dm')),
  name TEXT,                               -- channels only; renames update here
  visibility TEXT CHECK (visibility IN ('public','private')),
  head_seq BIGINT NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ
);

CREATE TABLE stream_members (
  stream_id TEXT NOT NULL REFERENCES streams,
  user_id TEXT NOT NULL REFERENCES users,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, user_id)
);

CREATE TABLE events (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  stream_id TEXT NOT NULL REFERENCES streams,
  server_sequence BIGINT NOT NULL,
  type TEXT NOT NULL,
  type_version INT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_device_id TEXT NOT NULL,
  client_created_at TIMESTAMPTZ NOT NULL,
  server_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_hash TEXT NOT NULL,
  payload_redacted BOOLEAN NOT NULL DEFAULT FALSE,
  body JSONB NOT NULL,                     -- full client body, verbatim
  PRIMARY KEY (stream_id, server_sequence),
  UNIQUE (workspace_id, event_id)          -- idempotency
);

-- Server-side projection for search + message APIs (rebuildable from events)
CREATE TABLE messages_proj (
  message_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  thread_root_id TEXT,
  author_user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_seq BIGINT NOT NULL,
  edited_seq BIGINT,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  reply_count INT NOT NULL DEFAULT 0,
  last_reply_seq BIGINT,
  search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
CREATE INDEX ON messages_proj USING GIN (search_tsv);

CREATE TABLE read_state (
  user_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  last_read_seq BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stream_id)
);

CREATE TABLE files (
  file_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  uploaded_by TEXT NOT NULL,
  stream_id TEXT,                          -- set when attached; null = orphan (GC candidate later)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON files (workspace_id, sha256);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  expires_at TIMESTAMPTZ NOT NULL,
  used_by TEXT                             -- single-use
);
```

Accept path for one event (single transaction): validate → `SELECT ... FOR UPDATE` on the stream row → `head_seq + 1` → insert into `events` → apply to `messages_proj` → commit → hand to WS hub for fanout. On `UNIQUE (workspace_id, event_id)` violation: fetch and return the original accepted record (idempotent path).

**Server-side projections follow the same rebuild contract as clients:** `msgctl rebuild-projections` truncates `messages_proj` and replays `events`. CI runs it and diffs against incremental state (M0 exit criterion, kept forever). The rebuild is a **single transaction** — one `TRUNCATE messages_proj` followed by an ordered replay of `events` through `apply_projection`, committed once (ENG-69) — so it is atomic and safe to interrupt: a killed rebuild rolls back to the prior projection, never a partial one. `TRUNCATE` takes an `ACCESS EXCLUSIVE` lock that briefly blocks concurrent reads of `messages_proj` for the rebuild's duration, which is acceptable for a single-operator admin op at M1 scale; `DELETE FROM messages_proj` (ROW-EXCLUSIVE, MVCC-invisible to other snapshots until commit) is the documented drop-in should read-during-rebuild concurrency ever matter.

### 4.3 Operational guardrails

| Guardrail | Value (config-overridable) |
|---|---|
| Max event size | 64 KB |
| Max batch | 100 events / 1 MB |
| Rate limit: events per user | 60/min sustained, burst 20/s |
| Rate limit: auth attempts | 10/min per IP + per email |
| Max file size | 100 MB |
| Per-workspace file quota | 10 GiB default |
| WS connections per user | 10 |
| Pull page size | ≤ 500 events |

**Backups:** everything lives in two places — the Postgres volume and the blob directory. Documented story: `pg_dump` + rsync of `blobs/`, or snapshot the single data directory; *and* `msgctl export` produces the portable NDJSON workspace folder, which is itself a full logical backup. Restore = import.

**Observability:** structured JSON logs (uvicorn + app), `/healthz` (DB ping), `/metrics` (Prometheus text: event throughput, WS connection count, fanout latency). OpenTelemetry deferred.

---

## 5. Web client design

### 5.1 Architecture (D4)

Vue 3 + TypeScript + Pinia + Tailwind + TipTap (composer). Vite build, served by the FastAPI app (single origin — no CORS, cookies stay simple).

**SharedWorker owns all shared mutable state** (assessment §3.14): the WebSocket, the Dexie (IndexedDB) database, the sync engine, and the outbox. Tabs are dumb views: they talk to the worker over `postMessage` RPC (query projections, subscribe to stream updates, enqueue sends). Fallback for browsers without SharedWorker (Safari < 16): Web Locks leader election, same interface. This is built in M2, not retrofitted.

### 5.2 Dexie schema

```ts
// db.ts — PROJECTION_VERSION guards all derived tables
events:      "[stream_id+server_sequence], event_id, type"   // raw envelopes (cache, evictable)
messages:    "message_id, stream_id, [stream_id+created_seq], thread_root_id"
streams:     "stream_id, kind"                               // + name, visibility, head_seq, member
cursors:     "stream_id"                                     // last_contiguous_seq, oldest_loaded_seq
outbox:      "event_id, created_at"                          // body + state: queued|sending|rejected
read_state:  "stream_id"                                     // last_read_seq (local echo of server KV)
meta:        "key"                                           // projection_version, session info, my user_id
```

- The cache is **bounded**: per stream keep the newest ~2,000 events; older pages are re-fetched via `before=` on scroll. Eviction never touches `outbox`.
- `PROJECTION_VERSION` mismatch on boot ⇒ drop derived tables, re-apply from cached `events`, then resume pulls (the client-side `rebuild`).
- IndexedDB absence/failure (private browsing) degrades gracefully: in-memory cache, everything still works online.

### 5.3 Sync engine (in the worker)

State machine per connection: `connecting → syncing → live → degraded(offline)`.

1. On connect: `GET /v1/sync` → diff heads against local cursors → parallel catch-up pulls (`after=`) for behind streams; new streams get newest-page pulls (`before=`).
2. `live`: apply WS `event` frames; **any sequence discontinuity ⇒ targeted pull** (§3.3 delivery contract).
3. Outbox drain loop: oldest-first, `POST /v1/events/batch`, exponential backoff (1 s → 30 s cap, jitter); on `accepted` → move event from outbox into `events`/projection with its real sequence; on `rejected` → mark the message failed in-UI (retry/delete affordance). Drain runs whenever connectivity resumes — a message composed during a Wi-Fi blip sends itself.
4. **Send path is optimistic:** composer → build envelope + hash in worker → insert into projection as `pending` (renders instantly, greyed timestamp) → enqueue outbox. On ack, the message settles into server order; because pending messages render at the bottom and acks arrive in seconds, reordering jank is minimal by construction.

### 5.4 UX surfaces (M2–M3)

- **Sidebar:** channels (unread bold, mention badge), DMs, presence dots; instant channel switching (projection reads, no network).
- **Message list:** virtualized scroll, day dividers, backward pagination on scroll-top, edit/delete affordances, reactions with picker, hover toolbar.
- **Composer (TipTap):** markdown shortcuts, `@mention` autocomplete (fed from workspace-meta projection), file drag-drop/paste, Enter-to-send / Shift-Enter newline, edit-last-message on ArrowUp.
- **Threads:** right-hand panel (flat-channel model); root messages show reply count/participants from projection.
- **Notifications:** in-app badges + tab-title count + `Notification` API (permission-gated) for mentions/DMs while the app is open, respecting per-stream prefs. Web Push = M3 stretch, not blocking.
- **Search:** search box → `GET /v1/search?q=…&in=…&from=…` (server FTS), results panel with jump-to-context (jump = targeted `before/after` pulls around the hit).
- **Keyboard:** Cmd+K switcher (fuzzy channel/DM/user), Alt+↑/↓ unread channel nav, Esc marks read. The switcher ships in M2 — it is cheap and defines the "fast" feel.

---

## 6. Attachments (D8)

Upload (server-proxied in MVP — no presigned URLs until S3 backend exists):

```
1. client: sha256(file) locally
2. POST /v1/files/initiate { sha256, name, mime_type, size_bytes, stream_id }
     → { file_id, upload_needed: bool }        // authz: write access to stream_id; quota + size checked here
3. if upload_needed: PUT /v1/files/{file_id}/blob   (streaming body; server verifies sha256 while writing)
4. client emits file.uploaded event, then message.created with file_ids
```

- Blob store: local disk `blobs/sha256/ab/abcd1234…`, behind a `BlobStore` interface (`put/get/exists/delete`) so S3/MinIO is a config change later.
- **Download authz by `file_id` only** (`GET /v1/files/{file_id}` → membership check on its stream → stream response). Raw hashes are never a URL. Dedup (`upload_needed: false`) is only revealed *after* the caller passed authz and quota checks for creating a file record.
- Orphaned blobs: `files.stream_id` is **set at `initiate`** (under a write-access gate) and is the **authoritative download-authz key** — it is never null for a live row and never marks an orphan (superseding the pre-ENG-116 "null `stream_id` marks orphans" framing). A future GC keys on *refcount* instead: an orphan is a **present `files` row never referenced by any accepted `message.created.file_ids`** (not a null `stream_id`). Post-MVP GC design (written now, built later): refcount = live `files` rows per sha256 referenced by an accepted message; sweep unreferenced blobs older than 30 days via `msgctl gc`.
- Image files get server-generated thumbnails (Pillow, max 720 px, stored as derived blobs) — M3, needed for a polished message list.

---

## 7. Auth, identity, invites (D6)

- **Registration:** first user on a fresh server creates the workspace and becomes `owner` (guided by `msgctl init` or first-run web flow). Everyone else joins via invite link.
- **Invites:** `POST /v1/admin/invites { role, ttl }` → single-use URL `https://host/join/<token>` (token random 256-bit, stored hashed). Acceptance page collects email + display name + password → creates user, marks invite used, emits `user.joined` to `workspace-meta`. SMTP is **optional** (config for "email this link"); the link itself is the mechanism.
- **Login:** `POST /v1/auth/login { email, password, device_label }` → argon2id verify → mint `device_id` (per browser install, persisted in IndexedDB `meta`; reused on re-login) → mint opaque session token (random 256-bit; stored **hashed**; returned once) → client stores it in worker-held memory + IndexedDB. Rolling 90-day expiry, `last_seen_at` updated on use.
- **Revocation:** sessions list + revoke in user settings (`DELETE /v1/auth/sessions/{id}`); instant, because every request hits the sessions table (indexed PK lookup — no measurable cost at this scale). This is why **no JWT**.
- Password reset: admin-issued reset link in MVP (same machinery as invites). Self-serve email reset arrives with optional SMTP.
- `devices.public_key` reserved null — device signing keys are federation-era.

---

## 8. Search (D10)

`GET /v1/search?q=…&in=<stream_id>&from=<user_id>&before=<date>&after=<date>&limit=25&cursor=…`

- Postgres FTS over `messages_proj.search_tsv`, joined against the caller's readable-streams set (same predicate as `/v1/events` authz — one shared SQL fragment, tested once).
- `websearch_to_tsquery` for Google-ish syntax; rank by `ts_rank_cd`, tie-break recency. Deleted/redacted messages excluded.
- Filter grammar parsed client-side into query params (`from:@dana in:#general before:2026-07-01`).
- Known MVP limits (documented, accepted): English stemming config, no attachment content indexing, no fuzzy match. Desktop FTS5 and/or server upgrade path (pg_trgm, Meilisearch) post-MVP.

---

## 9. Export / import (D11)

Three server-side `msgctl` commands (they read `MSG_DATABASE_URL` + `MSG_DATA_DIR` directly — no HTTP, no workspace dir): `export` writes a portable bundle, `verify` re-proves it, `import` restores it into a fresh instance. Shipped in M4 (ENG-155/156/157); the round-trip is a permanent CI gate (ENG-158, `cli/tests/test_m4_exit_gate.py`).

**Export** — `msgctl export <dir>` (`--allow-missing-blobs`) writes a bundle DIRECTORY:

```text
<dir>/
  manifest.json            # format_version, exported_at, tool, hash_algorithm, projection_version,
                           # workspace meta, per-stream index, event_count_total, blob index,
                           # sidecar digests, missing_blobs, bundle_digest
  users.json               # user snapshot: user_id, email, display_name, role, is_bot,
                           # deactivated_at — NO password_hash / sessions / devices / invites
  files.json               # PRESENT file rows: file_id, sha256, name, mime_type, size_bytes,
                           # uploaded_by, stream_id, created_at, thumbnail_sha256
  streams/
    <stream_id>/
      <YYYY-MM>.ndjson     # full envelopes (body + server metadata), ascending server_sequence
  blobs/
    <ab>/<sha256hex>       # content-addressed, mirrors the on-disk BlobStore layout
```

- **One NDJSON line = one full envelope exactly as served by the API** (`serialize_stored_event` → `event_ndjson_line`), so a fully-pulled client's `streams/<id>/` tree and an export's are byte-identical. Keyed by `stream_id`, never by name (rename-safe); month split by `server_received_at[:7]`.
- **Deterministic body.** Everything except `exported_at` (stamped by the CLI, `tool = msgctl/<version>`) and the derived `bundle_digest` is a pure function of DB + blob-store state — two exports of the same workspace differ only in those two fields.
- **The sealed manifest.** Each month file's `{sha256, bytes, event_count, first_seq, last_seq}`, both sidecar digests, the per-stream `{kind, name, visibility, archived_at, head_seq, event_count}`, and the blob index are embedded in `manifest.json`; `bundle_digest` = `sha256:` over the RFC 8785 (JCS) canonicalization of the manifest *without* the `bundle_digest` key (the same canonicalization discipline as `event_hash`, D1) — one value committing to all of it. See §12 invariant-7.
- **Secrets never leave; private content does.** `password_hash`, sessions, devices, invites, read-state, and prefs are never queried. Private streams and DMs ARE exported — export is a whole-workspace server-admin operation. **The bundle therefore contains all private workspace content and must be treated as sensitive as the database itself** (§15).
- **Missing-blob policy.** A PRESENT `files` row whose content or thumbnail blob is absent from the store is a HARD FAIL unless `--allow-missing-blobs`, which records the digests in `manifest.missing_blobs` instead of copying them.

**Verify** — `msgctl verify <dir>` dispatches on the target's marker file (`manifest.json` ⇒ bundle mode; else the live-workspace walk). In bundle mode it recomputes every `event_hash` (JCS over the raw `body`), re-proves per-stream gapless `server_sequence`, recomputes every month file's digest/counts against the manifest (the reorder/truncate/append detector, since the §9 format has no prev-hash chain), re-hashes every `blobs/<ab>/<hex>` against its path digest, checks every referenced blob is present, and recomputes `bundle_digest`. Exit 0 clean / warnings-only, 1 any failure, 2 usage/IO. This command is the ownership pitch made testable; its tamper matrix (M4-2, `test_verify_bundle_e2e`) is a permanent CI check.

**Import** — `msgctl import <dir>` restores into a **fresh instance only** (empty `workspaces`/`users`/`streams`/`events`/`files`/`invites` — merge-import is out of scope). Flags: `--set-owner-password` (reads the new owner password from `MSGCTL_OWNER_PASSWORD` or an interactive prompt, never argv/echo), `--owner-email` (selects the owner row to re-credential), `--skip-verify` (skips the verify gate — discouraged; per-event hashes and sequences are still re-checked during the import). It runs the M4-2 `verify` walk as the entry gate, restores blobs via the store's *verified* put, then in ONE transaction inserts the workspace + users, replays every event through the SAME reducer the live accept path uses (preserving `server_sequence`/`server_received_at`/`event_hash` verbatim), restores `files`, and rebuilds projections (whose single commit is the transaction's commit — §12 invariant 6 by construction). Bundles carry no password hashes: the owner is re-credentialed from `--set-owner-password` and every other user gets an unusable sentinel hash until an admin reset. The **`export → import → export`** round-trip is byte-identical modulo `exported_at`/`tool`/`bundle_digest` — M4's exit criterion (§13), asserted end-to-end in the exit gate. (Per-user export and a `GET /v1/export` HTTP surface: post-MVP.)

---

## 10. Plugins (M5, D12)

As built in M5 (ENG-159/161/162/163; operator guide in `docs/plugins.md`, deviations recorded in §15):

- **Incoming webhooks (shipped, ENG-161):** `POST /v1/hooks/<hook_token>` accepting the de-facto standard incoming-webhook shape (`{"text": …, "blocks"?: …}` — text + a small supported subset), producing a `message.created` authored by the hook's bot user in its configured channel. This makes existing chat-webhook integrations work day one. The capability URL is minted exactly once by the owner/admin `POST /v1/plugins/hooks` (only the token's sha256 is stored); the server **builds the message body itself** — the delivery payload controls only the text bytes (`format="plain"`, `mentions=[]`, `file_ids=[]`, no thread — all hard-coded) and the event goes through the same validated write path as every client upload. Every unusable-hook shape (unknown/revoked token, disabled hook, deactivated bot, archived stream) is the uniform 404.
- **Bot users (shipped, ENG-159):** `is_bot=true`, `role='guest'`, and the unusable-password sentinel for `password_hash` (a bot can never log in); provisioned via `POST /v1/plugins/bots` with one device (label `"bot"`). Auth is via scoped bearer tokens minted at `POST /v1/plugins/bots/{id}/tokens` (raw returned exactly once; sha256 handle thereafter) carrying the closed **verb**-scope vocabulary `events:write` / `events:read` / `files:write`; per-stream restriction is NOT scope grammar but event-sourced channel membership grants (`channel.member_added`/`removed` → `stream_members`, the §3.6 guest predicate) — this replaces the `events:write:<stream>` per-stream token grammar originally sketched here (§15). Bot-authored events are flagged in UI by authorship (no envelope change needed); `bot.installed` / `bot.removed` are server-authored meta events announcing the lifecycle.
- **Outgoing subscriptions (deferred → ENG-160, not built in M5):** registration record `{plugin_id, name, url, secret, event_types[], stream_ids[]|all-public}`. Server POSTs matching envelopes (HMAC-SHA256 signature header, 5 s timeout, 3 retries with backoff, auto-disable after 100 consecutive failures + admin notification). At-least-once delivery; consumers dedupe by `event_id`. Delivery must respect §12 invariant-8's read-authz clause: a subscription may only be fed events from streams its bot can read.
- **Reference plugin (shipped, ENG-162):** `plugins/github_notifier` — an out-of-process GitHub→msg notifier (verify `X-Hub-Signature-256` over the raw body → dedupe by `X-GitHub-Delivery` → format `pull_request` events → POST to the capability URL). It is the M5 exit gate's subject (§13) and the template for third-party plugins.
- Explicitly not in MVP: in-process/WASM plugin runtime, slash-command framework (a bot can implement commands by reading messages), plugin marketplace.

---

## 11. Deployment

```yaml
# docker-compose.yml
services:
  app:
    image: msg/server            # multi-stage build: web dist baked into the Python image
    ports: ["8080:8080"]
    environment:
      MSG_DATABASE_URL: postgresql+asyncpg://msg:${POSTGRES_PASSWORD}@postgres/msg
      MSG_DATA_DIR: /data        # blobs live here
      MSG_SECRET_KEY: ${MSG_SECRET_KEY}
    volumes: [ "./data:/data" ]
    depends_on: [ postgres ]
    # NOTE: exactly one app container / one uvicorn worker.
    # WebSocket fanout is in-process; horizontal scaling requires a shared
    # pub/sub layer (deliberately out of scope for MVP).
  postgres:
    image: postgres:17
    environment: { POSTGRES_DB: msg, POSTGRES_USER: msg, POSTGRES_PASSWORD: ${POSTGRES_PASSWORD} }
    volumes: [ "./postgres:/var/lib/postgresql/data" ]
```

Two services, no MinIO, no Redis (assessment §4/§28). TLS via the operator's reverse proxy (Caddy/nginx/Traefik — documented recipe with Caddy, since it's two lines and auto-HTTPS). Alembic migrations run on app startup. `msgctl` ships inside the image (`docker compose exec app msgctl …`).

---

## 12. Testing strategy

**The M2 acceptance suite is the project's go/no-go gate.** Property-based simulation tests (`hypothesis` + `pytest`) drive N simulated clients against a real server instance (in-process ASGI + ephemeral Postgres via `testcontainers`), with randomized interleavings of: sends, edits, reactions, disconnects mid-request, retries, reconnects, membership changes. Invariants asserted after every run:

1. **Idempotency:** duplicate uploads never create duplicate events; retried mid-flight sends converge to exactly one accepted event.
2. **Convergence:** all clients' projections are byte-identical to each other and to a fresh rebuild-from-pull.
3. **Cursor integrity:** reconnect after arbitrary missed events yields gapless, duplicate-free per-stream sequences.
4. **Permission isolation:** a client without membership observes zero private-stream data via pull, sync heads, search, files, or WS fanout — asserted by a dedicated "adversary client" in every simulation run.
5. **Pending settling:** optimistic messages end in correct server order with no lost/duplicated renders (asserted at the projection layer; visual jank is a manual QA item).
6. **Rebuild equivalence:** dropping projections and replaying equals incremental state — client (Dexie) and server (`messages_proj`) both.
7. **Bundle integrity (M4, ENG-158):** a §9 export bundle whose `verify` passes is a complete, unmodified, content-faithful copy of the workspace event log + blobs *relative to its manifest*, and `bundle_digest` is a single value committing to all of it. This is what closes the deliberate no-prev-hash-chain ordering gap *within* a bundle: the per-month-file digest + gapless-sequence checks catch any reorder/truncate/append that keeps every per-event `event_hash` valid, and the JCS `bundle_digest` transitively seals those manifest checks plus both sidecar digests and the blob index. The tamper matrix (M4-2, `test_verify_bundle_e2e`) and the round-trip exit gate (M4-4, `test_m4_exit_gate`) are both **permanent CI checks**. Scope caveat (§15): `bundle_digest` is an integrity SEAL, not a signature — a full reseal after tampering restores a valid `verify`, so absolute tamper-evidence requires the operator to record `bundle_digest` out-of-band.
8. **Plugin containment (M5, ENG-163):** a plugin credential — a scoped bot token or an incoming-webhook capability URL — acts only **as its bot identity** (the §3.2 author binding pins every event to the bot's own `(user, device)`; it can never author as anyone else), only **within its granted verb scopes and its explicitly granted streams** (a bot is a `guest`, so its readable/writable set is exactly its `stream_members` grants — a write outside them is the uniform `permission_denied`, and an incoming webhook posts only into its pinned channel through the same validated write path), and it can never produce a **server-authored meta type** (`bot.installed` / `bot.removed` are rejected on upload by the SERVER_AUTHORED guard for every client credential, bot or human). The M5 adversary legs — tampered plugin `X-Hub-Signature-256`, guessed capability URL, bot token writing outside its grants, member-forged `bot.installed` — are asserted with zero-effect proofs in the exit gate (`test_m5_exit_gate`, M5-5) and are **permanent CI checks**. Deferred clause (ENG-160): when outgoing subscriptions land, this invariant extends with delivery read-authz — a subscription may only ever be delivered events from streams its bot can read.
9. **Desktop workspace folder is always verify-green (M6, ENG-169):** the desktop client's on-disk workspace is at all times a valid **live** workspace to `msgctl verify` (the live mode, not the sealed-bundle mode): `streams/<stream_id>/<YYYY-MM>.ndjson` contains only server-served, hash-verified envelopes, appended gapless-from-1 per stream with **registration-before-write** (`workspace.json` names a stream's directory before its first line is written), and the folder contains **no secrets** — the session token lives in the platform `SecretStore` (OS keychain on desktop), never in the folder, with `SqliteDb.metaPut` refusing the token key outright as a fail-closed second line of defense. Asserted by the M6 exit gate (`test_m6_exit_gate`, `web/tests/integration/m6-exit-gate.spec.ts`), a **permanent CI check**: it drives the real WorkerCore+SyncEngine in full-mirror mode (SqliteDb + Node-fs seams) into a temp dir and proves `msgctl verify --json` exit 0 — initially, again after an offline→reconnect outbox drain, after a simulated crash between the NDJSON fsync and the cursor persist, and after torn-tail repair — plus NDJSON ≡ events-table byte-equality, true-offline reads/local-FTS5 search/queued sends, rebuild-from-disk ≡ incremental (invariant 6 extended to the on-disk log), and a token-absence byte-scan of every file in the folder (positive-control-proven).

> **M1 ships a subset (ENG-71), M2 turns on all six.** The M1 exit gate ships the property-based harness asserting **four** of the six invariants on every example: idempotency (1), convergence (2 — the pull/log-equality half), cursor integrity (3), and permission isolation (4 — the adversary-client acceptance criterion, asserted every run and audited across the four live §3.6 enforcement points). **Pending settling (5)** and the projection-equivalence half of **rebuild equivalence (6)** are documented seams, not asserted at M1: invariant 5 needs the M2 web client's optimistic-render layer, and the projection-equivalence half is already held by the permanent M0/M1 `rebuild ≡ incremental` gates. The M1 skeleton's client-state model and invariant shapes are the M2 shapes, so **M2 extends this suite rather than rewriting it** — and M2's hard gate is exactly "all six green in CI."

Plus: unit tests for JCS/hashing against shared cross-language test vectors (`core/testdata/vectors.json` — Python and TS must both pass); schema round-trip tests per event type/version; API contract tests from the OpenAPI schema; Playwright smoke for the golden path (login → send → reload → history intact → second browser sees message live).

---

## 13. Milestones

Sized for ~1 engineer + AI tooling; each milestone has a hard exit criterion.

| # | Scope | Exit criterion |
|---|---|---|
| **M0 — Protocol spike** (1 wk) | `core/` envelope + JCS + hashing; `msgctl` appends `message.created` to NDJSON, projects to SQLite, `rebuild`, `verify` | Rebuild ≡ incremental, hash vectors frozen, envelope schema locked for TDD §2 |
| **M1 — Sync server** (3 wk) | Auth/sessions/invites, streams + membership, `workspace-meta`, batch upload w/ per-stream sequencing + idempotency, pull (`after`/`before`), `/v1/sync`, WS push w/ scoped fanout, Postgres schema + migrations, compose file | Two `msgctl`-driven clients converge over the real server; simulation suite skeleton green |
| **M2 — Web client + sync proof** (3 wk) | Vue shell: login, sidebar, message list, composer; SharedWorker + Dexie cache + cursors + outbox; reconnect catch-up; pending→acked settling; Cmd+K switcher | **All six §12 invariants green in CI.** Hard gate: no M3 work until they pass |
| **M3 — Messaging core** (5 wk) | Threads, reactions, edits/deletes, mentions + notifications (in-app/tab/Notification API), read-state + unread badges, presence/typing, file upload/download + thumbnails, server search, channel & member management UI | **Dogfood gate: builders use msg as their only team chat for 2 weeks** |
| **M4 — Portability** (1–2 wk) ✅ | `export` / `import` / `verify` (NDJSON + blobs + manifest) — **shipped** (ENG-155/156/157/158) | **Done:** round-trip export→import→export byte-identical modulo `exported_at`/`tool`/`bundle_digest`; `verify` tamper matrix + the exit-gate round-trip green in CI (`test_m4_exit_gate`) |
| **M5 — Plugins** (2 wk) ✅ | Bot identities + scoped bot tokens (ENG-159), incoming de-facto-standard webhooks (ENG-161), GitHub notifier as reference plugin (ENG-162) — **shipped**; outgoing subscriptions deferred to ENG-160 (§15) | **Done:** GitHub PR events post into the workspace via the public plugin API only — the exit gate (`test_m5_exit_gate`, ENG-163) provisions the bot + hook over `/v1/plugins`, boots the reference plugin as a real subprocess, replays signed recorded GitHub deliveries, and observes via the member API + a live WS, plus the four §12 invariant-8 adversary legs; green in CI |
| **M6 — Desktop (Tauri)** ✅ | Same Vue app in Tauri; real SQLite + FTS5 projection (`SqliteDb`, ENG-165), local FTS5 search (ENG-166), NDJSON-on-disk workspace via full-mirror sync (ENG-167), true offline + SecretStore (ENG-168) — **shipped, headless-proven**; the Tauri shell itself (M6-5, ENG-170) is the native layer requiring manual per-platform sign-off (the `m6` tag waits on it) | **Done (CI):** the exit gate (`test_m6_exit_gate`, ENG-169) proves the substance headlessly — kill network: every query/search/send answers locally; reconnect drains the outbox into the NDJSON log; the folder passes `msgctl verify` exit 0 throughout, with no secrets in it (§12 invariant-9); green in CI |

Cut entirely: federation experiment (design doc M6). The envelope reserves what federation needs (`signature`, origin fields, content hashes); building it earns nothing before the product has users.

**Post-MVP backlog (designed-not-built, in priority order):** Web Push notifications · blob GC (`msgctl gc`) · redaction mechanism (`payload_redacted`) · proprietary-chat import · per-user export · self-serve password reset via SMTP · S3 blob backend · mobile.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| UX worse than incumbent chat apps despite sound architecture (design doc §25.1 — the #1 risk) | M3 dogfood gate is mandatory; composer/switcher/unread polish are milestone line items, not "later"; virtualized list + optimistic sends from day one |
| Sync bugs erode trust (lost/duplicated/reordered messages) | §12 simulation suite as CI gate before features; delivery contract (§3.3) makes push safe-by-construction; idempotent outbox |
| Single-process fanout ceiling | Documented constraint; at 5–50 users the ceiling is far away; the protocol is process-count-agnostic, so a pub/sub layer or Go sync-path port slots in without protocol changes |
| Scope creep toward federation/E2EE/offline-web | This TDD's cut lines (D-table, §13 cuts) are the contract; changes require revising this doc, not drive-by PRs |
| Export format becomes stale vestige | `verify` in CI against dogfood data from M4 onward; export is the backup story, so it stays load-bearing |
| Solo-builder bus factor / stall in the 5-week M3 | M3 is decomposed into independently shippable features gated on M2's frozen protocol; each lands behind the dogfood instance |

---

## 15. Deviations from the design doc (for the record)

All adopted from the tech-lead assessment: per-stream sequencing replaces per-workspace (§11.4 reversed) · `prev_event_hash` dropped, `signature` reserved · envelope split into hashed body + server metadata · web MVP is online-first (no browser NDJSON/SQLite-WASM); full offline moves to desktop M6 · server-side search replaces client FTS5 for MVP · MinIO cut from compose · `thread.created` event removed · unread/presence/typing designed as non-event classes · milestone order reworked (server before web UI; portability before plugins; federation cut). Everything else implements the design doc as written.

- **M0 exit-gate amendments (ENG-62, additive):** §2.1 now states the JCS depth cap (128 levels) and the integer interop cap (±(2^53 − 1)) as explicit D1 protocol constants, clarifies that the 64 KB cap is measured over the §3.2 `{ body, event_hash }` wire form, §2.2 locks `message.created.format` to `"markdown"|"plain"` at `type_version` 1, and §2.1 records that M0 `verify` fails on a set `payload_redacted` flag until authenticated redaction ships at M1. These are clarifications of already-implemented behavior, not decision changes; no envelope field was added, removed, or renamed.
- **Presence excludes guests entirely (ENG-125 follow-up, §3.6 roster-consistency):** presence is a workspace-**roster** signal (an opaque `user_id` + online bit for members across the workspace), so a guest neither **broadcasts** their own presence (the router skips the online/offline relay for a guest subject) nor **receives** anyone else's (`hub.publish_presence` never selects a guest recipient). This is the same guest scope `readable_streams_predicate` already enforces for the `workspace-meta` roster (the FLAGGED DEVIATION — a guest is a member with restricted scope and does not receive the member/public-channel roster). **Typing is unchanged:** it stays stream-membership-scoped via the same `readable_streams_predicate`, so a guest still gets/sends typing in streams they have explicitly joined. Two-layer exclusion (no-broadcast in the router + non-guest recipient filter in the hub) so the property is robust regardless of which side connects first.
- **M1 exit-gate amendments (ENG-73, additive):** §3.3 records that the WebSocket authenticates via `Sec-WebSocket-Protocol: bearer, <token>` (raw token off the URL — no log/proxy/history leak; server echoes `bearer` on accept), superseding the `?token=` form; §3.2 adds the storability gate (envelope scalars — integer `type_version` within `INT4`, parseable RFC 3339 `client_created_at`, JSONB-safe strings — are rejected `invalid_schema` at accept even when the lax `Body` gate and the hash both pass, so "accepted" implies round-trippable storage); §2.2 clarifies that "every member" subscribed to `workspace-meta` means every **non-guest** member (§3.6 guest scope); §4.2 states the Postgres rebuild is a single-transaction `TRUNCATE messages_proj` + ordered replay, safe to interrupt; and §12 notes the M1 simulation suite asserts four of the six invariants (pending-settling and the projection half of rebuild-equivalence are M2). These are clarifications and within-milestone surface corrections of already-implemented behavior — no envelope field and no locked D-decision changed.

- **M2 exit-gate amendments (ENG-84, additive):** the web-client milestone. No envelope field and no locked D-decision changed; the following record the M2 build's realized decisions and within-milestone deviations, each tracked by its ticket.
  1. **Acceptance-suite cross-language architecture ("extend, don't rewrite").** The six §12 invariants are asserted in the language each property lives in, not re-implemented once. The Python hypothesis simulation owns invariants 1–4 + server-6 (`messages_proj` rebuild ≡ incremental); a TypeScript [`fast-check`](https://github.com/dubzzz/fast-check) property suite owns invariant 5 (pending→acked settling) + client-6 (Dexie rebuild-equivalence), driving the **real** worker engine (outbox/projection/db), not a mock; a Playwright golden path covers the live E2E. "All six green in CI" is the conjunction of the `lint · type · test`, `web · … · build`, and `e2e · golden path` jobs (ENG-83).
  2. **The M2 composer is a plain `<textarea>`.** The TipTap rich composer (mentions / markdown / paste-handling) was deferred to M3; the `Composer` component seam is kept so the richer editor drops in without shell churn (ENG-82). **Delivered in M3 (ENG-101):** the `<textarea>` internals are replaced by TipTap (StarterKit + two Mention instances) at the SAME component seam — the send/format wire contract is unchanged (messages still go out as markdown SOURCE text via `outbox.send`, never HTML). Markdown input shortcuts render rich and serialize back to source; `@`/`#` autocomplete is fed by a new zero-network `directory.list` projection query (users folded from the cached `workspace-meta` events, channels from `streams`), and resolved `u_` mention ids populate the payload `mentions[]`/`mention_user_ids`. XSS boundary: pasted HTML is stripped to inert text before ProseMirror parses it (no `v-html` anywhere). Two clean seams are left: ArrowUp-on-empty emits `edit-last` for the ENG-102 edit round-trip, and dropped/pasted files emit `files` for the M3.5 upload flow.
  3. **`EventRow.envelope` is an OPTIONAL `StoredEnvelope`**, reconciled across the sync engine (ENG-79) and client projections (ENG-80) — fixtures build body-only rows, so the field cannot be assumed present. Hash-verify is **fail-closed**: a row whose `event_hash` is missing or does not match its recomputed hash is skipped, never stored, and the per-stream cursor never advances past it (a corrupt/forged event cannot poison the projection or strand the cursor).
  4. **WS bearer-subprotocol auth under the default backend (ENG-92).** uvicorn's default sans-io `websockets` backend delivers `Sec-WebSocket-Protocol: bearer, <token>` to ASGI as **one un-split element** `["bearer, <token>"]`, whereas the dev `wsproto` path splits it into two. `_bearer_token` now normalizes **both** shapes, so the shipped default backend (the only one `uvicorn[standard]` ships in the image) authenticates the subprotocol with no `--ws` override. Class-of-bug lesson: in-process ASGI WS tests do not surface the un-split shape — a **real-subprocess-uvicorn** regression test was added to catch it.
  5. **Display timestamps are decoded from the ULID `message_id` mint epoch** (client time at send), used for message and day-divider rendering, because the byte-asserted projection dump carries no server-time column. Carrying server-assigned time through to the display layer is deferred (ENG-90).
  6. **Virtualization is fixed-height windowing for M2.** Dynamic per-row height measurement (variable-height messages) is deferred (ENG-88); the virtualized list seam is kept.
  7. **Optimistic send settles under the client's HASH-BOUND `stream_id`** and **rejects a server `stream_id` that does not match** the one the client derived (security hardening — the server cannot silently re-home a pending send onto a different stream). The SharedWorker owns the session token; a `no-http-in-ui` guard walks `components/`, `stores/`, `composables/`, and `views/` recursively to enforce that the token and raw HTTP client never reach a tab-side module (ENG-78, ENG-81).
  8. **The Docker image now bakes `web/dist`** (this ticket). A multi-stage Node 22 + pnpm 9.15.0 web-builder compiles the SPA and copies only the built dist to `/app/web/dist`; `create_app()` mounts it at `/`, so `docker compose up --build` serves the client **single-origin** alongside `/v1`. The Node toolchain stays out of the runtime image.

- **`/v1/setup` seeds a default `#general` channel (ENG-109, additive):** first-run setup now emits a THIRD meta event after `workspace.created`(1) + owner `user.joined`(2) — a server-authored PUBLIC `channel.created`(3) for a channel named by the `default_channel_name` setting (`"general"`), homed in `workspace-meta` (§2.2 public placement). The same reducer-before-insert ordering (D4) has `_reduce_channel_created` create the channel's own stream row (`head_seq` 0) + the owner's `stream_members` row in the setup transaction, so the owner's `GET /v1/sync` returns `general` (public, `member:true`) immediately — a fresh workspace is usable out of the box, without the (not-yet-built) web channel-creation UI. `msgctl login` now `pull`s right after binding so the client learns the server's `general` by name and reuses it on `send --stream general` (no duplicate `channel.created`). `channel.created` is an existing event type and no envelope field or locked D-decision changed — purely additive.

- **M3 messaging-core amendments (ENG-105, additive):** the messaging-core milestone. **No envelope field and no locked D-decision changed**; the following record the M3 build's realized decisions and within-milestone deviations, each tracked by its ticket. All M3 event types are pre-existing (`reaction.added/removed`, `message.edited/deleted`, `channel.*`, `dm.created`); M3 built the projections + UI over them.
  1. **Reactions — a bounded OPAQUE-BYTES emoji domain + client seq-aware LWW (ENG-96/97/100).** A reaction `emoji` is opaque bytes (≤64, NUL excluded — Postgres text/JSONB rejects it pre-projection), NOT a validated grapheme: a base emoji and its skin-tone/ZWJ variants are DISTINCT byte sequences that must not collide under the C-collation uniqueness key `(message_id, author_user_id, emoji)`. `reaction.added` is a set-add and `reaction.removed` a set-discard — both idempotent (duplicate add / absent remove are no-ops), so a byte-noisy log folds to an exact membership set (`reactions_proj`, server side). The client mirror is **seq-aware LWW**: an out-of-order `removed@lo` after an `added@hi` must NOT resurrect a removed reaction — the projection keeps a per-`(message,user,emoji)` tombstone stamped with `server_sequence` so the highest-seq event wins regardless of delivery order.
  2. **`message.edited` — last-writer-wins by `server_sequence` (ENG-98/100).** Server `messages_proj` and the client projection both overwrite `text` + `edited_seq` ONLY when the edit's `server_sequence` exceeds the row's current `edited_seq or created_seq`, so concurrent/out-of-order edits converge to the highest-seq winner. The author-or-admin rule is server-enforced (a non-author edit is refused, not merely stream-gated). The client carries text AND `format` through the edit. An `(edited)` marker renders whenever `edited_seq` is set.
  3. **`message.deleted` — a SOFT-DELETE tombstone with content redaction; true erasure deferred (ENG-98/100/111).** Delete is terminal (a later edit never un-deletes) and sets `deleted=true` + redacts `text` to `''` in the projection, so a deleted message serves NO content through the read model. The UI renders a muted tombstone and the confirm is worded honestly ("removed for everyone"), **never** as cryptographic erasure — the append-only log still retains the original event. **True redaction** (a `payload_redacted` erasure mechanism that rewrites the stored log) is a deliberate follow-up, **ENG-111**.
  4. **Threads — flat, no new event type; reply_count = non-deleted recompute + `thread_participants_proj` (ENG-99/100/103, D7).** A reply is an ordinary `message.created` carrying `thread_root_id` = its (non-reply) root; a reply-of-reply is server-rejected (threads stay one level deep). A root's `reply_count` is the count of its NON-deleted replies and `last_reply_seq` their max `server_sequence` — both **delete-aware recomputes** (deleting a reply decrements the count and drops the ghost participant), not monotonic counters. `thread_participants_proj` is the distinct set of non-deleted reply authors per root. The client recomputes a root's counters from its cached replies, so an out-of-order **reply-before-root** delivery still converges once the root arrives (recompute-self on apply).
  5. **`dm.created` — self-homed, participant-based isolation (ENG-104).** A DM is a stream whose membership is its participant set; a non-participant sees it in neither sync nor a direct read (404) and cannot write into it (refused at the stream gate). The simulation's adversary probes all three every run. 1:1 for M3 (group DM deferred).
  6. **The composer is TipTap (ENG-101), replacing the M2 `<textarea>` at the same seam** — recorded in the ENG-84/M2 block (item 2). The wire contract is unchanged: messages go out as markdown SOURCE text via `outbox.send`, never HTML; `@`/`#` autocomplete reads the zero-network `directory.list` projection; pasted HTML is stripped to inert text (no `v-html`).
  7. **The OUT-OF-ORDER client-projection lesson + the windowed invariant-6 gate (ENG-100/105).** M3's cross-message references (a reaction/edit/delete/reply that names a message the client may not have applied yet) made delivery ORDER a correctness surface the M2 append-only message projection never had. The client therefore reconciles against its `events` cache on apply (recompute-self for thread counters, seq-aware LWW for reactions/edits, replay-cached-mutations for edit-before-create). The §12 invariant-6 client gate was hardened to prove it: it now replays each generated history under **windowed newest-first-then-backfill** delivery (the real cold-start + scroll-up ordering) and asserts `rebuild ≡ incremental` byte-equal, with deterministic TEETH for reply-before-root, reaction `removed@lo`+`added@hi`, and edit-before-create.
  8. **Invite/setup auto-join `#general` (ENG-109/112).** Setup auto-adds only the OWNER (via `channel.created`'s genesis member-add, ENG-109); a later invitee is auto-joined to the default `#general` on accept via a server-authored `channel.member_added` self-join (ENG-112, §2.2 homes the public-channel lifecycle event in `workspace-meta`). Guests are excluded (their scope is explicit-membership streams only). So every full member lands in a non-empty sidebar out of the box. A browser self-join of a *public* channel from the channel browser is a local view-open (reading a public channel needs no membership event, §3.6); a **persistent** public self-join membership is deferred (**ENG-113**).
  9. **Cross-language vectors — reaction/edit/delete frozen; channel/dm DEFERRED (ENG-96/110).** `vectors.json` grew 47→55, adding `reaction.added/removed` + `message.edited/deleted` byte-for-byte cases (Python and TS both pass; `VECTORS_SHA256` bumped in lock-step). `channel.created` / `dm.created` vectors are **deferred to ENG-110** — those types are Python/web-authored today with no cross-language hash consumer at stake yet, so freezing them now would be premature.
- **M3.5 file-referential amendments (ENG-117, additive):** the file-attachment security model, resolved against the merged ENG-116 reality. **No envelope field and no locked D-decision changed; NO `PROJECTION_VERSION` bump and no migration** — nothing rebuildable was added. This supersedes the pre-ENG-116 §6 "orphan-until-attached / a projection sets `files.stream_id`" framing **and** the original wording of this ticket (which mistakenly called for a `file.uploaded` reducer/projection that attaches `files.stream_id` and a `PROJECTION_VERSION 4→5` bump).
  1. **`files.stream_id` is OPERATIONAL, not projected (ENG-116).** It is bound at `POST /v1/files/initiate` under a write-access gate and read directly by download authz (`GET /v1/files/{file_id}`) — it is the single authoritative binding. There is deliberately **NO server projection that writes `files.stream_id`** (a second authoritative writer would be a split-brain hazard), so the download-authz binding never depends on projection state or a rebuild.
  2. **`file.uploaded` gets NO server projection handler** — it stays a D9 no-op in `apply_projection` (unhandled type → skipped, like a meta event). Its server role is purely a **durable, replicated log record** (the client attachment projection is ENG-120) **plus accept-time referential validation**.
  3. **Accept-time referential validation → `unknown_file` (ENG-117).** A new closed `RejectionCode` value. A `file.uploaded` (its `payload.file_id`) and every `message.created.file_ids` entry must resolve to a **PRESENT** file **uploaded by the author** in the event's **homed stream**; `file.uploaded` additionally pins **content identity** (`sha256` + `size_bytes` must equal the reserved row's — `name`/`mime_type` are display-only and deliberately not gated). Every non-qualifying shape (absent / not-present / other-author / other-workspace / other-stream / content mismatch) collapses to the **identical, non-disclosing** `unknown_file` (D13), so the file binding is never a cross-stream/cross-tenant existence oracle — in particular a `message.created` cannot borrow or re-home a file whose `files.stream_id` is a private stream the author cannot legitimately learn about. A mixed `file_ids` list with one bad id rejects the whole event.
  4. **No new rebuildable surface, so the equivalence gate is unchanged.** The client attachment projection + its windowed invariant-6 rebuild gate are **ENG-120**. The simulation gained two ops (`UploadFile`, `AttachToMessage`, driving the real Files API + `message.created.file_ids`) and an adversary file-attach isolation probe (attach-into-private blocked at the stream gate; borrowing another stream's file binding → `unknown_file`); the permission-isolation invariant now also asserts every accepted `file_ids` entry resolves to a present `files` row in that message's stream.

- **M3.5 exit-gate amendments (ENG-130, additive):** the files / search / presence / notifications milestone close-out. **No envelope field and no locked D-decision changed** — every M3.5 addition is additive under D9. `file.uploaded` is the ONLY new event type and is a D9 no-op in every server projection; everything else is deliberately a NON-event class of state. The following record the M3.5 build's realized decisions, each tracked by its ticket.
  1. **Files — `file.uploaded` over a content-addressed `BlobStore`, with best-effort thumbnails (§6, D8; ENG-114/115/116/117/118/121).** Attachment bytes live OUTSIDE the log as content-addressed blobs (sha256 path) behind the async, streaming `BlobStore` interface (local disk today; write is temp → fsync → atomic rename, so a stored path is a hash promise — S3/MinIO stays a config change, D8). The HTTP surface is initiate → PUT bytes → complete, and download/thumbnail authz reads the OPERATIONAL `files.stream_id` binding (the ENG-117 block above), never projection state. Thumbnails are best-effort server-rendered WEBP from HOSTILE bytes (pre-decode decompression-bomb bound, contain-everything try/except → `None`, always re-encode to a known-safe raster — a non-image simply has no thumbnail). The tab renders previews/downloads exclusively from worker-minted `blob:` URLs, so the token and the raw file API never reach tab-side code. `file.uploaded` joined the FROZEN cross-language vectors (55→60 cases; `VECTORS_SHA256` bumped in lock-step; Python + TS byte-identical), and the client files projection replays it under the windowed out-of-order invariant-6 gate with deterministic teeth (ENG-120).
  2. **Read-state + notification prefs — the D3 "synced per-user KV" class (§3.5; ENG-123/124/126).** A THIRD kind of state, distinct from durable events and from ephemeral presence/typing: `(user_id, stream_id) → last_read_seq` markers and `→ level ∈ {all,mentions,mute}` prefs sync per user with a **same-user-only** WS echo (a direct `_by_user` lookup, never the event-fanout stream resolve), but they are NOT events — never appended, hashed, projected, or rebuilt. Server-side, a D3 negative guard asserts a PUT leaves the `events` count and every projection dump unchanged (a `prefs`/`read_state` row appears, nothing else); client-side, the Dexie `read_state`/`prefs` tables are log-rebuild-EXEMPT. Semantics differ deliberately: read markers upsert **monotonically** (`GREATEST` — an out-of-order PUT cannot rewind a marker), prefs are plain **LWW** (newest write wins; no ordering over the enum). Isolation is triple-gated: own-user keying by construction (no user-id input to spoof), the shared `can_read` predicate on every read/write (unreadable/unknown stream ⇒ uniform 404, no existence oracle), and the same-user echo.
  3. **Presence + typing — ephemeral, WS-only, NEVER touches the log (§3.3; ENG-125/128).** Online/offline and typing frames live in hub memory with TTL expiry and are relayed over the WS only — nothing is appended, stored, projected, or pulled (the D3 negative guard in `test_presence_typing` asserts a full presence/typing session leaves `events` and every projection dump byte-identical). Typing is stream-membership-scoped via the shared readable predicate; presence is roster-scoped and excludes guests both ways (the ENG-125 entry above). The client mirrors are memory-only (the worker presence store; ~5s typer TTL), so a reload starts blank by design.
  4. **Search — one SQL statement, permission scope IN-QUERY (§8; ENG-122/126/127).** Server-side Postgres FTS (`websearch_to_tsquery` over the STORED GENERATED `messages_proj.search_tsv`, `ts_rank_cd`-ranked, keyset-paged by an opaque cursor) with the **one shared** `readable_streams_predicate` joined straight into the WHERE clause — never a Python post-filter — so an unreadable hit never leaves Postgres: zero private/DM leakage, guests hit only explicit-membership streams, an unreadable `in:` filter yields empty (not 404 — no existence oracle), and soft-deleted rows are excluded on top of their already-redacted `search_tsv`. Hostile query text can never 500 (`websearch_to_tsquery` never raises; an empty tsquery matches nothing). This is the ONE tab-visible read served by HTTP rather than the local projection — made worker-side, so the search UI (overlay, `in:#`/`from:@` client-resolved filters, XSS-safe `<mark>` segment highlighting, jump-to-message) still never sees the token.
  5. **Notifications are a pure CLIENT consumer — no new server surface (ENG-129).** Toasts, the tab-title unread count, and the permission-gated browser `Notification` are derived from EXISTING signals only (the streams projection's head/unread movement + the D3 prefs) through a pure `shouldNotify` matrix (own messages never; the active+visible conversation never; `mute` never; `mentions` ⇒ @me or DM; `all` ⇒ any). Opening a conversation marks it read via the D3 read-state PUT, which is what clears badges everywhere. Web Push (a server surface) is deliberately deferred.
  6. **Live `streams.head_seq` advance was a prerequisite the M3.5 gate exposed (ENG-150).** The ENG-130 Playwright notifications leg surfaced that the client sync engine advanced the cursor + projection on a live/catch-up event but left the local `streams.head_seq` stale (only `/v1/sync` responses bumped it), so live unread (`head_seq − last_read_seq`) and the head-driven notification scan never fired for WS-delivered messages. `applyForward` now bumps `head_seq = max(stored, max server_sequence)` atomically (`MsgDb.bumpStreamHead`); invariant-5/6 + projection-equivalence stayed green. Purely a client projection-freshness fix — no envelope/D-decision touched.
  7. **The §12 exit gates grew with the surface (this ticket).** The Python simulation drives real `UploadFile`/`AttachToMessage` ops and search/file adversary probes inside the standing invariants; the TS invariant-6 client-rebuild gate replays `file.uploaded` under windowed out-of-order delivery with deterministic teeth; and a fourth Playwright leg (`m35-*.spec.ts`) drives files (upload → render → byte-identical download → image thumbnail), search (token → highlighted hit → jump), presence + typing, and notifications (@mention while unfocused → in-app toast + mention badge → open-to-clear) over the real single-origin stack on the default WS backend. The OS-level `Notification` popup itself is not E2E-assertable (permission is not grantable headless); the in-app toast path is asserted and the browser-Notification branch stays unit-covered. Still deferred out of M3.5: **pins (ENG-119 fast-follow), Web Push, group DMs**, and the Ranin UI follow-ups.

- **M4 portability amendments (ENG-155/156/157/158, additive):** the portability milestone. **No envelope field and no locked D-decision changed** — export/verify/import are read/replay surfaces over the existing log + blob store. The §9 write-back above is the as-built spec; the following record the realized decisions and their security envelope, each tracked by its ticket.
  1. **Blob path mirrors the store, not the §9 sketch.** The bundle lays blobs out at `blobs/<ab>/<sha256hex>` (the on-disk `BlobStore` layout), NOT the original §9 sketch's `blobs/sha256/ab/…`. One layout for the store and every bundle means restore is a content-addressed copy with no path translation, and `verify` re-hashes a blob against its own path digest.
  2. **`bundle_digest` is an integrity SEAL, not a signature (ENG-156 security review).** It is `sha256:` over the JCS canonicalization of the manifest sans that key — it makes tampering *detectable relative to the manifest* (a flipped body byte, a reordered/truncated month file, a swapped blob), and it is what closes the deliberate no-prev-hash-chain gap within a bundle (§12 invariant-7). But because operational metadata that has no in-log source of truth — user roles/emails/`display_name`, workspace name/quota, and a stream's `archived_at` *timestamp* — is trusted from a **verified manifest**, a full reseal after editing the manifest defeats even the `verify` gate. Absolute tamper-proofing needs the operator to record `bundle_digest` out-of-band (or a future asymmetric **signature** — reserved, not built). Two surgical hardenings fold the §95 review into the restore core so the manifest cannot be trusted *beyond* what the log can cross-check: (a) the fresh-instance guard also requires an empty `invites` table (it has no FK anchoring it to the other checked tables, so a leftover invite could otherwise outlive the imported workspace); (b) the reducer-derived archive STATE (archived vs live) is cross-checked against the manifest — a resealed manifest may supply the source's `archived_at` timestamp (the reducer can only stamp `now()`) but must not silently FLIP a stream between archived and live.
  3. **The bundle contains all private content → treat it as sensitive as the database.** Export deliberately includes private channels and DMs (it is a whole-workspace admin operation) while excluding only secrets (`password_hash`/sessions/devices/invites/read-state/prefs). The artifact is therefore as sensitive as a database dump and is the operator's to protect; `import` re-credentials the owner and locks every other account behind an admin reset so a restored instance is never silently logged-into with stale credentials.
  4. **The exit gate is the single permanent M4 CI check (ENG-158).** `cli/tests/test_m4_exit_gate.py` drives a realistic workspace (owner + member + guest; public + private + DM; threads/edits/deletes/reactions/mentions; two uploads across two streams with a thumbnail and a blob shared by two messages) over the real server, then proves `export → verify → import` reconstructs it on a fresh instance byte-for-byte: projection dumps + per-stream heads equal, blobs present and re-hashing (thumbnail included), a file downloads under correct authz on B, the guest readable-stream set is not widened (invariant 4), `rebuild-projections` is a fixed point (invariant 6), a live send sequences from the restored `head_seq + 1`, and `export(B) ≡ export(A)` modulo `exported_at`/`tool`/`bundle_digest`. It **promotes and consolidates** the M4-3 e2e (the near-duplicate `test_import_e2e` was removed) so there is one milestone gate.

- **M5 plugin amendments (ENG-159/161/162/163, additive):** the plugins milestone. **No envelope field and no locked D-decision changed** — D12 (server-side only, out-of-process, webhook-shaped) is implemented as written; `bot.installed`/`bot.removed` are pre-reserved §2.2 types. The §10 write-back above is the as-built spec; the following record the realized decisions and within-milestone deviations, each tracked by its ticket.
  1. **Verb scopes + membership grants replace the per-stream token grammar (ENG-159).** The original §10 sketch scoped tokens per stream (`events:write:<stream>`, `events:read:<stream>`). As built, a token's scopes are the closed VERB vocabulary (`events:write` / `events:read` / `files:write` — a Pydantic Literal, so an unknown scope is a 422 and can never be minted) and the per-stream boundary is the bot's event-sourced channel **membership** (`channel.member_added`/`removed` emitted by `/v1/plugins`, reduced into `stream_members`, enforced by the existing §3.6 guest predicate + `can_write`). One authz mechanism instead of two: no scope-grammar parser, no second per-stream ACL to drift from membership, and revocation is the same immediate-effect membership delete every other surface already honors.
  2. **A bot is a `guest` user with the unusable-password sentinel (ENG-159).** `is_bot=true`, `role='guest'` (its readable set is exactly its explicit grants — never role-widened; the admin PATCH refuses role changes on a bot), `password_hash = UNUSABLE_PASSWORD_HASH` (the M4 import sentinel: verifies cleanly, matches nothing, so a bot can never log in), a synthetic `<user_id>@bot.invalid` email, and exactly one device (label `"bot"`) because every event body carries a validated `author_device_id`. Install scopes are recorded in the `bot.installed` meta event (the durable record; token mints default to it) — the `users` row carries no scope column.
  3. **`bot_tokens` / `incoming_webhooks` are OPERATIONAL state — excluded from export bundles (ENG-159/161).** Like `sessions`/`devices`/`invites` (§9), plugin credentials are server-operational secrets, not part of the hashed, replayable log: an exported bundle carries the bot **users** and the `bot.installed`/`bot.removed`/membership events (identity + audit trail survive a §9 round-trip) but no token or hook rows — after an import the operator re-mints tokens and re-registers hooks, exactly as humans re-credential. Raw credentials follow the invite discipline (D2): returned exactly once at mint (the token / the capability URL), only the sha256 stored, listings expose hash handles only.
  4. **The admin-PATCH `bot.removed` exception (ENG-159).** Role/deactivation changes are operational (a PATCH appends zero events — the ENG-151 rule), with ONE exception: the active→inactive TRANSITION of a **bot** bulk-deletes its `bot_tokens` in the same transaction (the bearer dies immediately, mirroring the human session bulk-revoke) and emits the server-authored `bot.removed` meta event — the client roster fold needs the removal announced exactly as `bot.installed` announced the install. Idempotent (re-deactivating emits nothing); reactivation does NOT re-emit `bot.installed` and does not resurrect tokens (re-install via `/v1/plugins` is the supported path).
  5. **Incoming webhooks build the message SERVER-side (ENG-161).** The delivery payload controls only the text bytes (`text`, or the minimal `blocks` section subset flattened to text); `author`, `stream`, `format="plain"`, `mentions=[]`, `file_ids=[]`, no-thread are hard-coded, so a delivery cannot mention, attach, thread, re-target, spoof authorship, or inject markdown. The hook writes through the same validated `store_event` pipeline as every client upload under the bot's synthesized context — revoking the bot's grant or archiving the channel cuts a live hook mid-flight — and every unusable-hook shape is the uniform 404 (rate limits per hook-hash + per client IP run before any DB work).
  6. **Outgoing subscriptions are deferred to ENG-160 (post-M5).** The §13 M5 exit criterion — GitHub PR events via the public plugin API — is fully met by the incoming path (the GitHub notifier receives GitHub's webhooks itself and forwards into a capability URL), so the outgoing half shipped no code in M5. The §10 design stands as written for ENG-160, plus the §12 invariant-8 deferred clause: delivery must be read-authz'd to the subscription bot's readable streams.
  7. **The exit gate is the single permanent M5 CI check (ENG-163).** `cli/tests/test_m5_exit_gate.py` (sibling of the M4 gate, on the same real-stack subprocess-uvicorn mechanism) provisions the bot + hook via `/v1/plugins` only, boots `plugins/github_notifier` as a real `python -m github_notifier` subprocess, replays the recorded signed `pull_request` fixtures against it, and observes the resulting bot-authored messages via the member API and a second member's live WebSocket — then proves the four invariant-8 adversary legs (tampered signature, guessed capability URL, bot token outside its grants, forged `bot.installed`) each have zero effect.

- **M6 desktop amendments (ENG-165/166/167/168/169, additive):** the desktop milestone's CI-provable core. **No envelope field and no locked D-decision changed** — the desktop client is the same Vue app + WorkerCore over new storage/fs/secret seams, and every seam has a headless Node implementation so the whole milestone substance is proven in CI. The Tauri shell itself (M6-5, ENG-170) is the remaining native layer — window, packaging, real-network airplane demo, OS keychain — which needs manual per-platform sign-off; the `m6` tag waits on it. The following record the as-built decisions, each tracked by its ticket.
  1. **Storage stays in JS; Rust is a thin host (ENG-165).** The desktop projection store is `SqliteDb implements MsgDb` (TypeScript), issuing SQL through a tiny injected `SqlDriver` interface `{execute, select, transaction}` — better-sqlite3 in Node/vitest today, rusqlite Tauri commands in the shell (M6-5). The tested WorkerCore/SyncEngine/outbox/projection/auth stack is therefore **reused verbatim, not ported to Rust** (porting would re-implement ~6.5k invariant-tested lines and double the invariant-6 surface); the existing `solo` transport (WorkerCore in-page, no worker) is what the Tauri webview runs. A parametrized MsgDb **conformance suite** runs MemoryDb + DexieDb + SqliteDb through one behavioral contract, and `PROJECTION_VERSION`/`rebuildProjections` govern SQLite exactly as they do Dexie — invariant 6 by construction. FTS5 (`messages_fts`, external-content) is maintained inside `SqliteDb.putMessages`/`deleteMessage`, so all writers keep the index consistent with no trigger drift.
  2. **The on-disk target is the M0/ENG-70 LIVE workspace format, verified in live mode — not a sealed §9 bundle (ENG-167).** The desktop folder is `workspace.json` + `streams/<stream_id>/<YYYY-MM>.ndjson` (+ `blobs/<ab>/<hex>` and a root `projections.sqlite3`, which live-mode `verify` deliberately ignores per ENG-58) — the same layout `msgctl sync pull` writes, with the same disciplines: registration-before-write, month split by `server_received_at[:7]`, crash-safe log-derived resume, torn-tail truncation on open. Live mode exists precisely for continuously-appended folders; a sealed §9 manifest re-digests every event on every append, so "folder passes `msgctl verify`" (§13) means **live-mode** verify. Rule of thumb as built: **NDJSON + blobs are the durable truth; SQLite is a rebuildable projection** (`rebuildFromDisk` drops and repopulates it from the log, re-verifying every `event_hash` fail-closed). Sealed-bundle export from the desktop stays a post-M6 nicety.
  3. **The session token lives in the `SecretStore` seam, never in the folder (ENG-168).** Web: `MetaSecretStore` delegates to the same Dexie `meta` rows the token always lived in — origin-scoped browser storage, byte-for-byte unchanged behavior. Desktop: an injected platform store (OS keychain in the Tauri shell, M6-5; in-memory in headless tests). As a fail-closed second line of defense, `SqliteDb.metaPut` refuses `META_SESSION_TOKEN` outright, so the token cannot reach the portable folder even through a mis-wired call. `META_DEVICE_ID` is deliberately **not** a secret: it is a non-secret install identity (cosmetic, shown in the sessions list) that stays in the MsgDb `meta` table, where the outbox and the workspace-mirror identity read it — there is no "device secret" in this protocol.
  4. **NDJSON byte-parity with the Python serializer holds on the served-event domain (ENG-167).** The TS `eventNdjsonLine` mirrors the server's NDJSON export serialization byte-for-byte against shared cross-language vectors, with one documented domain caveat: doubles of extreme magnitude (≥1e16 or <1e-6) format differently in JS vs Python (`10000000000000000` vs `1e+16`); such values never appear in served event bodies, and `event_hash` is JCS-canonicalized on both sides regardless, so `msgctl verify` is unaffected either way.
  5. **Desktop local search ranks bm25-first; the server ranks recency-first (ENG-166).** Routing is capability-gated in the worker: `db.capabilities.fts` → `searchLocalMessages` over FTS5 (zero network); otherwise the server HTTP path (web unchanged). The `SearchResult` wire shape, the query grammar (`in:`/`from:`/`before:`/`after:`), the deleted-row exclusion, and the read-scope are identical on both paths — but the local total order is `bm25` best-first with `created_seq DESC` tie-break, while the server's page order is `created_seq DESC, message_id DESC` (rank computed and returned but not ordered by — the ENG-122 float-keyset decision). A deliberate, documented divergence: same contract, different ranking.
  6. **The exit gate is the single permanent M6 CI check (ENG-169).** `test_m6_exit_gate` (`web/tests/integration/m6-exit-gate.spec.ts`, run both inside `pnpm test` and as its own named CI step) **promotes and consolidates** the M6-3 workspace-mirror gate and the M6-4 offline gate — their spec files were removed — so there is one milestone gate, on the M4/M5 pattern. One headless flow drives the real WorkerCore+SyncEngine in full-mirror mode (SqliteDb + Node-fs seams + SecretStore) against a seeded fake server into a temp dir, then asserts: (1) the real `msgctl verify --json` exits 0 with zero failures, plus NDJSON ≡ events-table byte-equality; (2) fully offline, every `query` verb answers from SQLite, `search` answers from local FTS5 with zero `/v1/search`, a send queues, `readState.mark` advances locally, and server-required verbs return the coded `offline` error; (3) on reconnect the outbox drains, the event appends to the NDJSON log, the read marker re-pushes, and the folder still verifies exit 0; (4) rebuild-from-disk ≡ incremental (`dumpMessages`/`dumpFiles` byte-equal), with tampered logs failing closed; (5) the folder (including the raw `projections.sqlite3` bytes) contains no session token, byte-scanned against a positive control — plus the crash-resume and torn-tail durability teeth, each re-proving verify exit 0. It self-skips where `uv` is absent locally but **hard-fails under CI**, so the gate can never silently vanish from the pipeline.
