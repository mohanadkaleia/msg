// worker/types.ts — the transport-agnostic contract (ENG-77).
//
// Pure types + consts + a couple of pure helpers, no platform globals and no
// runtime dependencies, so this module is importable from BOTH the tab side
// (stores, ENG-82) and the worker side (SharedWorker / leader). Everything on
// the wire is plain, structured-clone-safe data.

import type { ApiError } from './http'

// ---------------------------------------------------------------------------
// Versioning + bounds
// ---------------------------------------------------------------------------

/**
 * App-level version guarding the *derived* tables (`messages`, `reactions`,
 * `thread_participants`, `files`, `streams`, `cursors`). Bumping it forces a
 * rebuild of the derived tables from the raw `events` cache; it does NOT touch
 * the IndexedDB index layout (that is the Dexie `version()` number in `db.ts`).
 * See TDD §5.2, D-4.
 *
 * ENG-126, D3 (message-class rationale): `read_state` and `prefs` are SYNCED-KV
 * tables — server-authoritative per-user state pulled from `/v1/read-state` and
 * `/v1/prefs`, NOT derivable from the message `events` log. They are therefore
 * REBUILD-EXEMPT (absent from {@link DERIVED_TABLES} / `clearDerivedTables`): a
 * projection-version bump must never wipe them, or the badges would silently
 * un-read on a shape-skew boot until the next sync. Contrast ephemeral
 * presence/typing, which are memory-only and never persisted at all. The two
 * version numbers stay orthogonal: adding the `prefs` Dexie table is an
 * additive `version(4)` INDEX-layout change and must NOT bump this
 * PROJECTION-VALIDITY number (an accidental bump needlessly drops + rebuilds
 * every derived table on all clients).
 */
// ENG-81 bumped 1 → 2: `MessageRow` gained the `state`/`error_code` lifecycle
// fields and rebuild now re-derives pending rows from `outbox`, so shape-change
// clients rebuild the derived tables on boot.
// ENG-100 bumped 2 → 3 (M3 client projections): `MessageRow` gained the
// `edited_seq` / `deleted` / `reply_count` / `last_reply_seq` columns, and the
// derived set gained the `reactions` + `thread_participants` tables. Mirroring
// the server (its `PROJECTION_VERSION` is 4 after ENG-97/98/99), a shape/handler
// change bumps this so shape-skew clients drop + rebuild the derived tables from
// the raw `events` cache (+ re-derive pending overlay from `outbox`) on boot.
// ENG-100 bumped 3 → 4 (out-of-order fix): the `reactions` row shape changed from
// a bare membership to seq-aware LWW (`last_event_seq` + `present`, keeping
// tombstone rows) so reactions converge under the client's out-of-order
// (cold-window + backfill) delivery. A row-shape change → drop + rebuild reactions
// from `events` on boot (no Dexie index change — the new fields are unindexed).
// ENG-120 bumped 4 → 5 (client `file.uploaded` projection): the derived set gained
// the `files` table (a keyed upsert mirror of `file.uploaded`, keyed by `file_id`)
// and `MessageRow` gained the client-only `file_ids` display column (projected from
// the `message.created` body). A shape/derived-set change bumps this so existing
// clients drop + rebuild the derived tables from the raw `events` cache on boot —
// which is what populates the new `files` table + backfills `MessageRow.file_ids`.
// ENG-152 bumped 5 → 6 (Files view): `FileRow` gained the `uploaded_by` +
// `created_at` display columns (both deterministic reads of the `file.uploaded`
// body — `author_user_id` / `client_created_at`), so shape-skew clients drop +
// rebuild the derived tables from the raw `events` cache on boot, repopulating
// every `files` row with the new fields.
export const PROJECTION_VERSION = 6

/** `meta` key under which the current `PROJECTION_VERSION` is stored. */
export const META_PROJECTION_VERSION = 'projection_version'

// ---------------------------------------------------------------------------
// Session meta keys (ENG-78, §7). The SharedWorker owns the token; these rows
// persist the session across reloads (R1). `META_DEVICE_ID` survives logout —
// it is browser-install identity, not session state (R3). No tab ever reads
// `META_SESSION_TOKEN`; it is used only worker-side (Authorization / WS bearer).
// ---------------------------------------------------------------------------

/** Raw bearer token — worker-only; NEVER returned to a tab (R1). */
export const META_SESSION_TOKEN = 'session_token'
/** Per-browser-install device identity; reused on re-login, kept across logout. */
export const META_DEVICE_ID = 'device_id'
/** Cached identity of the signed-in user. */
export const META_MY_USER_ID = 'my_user_id'
/** Cached workspace of the signed-in user. */
export const META_WORKSPACE_ID = 'workspace_id'
/** Cached role of the signed-in user. */
export const META_ROLE = 'role'
/** Rolling session expiry (RFC 3339 string). */
export const META_SESSION_EXPIRES_AT = 'session_expires_at'
/**
 * Optional multi-server base URL. Reserved for a future client; omitted in M2
 * (the SPA is served same-origin, so relative `/v1` paths are used). Do not set.
 */
export const META_SERVER_URL = 'server_url'

/** Bounded cache: newest ~N events kept per stream; older pages re-fetched. */
export const MAX_CACHED_EVENTS_PER_STREAM = 2000

// ---------------------------------------------------------------------------
// Dexie row shapes (§5.2). Only a subset of these fields is indexed (see the
// `.stores()` strings in db.ts); the rest are enforced by strict typing here.
// ---------------------------------------------------------------------------

/**
 * The §2.1 hashed body inside a stored envelope. ENG-80's projection apply reads
 * `type_version`, `author_user_id` and `payload` from here (the rest is opaque to
 * the projection). Kept structurally loose (`unknown` payload, open index) so the
 * apply validates it defensively at runtime rather than trusting the shape, and
 * so ENG-79 can read `stream_id`/`event_id` off the same body.
 */
export interface EventBody {
  type: string
  type_version: number
  author_user_id: string
  payload: unknown
  [key: string]: unknown
}

/**
 * Unhashed server metadata carried alongside each event (ENG-79 delivery path).
 * Inner fields are optional + open so ENG-80's fixtures (which omit
 * `payload_redacted`) and ENG-79's full wire events both satisfy it.
 */
export interface EventServerMeta {
  server_sequence: number
  server_received_at?: string
  payload_redacted?: boolean
  [key: string]: unknown
}

/**
 * The full stored envelope ENG-79 caches under each {@link EventRow} — the §3.2
 * wire form (`body`, `event_hash`) plus server-added `signature`/`server`
 * metadata. ENG-80 reads ONLY `body`; `event_hash`/`signature`/`server` are
 * opaque to the projection. Wire == stored (raw-hash discipline), so
 * {@link StoredEvent} and {@link WireEvent} are aliases of this.
 */
export interface StoredEnvelope {
  body: EventBody
  event_hash?: string
  signature?: string | null
  server?: EventServerMeta
}
export type StoredEvent = StoredEnvelope
export type WireEvent = StoredEnvelope

/**
 * Raw event envelope — the evictable source cache. ENG-79 writes these rows with
 * the envelope populated (verbatim, hash-verified) before calling
 * `applyEventsToProjection`. Top-level `stream_id`/`server_sequence`/`event_id`/
 * `type` are DENORMALIZED off the envelope purely so the Dexie index
 * (`[stream_id+server_sequence]`, `event_id`, `type`) can key + range-scan; ENG-80
 * reads `type_version`/`author_user_id`/`payload` from `envelope.body`.
 */
export interface EventRow {
  stream_id: string
  server_sequence: number
  event_id: string
  type: string
  /**
   * The full verified wire envelope, stored byte-for-byte (raw-hash discipline).
   * ENG-79's write path always populates it; kept optional so ENG-77 skeleton
   * rows type-check and ENG-80's projection degrades to a skip (never a crash) on
   * a body-less row.
   */
  envelope?: StoredEnvelope
}

/**
 * Projected message row (derived) — explicit typed columns (never an opaque
 * blob) so the deterministic dump has a fixed field order and badges can read
 * `mention_user_ids`. `mention_user_ids` is stored VERBATIM from
 * `payload.mentions` (user-independent); the red/no-red badge is a query-time
 * derivation in `badges.ts`, not stored here. Only `message_id`, `stream_id`,
 * `[stream_id+created_seq]` and `thread_root_id` are indexed (db.ts `.stores()`).
 */
export interface MessageRow {
  message_id: string
  stream_id: string
  created_seq: number
  author_user_id: string
  text: string
  format: 'markdown' | 'plain'
  thread_root_id?: string
  mention_user_ids: string[]
  /**
   * The attachment linkage (ENG-120) — the `file_id`s this message references,
   * projected VERBATIM from the `message.created` body's `file_ids` (default `[]`
   * when absent/invalid). This is a CLIENT-ONLY display field: it is a pure,
   * deterministic function of the single `message.created` event (no cross-event
   * accumulation), so it is trivially order-independent and rebuild ≡ incremental
   * holds. It is DELIBERATELY EXCLUDED from `dumpMessages` — the ENG-83
   * cross-language byte-equality surface — because the SERVER has no
   * message→attachment projection (ENG-117: `messages_proj` is search-only, no
   * `file_ids`), so the frozen server dump has no such field. The `attachments.
   * forMessage` query resolves these ids against the `files` table (see FileRow).
   */
  file_ids: string[]
  /**
   * LWW edit stamp (ENG-100, M3). ABSENT = never edited. When present it is the
   * `server_sequence` of the winning `message.edited` event; a later edit applies
   * only if its `server_sequence > coalesce(edited_seq, created_seq)` AND the row
   * is not `deleted` (mirrors the server LWW guard). Unlike the server — which
   * drops `format` — the CLIENT also updates `text`/`format` on edit (§ the payload
   * carries format), so client + server converge on text/edited_seq and the client
   * additionally tracks format.
   */
  edited_seq?: number
  /**
   * Tombstone flag (ENG-100, M3). `true` once a `message.deleted` for this message
   * is applied. Terminal: a later `message.edited` (any order) is guarded off, so
   * it never un-deletes. On delete the projected `text` is REDACTED to `''` (the
   * client must not store or render deleted content); the raw event survives in the
   * `events` cache (event-sourcing reality — that is the ENG-111 redaction follow-up).
   */
  deleted?: boolean
  /**
   * Thread reply counter (ENG-100, M3) — only meaningful on a thread ROOT. The
   * count of NON-DELETED, SETTLED replies whose `thread_root_id` is this message.
   * RECOMPUTED-from-state (delete-aware) on every reply create/delete, so it is a
   * pure function of the `messages` table and rebuild ≡ incremental holds.
   */
  reply_count?: number
  /** Max `created_seq` among this root's non-deleted settled replies (null when none). */
  last_reply_seq?: number
  /**
   * Optimistic-send lifecycle marker (ENG-81). ABSENT = settled/normal (the
   * steady state). `'pending'` = local send not yet acked (`created_seq` is the
   * `created_at` sentinel, greyed/provisional tab-side). `'failed'` = the server
   * rejected it (`error_code` set). Never serialized by `dumpMessages` (§5) — it
   * is a re-derivable function of the `outbox` row, so rebuild ≡ incremental.
   */
  state?: 'pending' | 'failed'
  /** Rejection code (ENG-66) when `state === 'failed'`. */
  error_code?: string
}

/**
 * Reaction row (ENG-100, M3) — the client mirror of the server `reactions_proj`,
 * made SEQ-AWARE (LWW) so it converges under the client's OUT-OF-ORDER delivery
 * (cold-window + backfill; a lower-seq event can arrive after a higher-seq one).
 *
 * One row per key `(message_id, author_user_id, emoji)`, carrying the LAST-event
 * `server_sequence` and its disposition `present` (add ⇒ true, remove ⇒ false —
 * a TOMBSTONE row, kept so a late LOWER-seq add cannot resurrect a removed
 * reaction). A reaction is OBSERVABLE iff its highest-seq event is an add
 * (`present === true`); counts / who-reacted / the dump derive from `present`
 * rows only. This "present iff highest-seq event is add" is order-independent, so
 * client rebuild ≡ incremental under any delivery order AND matches the server's
 * in-order final state. `author_user_id` is the reactor (envelope, not payload);
 * `emoji` is OPAQUE bytes — an exact-match key, no grapheme normalization.
 * Derived table: dropped + rebuilt from `events` on a version bump.
 */
export interface ReactionRow {
  message_id: string
  author_user_id: string
  emoji: string
  /** `server_sequence` of the highest-seq reaction event applied for this key (LWW stamp). */
  last_event_seq: number
  /** Disposition of that event: `true` = added (observable), `false` = removed (tombstone). */
  present: boolean
}

/**
 * Thread-participant row (ENG-100, M3) — the client mirror of the server
 * `thread_participants_proj` SET. One row per `(root_message_id, user_id)`, the
 * DISTINCT authors of a root's non-deleted settled replies. Fully RECOMPUTED for
 * a root whenever its reply set changes (delete-aware), so it is a pure function
 * of the `messages` table. Derived table.
 */
export interface ThreadParticipantRow {
  root_message_id: string
  user_id: string
}

/**
 * Projected file row (ENG-120) — the client mirror of a `file.uploaded` v1 event,
 * so the UI can render a message's attachments (name / mime / size) from the LOCAL
 * projection instead of a network read.
 *
 * One row per `file_id` (the PK). Unlike the ENG-100 stateful projections
 * (reactions/threads/edits), a file is uploaded EXACTLY ONCE and its
 * `file.uploaded` event is IMMUTABLE, so this is a plain IDEMPOTENT KEYED UPSERT:
 * a re-delivery is byte-identical, and whether the event arrives before or after
 * its referencing `message.created` does not matter (the row is keyed by
 * `file_id`; the attachments query reads whatever has projected). Order-
 * independence therefore comes FOR FREE — no seq-aware LWW / recompute is needed
 * (contrast the reactions/threads handlers). Derived table: dropped + rebuilt from
 * `events` on a version bump.
 *
 * The five payload fields (`sha256`/`name`/`mime_type`/`size_bytes` + `file_id`)
 * come from the `file.uploaded` body; `stream_id` is read from the event ENVELOPE
 * (`event.stream_id`), NOT the payload (the payload carries no stream_id). No
 * server `thumbnail_sha256` is stored — the client cannot know it; the UI derives
 * "attempt a thumbnail" from `mime_type` starting with `image/` and fetches it
 * lazily via `file.fetch{variant:'thumbnail'}` (ENG-119), which 404s when absent.
 */
export interface FileRow {
  file_id: string
  sha256: string
  name: string
  mime_type: string
  size_bytes: number
  /** The stream the file was uploaded into — from the event envelope, not the payload. */
  stream_id: string
  /** The uploader (`body.author_user_id`) — resolved to a display name tab-side. */
  uploaded_by: string
  /** The client-claimed upload instant (`body.client_created_at`, ISO 8601). A
   *  DISPLAY/sort field only — it is the uploader's clock, not server truth. */
  created_at: string
}

/** Projected stream row (derived). */
export interface StreamRow {
  stream_id: string
  kind: string
  name?: string
  visibility?: string
  head_seq: number
  member: boolean
  /** `true` iff an archived channel (ENG-104): gates writes/UI, stays readable (D13). */
  archived?: boolean
}

/** Per-stream cursor row (derived echo of pull progress). */
export interface CursorRow {
  stream_id: string
  last_contiguous_seq: number
  oldest_loaded_seq: number
}

/**
 * Pending local send (ENG-81). Source-of-truth-ish: never derived, never
 * evicted, never touched by `clearDerivedTables`/`evictStream`. Minted in the
 * worker at send with the event's hashed `body` + `event_hash`, so the drain
 * re-POSTs `{body, event_hash}` with zero rework and the row re-derives the
 * pending projection row on rebuild.
 */
export interface OutboxRow {
  /** Bare ULID (`body.event_id`) — PK here, UNIQUE server-side (dumb-retry key). */
  event_id: string
  /** ms epoch minted at send: oldest-first drain key AND the pending `created_seq`. */
  created_at: number
  /** The §2.1 hashed body, verbatim — the exact bytes `event_hash` was computed over. */
  body: Record<string, unknown>
  /** `sha256:…` over JCS(`body`), computed once at send. */
  event_hash: string
  /** Denormalized `body.payload.message_id` — links this row to its projection row. */
  message_id: string
  /** Denormalized `body.stream_id` — publish + settle target. */
  stream_id: string
  /** queued=to send; sending=in-flight (crash-recover as queued); rejected=parked. */
  state: 'queued' | 'sending' | 'rejected'
  /** Rejection code (ENG-66) when `state === 'rejected'` (surfaced as `failed`). */
  error_code?: string
}

/**
 * Local mirror of the server read-state KV (ENG-123). SYNCED-KV, not derived:
 * pulled from `GET /v1/read-state`, kept monotonic (server GREATEST) locally,
 * and REBUILD-EXEMPT (see {@link PROJECTION_VERSION} D3 — a projection rebuild
 * must not wipe it).
 */
export interface ReadStateRow {
  stream_id: string
  last_read_seq: number
}

/** Per-channel notification level (ENG-124), LWW. Default `all` when absent. */
export type PrefLevel = 'all' | 'mentions' | 'mute'

/**
 * Local mirror of the server notification-prefs KV (ENG-124). SYNCED-KV, LWW:
 * pulled from `GET /v1/prefs`, replaced unconditionally on echo/PUT-result, and
 * REBUILD-EXEMPT (see {@link PROJECTION_VERSION} D3). Its own additive Dexie
 * `version(4)` table — an INDEX-layout change that MUST NOT bump PROJECTION_VERSION.
 */
export interface PrefsRow {
  stream_id: string
  level: PrefLevel
}

/** Generic key/value meta row (source): projection_version, my_user_id, … */
export interface MetaRow {
  key: string
  value: unknown
}

/**
 * The tables of the §5.2 schema (+ ENG-100's `reactions` / `thread_participants`
 * and ENG-120's `files`).
 */
export type TableName =
  | 'events'
  | 'messages'
  | 'reactions'
  | 'thread_participants'
  | 'files'
  | 'streams'
  | 'cursors'
  | 'outbox'
  | 'read_state'
  | 'prefs'
  | 'meta'

/**
 * Derived tables — safe to drop + rebuild from `events` + server pulls.
 *
 * ENG-126: `read_state` was WRONGLY listed here — it is a SYNCED-KV table (from
 * `/v1/read-state`, not the message log), so a projection-version bump used to
 * wipe it (harmless only while empty). It is now REBUILD-EXEMPT, alongside the
 * new `prefs` synced-KV table (which is likewise NOT added here). See
 * {@link PROJECTION_VERSION} D3.
 */
export const DERIVED_TABLES = [
  'messages',
  'reactions',
  'thread_participants',
  'files',
  'streams',
  'cursors',
] as const
export type DerivedTable = (typeof DERIVED_TABLES)[number]

// ---------------------------------------------------------------------------
// MsgDb — the structural DB surface WorkerCore depends on (D-3, D-4). Two
// implementations in db.ts: DexieDb (real/fake IndexedDB) and MemoryDb (Map).
// The interface is intentionally small now; ENG-79/80/81 grow it.
// ---------------------------------------------------------------------------

export interface MsgDb {
  /** Whether writes survive a reload. `memory` = private-browsing fallback. */
  readonly persistence: 'persistent' | 'memory'

  // meta
  metaGet<T = unknown>(key: string): Promise<T | undefined>
  metaPut(key: string, value: unknown): Promise<void>

  // events (source cache; evictable)
  putEvents(rows: readonly EventRow[]): Promise<void>
  /** Server sequences for a stream, ascending. */
  listEventSequences(streamId: string): Promise<number[]>
  deleteEventsBySequence(streamId: string, sequences: readonly number[]): Promise<void>
  /** Smallest server_sequence stored for a stream (backfill floor), or undefined. */
  minStoredSeq(streamId: string): Promise<number | undefined>

  // derived reads (ENG-79 bootstrap diff + cursor re-derivation).
  // NOTE: `listStreams`/`getStream` are declared once in the ENG-80 block below.
  getCursor(streamId: string): Promise<CursorRow | undefined>
  /** All cursor rows — boot-time re-derivation / diff. */
  listCursors(): Promise<CursorRow[]>

  // outbox (source; never evicted, never dropped)
  putOutbox(rows: readonly OutboxRow[]): Promise<void>
  listOutbox(): Promise<OutboxRow[]>
  /** A single outbox row by `event_id` (retry/delete/settle lookup). */
  getOutbox(eventId: string): Promise<OutboxRow | undefined>
  /** Remove a settled/deleted outbox row by `event_id`. */
  deleteOutbox(eventId: string): Promise<void>
  /** Whether an event with this `event_id` is already stored (rebuild settle guard). */
  hasEvent(eventId: string): Promise<boolean>

  // derived tables (seeding here doubles as the ENG-80 rebuild write surface)
  putMessages(rows: readonly MessageRow[]): Promise<void>
  /** Remove a projected message by id (outbox.delete of an unsettled row). */
  deleteMessage(messageId: string): Promise<void>
  // -- ENG-100 reactions (seq-aware LWW; mirror of `reactions_proj`) ---------
  /** Upsert reaction rows by their `(message_id, author_user_id, emoji)` key. */
  putReactions(rows: readonly ReactionRow[]): Promise<void>
  /** The single reaction row for a key (the LWW seq/disposition), or undefined. */
  getReaction(
    messageId: string,
    authorUserId: string,
    emoji: string,
  ): Promise<ReactionRow | undefined>
  /** The OBSERVABLE (`present === true`) reactions for a message (counts / who-reacted). */
  getReactionsForMessage(messageId: string): Promise<ReactionRow[]>
  /** Delete every reaction row (present + tombstone) for a message (revert wipe). */
  deleteReactionsForMessage(messageId: string): Promise<void>
  /** Every reaction row incl. tombstones — the dump source (dump filters `present`). */
  getAllReactions(): Promise<ReactionRow[]>
  // -- ENG-100 thread participants (derived set; recompute-from-state) -------
  /** Replace a root's participant set (delete-all-then-insert recompute). */
  putThreadParticipants(rows: readonly ThreadParticipantRow[]): Promise<void>
  /** Drop every participant row for a root (first half of the recompute). */
  deleteThreadParticipantsForRoot(rootMessageId: string): Promise<void>
  /** Every thread-participant row — the participants dump source. */
  getAllThreadParticipants(): Promise<ThreadParticipantRow[]>
  /** A single root's participant rows (by `root_message_id` index) — thread reads. */
  listThreadParticipantsByRoot(rootMessageId: string): Promise<ThreadParticipantRow[]>
  /** A root's replies (by `thread_root_id` index) — the recompute input. */
  listRepliesByRoot(rootMessageId: string): Promise<MessageRow[]>
  // -- ENG-120 files (keyed upsert; mirror of `file.uploaded`) ---------------
  /** Upsert file rows by their `file_id` PK (idempotent — a re-apply is a no-op). */
  putFiles(rows: readonly FileRow[]): Promise<void>
  /** A single projected file by `file_id`, or undefined if not yet projected. */
  getFile(fileId: string): Promise<FileRow | undefined>
  /** The projected file rows for a set of ids (present only; missing ids omitted). */
  getFilesByIds(fileIds: readonly string[]): Promise<FileRow[]>
  /** Every projected file row — the `dumpFiles` source (sorted in JS). */
  getAllFiles(): Promise<FileRow[]>
  putStreams(rows: readonly StreamRow[]): Promise<void>
  /**
   * ENG-150: atomic GREATEST compare-and-set for a stream's `head_seq` — read
   * the stored row, write `seq` ONLY when it strictly exceeds the stored head,
   * all inside ONE transaction (mirrors {@link upsertReadStateMonotonic}).
   * `applyForward` calls this so live WS frames AND catch-up pull pages advance
   * `head_seq` (previously only a `/v1/sync` `putStreams` set it, so live
   * unread badges / notifications never fired). `server_sequence` is server
   * truth on hash-verified events, and the server head is monotonic, so moving
   * head UP to the max applied seq is always correct; it NEVER moves down. A
   * missing stream row is a no-op returning `false` — the row is authored by
   * `/v1/sync` (`putStreams`), never fabricated here (kind/member unknown).
   * Returns whether it wrote (advanced).
   */
  bumpStreamHead(streamId: string, seq: number): Promise<boolean>
  putCursors(rows: readonly CursorRow[]): Promise<void>
  putReadState(rows: readonly ReadStateRow[]): Promise<void>
  /**
   * ENG-126: atomic GREATEST compare-and-set for a read marker — read the stored
   * `last_read_seq`, write `seq` ONLY when it strictly exceeds it, all inside ONE
   * transaction so two concurrent chains (an RPC `mark` and a WS `applyEcho`) can
   * never both read a stale value and let the LAST-WRITE (by order) clobber a
   * HIGHER value. Returns whether it wrote (advanced). Idempotent + monotonic.
   */
  upsertReadStateMonotonic(streamId: string, seq: number): Promise<boolean>
  // -- ENG-126 prefs (synced-KV; mirror of `/v1/prefs`; NOT a derived table) -
  /** LWW upsert of notification-pref rows by their `stream_id` PK. */
  putPrefs(rows: readonly PrefsRow[]): Promise<void>
  /** All notification-pref rows (the prefs snapshot). */
  listPrefs(): Promise<PrefsRow[]>
  /** A single stream's notification pref, or undefined (caller defaults `all`). */
  getPrefs(streamId: string): Promise<PrefsRow | undefined>
  /**
   * Drop every DERIVED table (rebuild-only wipe). ENG-126: this does NOT clear the
   * synced-KV `read_state`/`prefs` tables — a projection-version rebuild must keep
   * them (they are refilled from the server, not replay). Use {@link clearSyncedKv}
   * for the logout wipe.
   */
  clearDerivedTables(): Promise<void>
  /**
   * ENG-126: wipe the synced-KV tables (`read_state` + `prefs`). SEPARATE from
   * {@link clearDerivedTables} on purpose — logout does a FULL local reset (derived
   * + synced-KV) so a shared machine leaks nothing to the next user, whereas a
   * projection rebuild wipes ONLY derived tables and PRESERVES synced-KV.
   */
  clearSyncedKv(): Promise<void>

  // -- ENG-80 projection reads (additive; no schema change) ----------------
  // Rebuild inputs (from the `events` source cache):
  /** Distinct `stream_id`s present in `events` — the rebuild's stream set. */
  listStreamIds(): Promise<string[]>
  /** Full event rows for a stream, ascending `server_sequence` (rebuild replay). */
  getEventsForStream(streamId: string): Promise<EventRow[]>
  // Projection queries (from `messages`):
  /** A single projected message by id (`message.get`). */
  getMessage(messageId: string): Promise<MessageRow | undefined>
  /** A stream's messages, DESC `created_seq`, older than `beforeSeq`, capped. */
  listMessagesByStream(
    streamId: string,
    opts: { beforeSeq?: number; limit: number },
  ): Promise<MessageRow[]>
  /** Every projected message — the `dumpMessages` source (sorted in JS). */
  getAllMessages(): Promise<MessageRow[]>
  // Sidebar + badges (from `streams`/`read_state`/`messages`):
  /** All stream rows (sidebar). */
  listStreams(): Promise<StreamRow[]>
  /** A single stream row (single-badge). */
  getStream(streamId: string): Promise<StreamRow | undefined>
  /** All read-state rows. */
  listReadState(): Promise<ReadStateRow[]>
  /** A single read-state row (single-badge). */
  getReadState(streamId: string): Promise<ReadStateRow | undefined>
  /** A stream's messages with `created_seq > afterSeq`, ASC (mention scan). */
  listStreamMessagesAfter(streamId: string, afterSeq: number): Promise<MessageRow[]>

  /** Row count for any table — used by plumbing + assertions. */
  count(table: TableName): Promise<number>

  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// RPC taxonomy (D-7). Four verbs (query / mutate / subscribe / event-push)
// plus control frames. `RpcMethod`, `QueryParams`, `MutateParams` and `Topic`
// are the extension points — ENG-79/80/81 add union members + register a
// handler on WorkerCore; the transports never change.
// ---------------------------------------------------------------------------

/**
 * Read taxonomy (ENG-80) — the projection query surface tabs/ENG-82 read
 * (never the HTTP API for message data). Discriminated on `q`:
 *   • `messages.list` — a stream's messages, newest-first, paginated by
 *     `created_seq` (older pages via `before_seq`).
 *   • `streams.list`  — the sidebar: streams joined with unread/mention badges.
 *   • `message.get`   — a single message by id.
 */
export type QueryParams =
  | { q: 'messages.list'; stream_id: string; before_seq?: number; limit?: number }
  | { q: 'streams.list' }
  | { q: 'message.get'; message_id: string }
  // ENG-101: the @mention / #channel autocomplete source. Users are folded from
  // the cached `workspace-meta` events, channels from the `streams` projection —
  // a LOCAL read (zero network, never the HTTP API), same discipline as the rest
  // of the query surface.
  | { q: 'directory.list' }
  // ENG-102: the reaction chips for a set of messages (the M3 message-list UI reads
  // this to render aggregated emoji + count + who-reacted). A LOCAL projection read
  // over the seq-aware `reactions` table (present-only), keyed on `message_id` —
  // the client only holds readable data, so no extra scoping. `emoji` is OPAQUE
  // bytes rendered ONLY via Vue text interpolation tab-side (never a raw sink).
  | { q: 'messages.reactions'; message_ids: string[] }
  // ENG-103 (M3 thread pane, D7 flat-channel threads): the thread reads.
  //   • `messages.thread`  — a single root's REPLIES (messages whose
  //     `thread_root_id` is the root), newest-first + paginated by `created_seq`
  //     (older pages via `before_seq`), plus the root row and its participant set.
  //     The thread pane reads this. A LOCAL projection read (zero network) — the
  //     client only holds readable data, so no extra scoping.
  //   • `messages.threads` — batch thread summaries (`reply_count` + participants)
  //     for a set of roots, so the main message list renders the reply-count +
  //     participant-avatar affordance. Mirrors `messages.reactions`. Participant
  //     display names are resolved from the shared workspace directory; the tab
  //     renders them ONLY via Vue text interpolation (never a raw-HTML sink).
  | { q: 'messages.thread'; root_message_id: string; before_seq?: number; limit?: number }
  | { q: 'messages.threads'; root_message_ids: string[] }
  // ENG-120: a message's ATTACHMENTS — the resolved `FileRow`s for the message's
  // `file_ids`, read from the local `files` projection (the `file.uploaded` mirror).
  // Ids not yet projected come back in `pending_file_ids` (the blob's `file.uploaded`
  // has not landed / been backfilled). A pure LOCAL projection read (zero network) —
  // the client only holds data it is authorized for. ENG-121 (the attachment UI)
  // pairs each returned FileRow with a download/thumbnail handle via `client.files.*`.
  | { q: 'attachments.forMessage'; message_id: string }
  // ENG-152: the workspace Files view — ALL projected `FileRow`s, newest-first.
  // A pure LOCAL projection read (zero network): the `files` table mirrors the
  // `file.uploaded` events the server's sync ALREADY scoped to the caller's
  // readable streams (`readable_streams_predicate`), so no extra authz is needed;
  // a defensive query-time filter additionally drops rows whose local stream row
  // is not readable-shaped (not a member / not a public channel).
  | { q: 'files.list' }

/**
 * Mutation taxonomy (ENG-81) — durable mutations carried on the existing
 * `mutate` verb (D-7), discriminated on `m`. No new RPC methods / transport
 * surface: tabs call `client.mutate({ m: 'outbox.send', … })`.
 *   • `outbox.send`   — build + hash a `message.created` v1 event in the worker,
 *     insert a pending `messages` row (renders instantly) + an `outbox` row,
 *     kick the drain. Returns {@link SendResult}.
 *   • `outbox.retry`  — re-queue a `rejected` send (clear the failed marker).
 *   • `outbox.delete` — drop a queued/failed send + its unsettled projection row.
 */
export type MutateParams =
  | {
      m: 'outbox.send'
      stream_id: string
      text: string
      format?: 'markdown' | 'plain'
      thread_root_id?: string
      mentions?: string[]
      file_ids?: string[]
    }
  // ENG-100 (M3) optimistic ops — routed through the SAME outbox as `outbox.send`
  // (build+hash in worker, client-minted event_id, pending overlay applied
  // instantly, settle-on-ack / park-on-reject under the hash-bound stream_id):
  //   • `outbox.react`   — add/remove a reaction membership on a message.
  //   • `outbox.edit`    — replace a message's text/format (LWW on settle).
  //   • `outbox.remove`  — delete (tombstone + redact) a message.
  | {
      m: 'outbox.react'
      stream_id: string
      message_id: string
      emoji: string
      /** `true` → `reaction.removed`; default/false → `reaction.added`. */
      remove?: boolean
    }
  | {
      m: 'outbox.edit'
      stream_id: string
      message_id: string
      text: string
      format?: 'markdown' | 'plain'
    }
  | { m: 'outbox.remove'; stream_id: string; message_id: string }
  | { m: 'outbox.retry'; event_id: string }
  | { m: 'outbox.delete'; event_id: string }
  // ENG-104 (M3) channel & member management + DM creation. These author
  // workspace-meta events (channel.created/renamed/archived, channel.member_*,
  // dm.created) worker-side: build+hash the body from the worker-owned identity,
  // POST /v1/events/batch, then refresh /v1/sync so the new/changed stream lands
  // in the sidebar. `channel.create` / `dm.create` return the new stream id.
  | { m: 'channel.create'; name: string; visibility: 'public' | 'private' }
  | { m: 'channel.rename'; stream_id: string; name: string }
  | { m: 'channel.archive'; stream_id: string }
  | { m: 'channel.addMember'; stream_id: string; user_id: string }
  | { m: 'channel.removeMember'; stream_id: string; user_id: string }
  | { m: 'dm.create'; user_ids: string[] }

/** `outbox.send` result — enough for the tab to locate its optimistic row. */
export interface SendResult {
  message_id: string
  event_id: string
  created_seq: number
}

/** `outbox.retry` / `outbox.delete` / member-op result. */
export interface OutboxActionResult {
  ok: true
}

/** `channel.create` / `dm.create` result — the new stream id (for instant switch). */
export interface StreamCreatedResult {
  stream_id: string
}

/** The union of every mutation result (RpcResultMap['mutate']). */
export type MutateResultUnion = SendResult | OutboxActionResult | StreamCreatedResult

/** A stream's unread count + mention badge (§3.5), derived at query time. */
export interface StreamBadge {
  stream_id: string
  unread: number
  mention: boolean
}

/**
 * A DM stream's participant ids (ENG-149), resolved AT QUERY TIME from the DM's
 * own cached `dm.created` genesis event — which is SELF-HOMED in the DM stream
 * (§2.2), so every DM member's client receives and caches it like any other
 * stream event. This is NOT a stored projection column: no Dexie schema change,
 * no PROJECTION_VERSION bump, and rebuild ≡ incremental is untouched (the
 * derived tables are byte-identical to before). The tab uses it to label a DM
 * with the OTHER participant's display name and drive a presence dot. Absent
 * when the genesis event is not (yet) in the local cache — the UI then keeps
 * the id fallback (graceful, never a crash).
 */
export interface DmParticipants {
  dm_user_ids?: string[]
}

/** `messages.list` result — a page of messages + whether older ones remain. */
export interface MessagesListResult {
  messages: MessageRow[]
  has_more: boolean
}

/** `streams.list` result — sidebar streams, each merged with its badge (+ DM participants). */
export interface StreamsListResult {
  streams: Array<StreamRow & StreamBadge & DmParticipants>
}

/** `message.get` result — the message, or `null` on a miss. */
export interface MessageGetResult {
  message: MessageRow | null
}

/**
 * One workspace user in the member directory (ENG-101 mention source, extended
 * by ENG-164): the per-user RECORD the workspace-meta fold produces —
 * `user.joined` adds it, `user.profile_updated` (author == subject only)
 * updates it field-by-field (a carried `null` clears; an absent key is left
 * untouched, so pre-ENG-164 rename events still fold correctly). The optional
 * fields mirror the `user.profile_updated` payload / server `users` columns
 * field-for-field (flat, not nested — ONE shape across row, event, and
 * directory). `status_expires_at` is carried RAW: the fold never consults the
 * clock (rebuild ≡ incremental stays deterministic) — expiry is applied at
 * RENDER time (`lib/status.ts` `activeStatus`, the lazy-expiry contract).
 */
export interface DirectoryUser {
  user_id: string
  display_name: string
  title?: string
  description?: string
  status_emoji?: string
  status_text?: string
  status_expires_at?: string
}

/** One `#channel`-able stream (ENG-101). */
export interface DirectoryChannel {
  stream_id: string
  name: string
}

/** `directory.list` result — the autocomplete source (users + channels). */
export interface DirectoryListResult {
  users: DirectoryUser[]
  channels: DirectoryChannel[]
}

/**
 * One aggregated reaction chip for a message (ENG-102): a single `emoji` with its
 * reactor count, the reactor `user_ids`, their resolved `display_names` (for the
 * who-reacted tooltip, folded from the workspace directory), and `mine` (whether
 * the signed-in user is among them — drives the idempotent toggle). `emoji` is
 * OPAQUE bytes (may contain control chars): the tab renders it ONLY through Vue
 * text interpolation, never a raw-HTML sink.
 */
export interface ReactionAggregate {
  emoji: string
  count: number
  user_ids: string[]
  display_names: string[]
  mine: boolean
}

/** The reaction chips for one message (`messages.reactions`), present-only. */
export interface MessageReactions {
  message_id: string
  reactions: ReactionAggregate[]
}

/** `messages.reactions` result — chips for each requested message id. */
export interface ReactionsListResult {
  messages: MessageReactions[]
}

/**
 * One thread participant (ENG-103) — a DISTINCT author of a root's non-deleted
 * settled replies, with a `display_name` resolved from the workspace directory
 * (falls back to the `user_id`). Rendered as a small avatar/initial in the reply
 * affordance and the pane header; `display_name` is OPAQUE user content, so the
 * tab renders it ONLY via Vue text interpolation.
 */
export interface ThreadParticipant {
  user_id: string
  display_name: string
}

/**
 * A thread summary for one root (ENG-103, `messages.threads`) — the reply count
 * and participant set the main message list needs to render the affordance. The
 * count mirrors the root row's `reply_count` (non-deleted settled replies).
 */
export interface ThreadSummary {
  root_message_id: string
  reply_count: number
  participants: ThreadParticipant[]
}

/** `messages.threads` result — a thread summary for each requested root id. */
export interface ThreadsListResult {
  threads: ThreadSummary[]
}

/**
 * `messages.thread` result (ENG-103) — the thread pane's payload: the `root`
 * message (or `null` if it is not loaded), a page of `replies` ordered ASC by
 * `created_seq` (with `has_more` for scroll-up backfill), and the full
 * participant set.
 */
export interface ThreadResult {
  root: MessageRow | null
  replies: MessageRow[]
  has_more: boolean
  participants: ThreadParticipant[]
}

/**
 * `attachments.forMessage` result (ENG-120) — a message's resolved attachments.
 * `files` are the projected {@link FileRow}s for the message's `file_ids`, in the
 * SAME order as the message's `file_ids` (so the UI renders them stably);
 * `pending_file_ids` are the ids whose `file.uploaded` has not yet projected
 * (not-yet-delivered / not-yet-backfilled) — the UI shows them as pending. An
 * empty `file_ids` (or an unknown message) yields both arrays empty.
 */
export interface AttachmentsResult {
  message_id: string
  files: FileRow[]
  pending_file_ids: string[]
}

/**
 * `files.list` result (ENG-152) — every projected file the local cache holds,
 * newest-first (`created_at` desc, `file_id` desc tiebreak). The Files view
 * renders this directly; download/thumbnail bytes still go through
 * `client.files.download`/`thumbnail` (the ENG-119 blob path).
 */
export interface FilesListResult {
  files: FileRow[]
}

/** The union of every projection-query result (RpcResultMap['query']). */
export type QueryResultUnion =
  | MessagesListResult
  | StreamsListResult
  | MessageGetResult
  | DirectoryListResult
  | ReactionsListResult
  | ThreadResult
  | ThreadsListResult
  | AttachmentsResult
  | FilesListResult

/** Result keyed to the query's `q` discriminant (WorkerClient.query<Q>). */
export type QueryResult<Q extends QueryParams> = Q extends { q: 'messages.list' }
  ? MessagesListResult
  : Q extends { q: 'streams.list' }
    ? StreamsListResult
    : Q extends { q: 'message.get' }
      ? MessageGetResult
      : Q extends { q: 'directory.list' }
        ? DirectoryListResult
        : Q extends { q: 'messages.reactions' }
          ? ReactionsListResult
          : Q extends { q: 'messages.thread' }
            ? ThreadResult
            : Q extends { q: 'messages.threads' }
              ? ThreadsListResult
              : Q extends { q: 'attachments.forMessage' }
                ? AttachmentsResult
                : Q extends { q: 'files.list' }
                  ? FilesListResult
                  : never
export type MutateResult<M extends MutateParams> = M extends {
  m: 'outbox.send' | 'outbox.react' | 'outbox.edit' | 'outbox.remove'
}
  ? SendResult
  : M extends { m: 'channel.create' | 'dm.create' }
    ? StreamCreatedResult
    : M extends {
          m:
            | 'outbox.retry'
            | 'outbox.delete'
            | 'channel.rename'
            | 'channel.archive'
            | 'channel.addMember'
            | 'channel.removeMember'
        }
      ? OutboxActionResult
      : never

// ---------------------------------------------------------------------------
// File upload/download (ENG-119). The worker owns ALL of it — the token, the
// `fetch`, the `/v1/files/...` calls, the hashing — behind this RPC surface. A
// tab passes the `File` as an opaque structured clone and reads back only bytes
// (a `Blob`) + phase pushes; the session token NEVER crosses the boundary (R1).
// ---------------------------------------------------------------------------

/**
 * Upload state-machine phases (ENG-119), pushed to the tab on every transition:
 * `queued → hashing → initiating → uploading → emitting → done`. `uploading` is
 * SKIPPED when `initiate` returns `upload_needed:false` (server-side content
 * dedup — the blob is already present). A hard failure (413/quota/401/…) lands in
 * `failed` with the error `code`; a transient blip backs off and retries the same
 * step, never surfacing `failed`.
 */
export type UploadPhase =
  'queued' | 'hashing' | 'initiating' | 'uploading' | 'emitting' | 'done' | 'failed'

/**
 * One upload-progress frame (ENG-119) — PHASE-level, not byte-level. The composer
 * (ENG-121) renders a pending chip and shows the phase while the blob uploads. An
 * upload is DECOUPLED from message-send (ENG-121, Option A): it emits ONLY the
 * durable `file.uploaded` log record and drives the chip to `done`; the referencing
 * `message.created` is authored later, once, by `outbox.send` on Send. So the frame
 * carries the resolved `file_id` (known after `initiating`) — the composer collects
 * these to pass as `file_ids` on Send — and NO message_id/event_id (there is no
 * companion message at this layer). `code` is set only on `failed`.
 */
export interface UploadProgress {
  upload_id: string
  phase: UploadPhase
  file_id?: string
  code?: string
}

/**
 * `file.upload` params (ENG-119). The tab MINTS `upload_id` (`crypto.randomUUID()`)
 * so it can subscribe to the `{kind:'upload'}` push BEFORE issuing the request (no
 * lost-first-frame race). The `file` is a STRUCTURED CLONE of the `File` handle —
 * cloneable (not transferable); the clone shares the blob handle, not the bytes, so
 * it is cheap. The worker (never the tab) calls `file.arrayBuffer()`/hashes it. No
 * message fields ride here: the upload is DECOUPLED from message-send (ENG-121) —
 * it homes+PUTs the blob and enqueues `file.uploaded`; the composer references the
 * resolved `file_id` from `outbox.send` on Send.
 */
export interface FileUploadParams {
  upload_id: string
  stream_id: string
  file: File
}

/** `file.upload`/`file.retry`/`file.cancel` result — echoes the tab-minted id. */
export interface UploadAck {
  upload_id: string
}

/**
 * `file.fetch` result (ENG-119): opaque bytes + the response `mime_type`, or a
 * `null` blob on a 404 (the file/thumbnail does not exist or is not readable — the
 * server folds all non-authorized shapes into one uniform 404, no existence oracle).
 * Only bytes cross the boundary; the TAB (not the worker) mints the `blob:` object
 * URL, since such a URL is context-scoped and a worker-minted one is unusable in the
 * tab DOM.
 */
export interface FileFetchResult {
  blob: Blob | null
  mime_type?: string
}

export interface RpcError {
  code: string
  detail?: string
}

/**
 * A handler error carrying an explicit RPC `code` (vs. the generic fallback).
 * Shared by `WorkerCore` (query dispatch) and the `Outbox` (e.g. an
 * unauthenticated `outbox.send` → `not_authenticated`) so both surface through
 * the same `toRpcError` mapping. Lives here (pure, no runtime deps) to avoid a
 * core↔outbox import cycle.
 */
export class RpcCodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RpcCodedError'
  }
}

// ---------------------------------------------------------------------------
// Sync engine (ENG-79) — wire shapes, stored-event shape, state machine, and
// the projection-apply seam shared with ENG-80. All plain, clone-safe data.
// ---------------------------------------------------------------------------

// `WireEvent` / `StoredEvent` / `EventServerMeta` are defined above with the
// Dexie row shapes (they double as `EventRow.envelope`). The pull/WS wire event
// is identical to the stored envelope (raw-hash discipline): `body` is the
// verbatim raw JSONB the `event_hash` was computed over — NEVER re-serialize it.

/** One page of `GET /v1/events` (ascending within the page). */
export interface EventsPageResponse {
  events: WireEvent[]
  has_more: boolean
}

/** One readable stream in a `GET /v1/sync` snapshot (server `SyncStream`). */
export interface SyncStreamMeta {
  stream_id: string
  kind: string
  name: string | null
  visibility: string | null
  head_seq: number
  member: boolean
  /** `true` iff the channel is archived (ENG-104); absent on older servers → false. */
  archived?: boolean
}

/** The full `GET /v1/sync` snapshot (server `SyncResponse`). */
export interface SyncResponse {
  streams: SyncStreamMeta[]
}

/** Sync engine lifecycle states (§5.3 / §6). */
export type SyncState = 'idle' | 'connecting' | 'syncing' | 'live' | 'degraded'

/**
 * Tab-facing sync status — distinct from {@link WorkerStatus} (transport/db/role).
 * Emitted on every transition via the `{kind:'sync'}` push topic + the
 * `sync.status` RPC.
 */
export interface SyncStatus {
  state: SyncState
  online: boolean
  streamsTotal?: number
  streamsSynced?: number
  lastError?: string
}

/** Result of a `sync.backfill` RPC (§10). */
export interface BackfillResult {
  events: number
  has_more: boolean
  oldest_loaded_seq: number
}

/**
 * The coordination seam with ENG-80 (LOCKED signature). Called by the sync
 * engine AFTER a contiguous run of verified events has been persisted to
 * `events` and the stream cursor advanced. `events` is ascending, gapless,
 * hash-verified and already stored — ENG-80 projects them into `messages`.
 * Default: {@link noopApplyToProjection} (ENG-79 ships + tests standalone).
 *
 * Contract:
 *  - called once per applied batch per stream (a bootstrap/catch-up page or a
 *    single live frame), NOT once per event;
 *  - only ever receives events the cursor now covers (never a gap/duplicate);
 *  - awaited so a projection read after `sync.status == live` is consistent;
 *  - must not be used for control flow — a throw is logged and swallowed by the
 *    engine (the cursor is already committed truth; recovery is a rebuild).
 */
export type ApplyEventsToProjection = (
  streamId: string,
  events: readonly EventRow[],
) => Promise<void>

export const noopApplyToProjection: ApplyEventsToProjection = () => Promise.resolve()

// ---------------------------------------------------------------------------
// Auth taxonomy (ENG-78, R5). Credentials cross tab→worker over the in-process
// postMessage RPC (never a tab network hop); the worker POSTs them and keeps the
// resulting token worker-only. Every result below is TOKEN-FREE by construction.
// ---------------------------------------------------------------------------

export interface LoginCredentials {
  email: string
  password: string
}

export interface SetupCredentials {
  workspace_name: string
  email: string
  password: string
  display_name: string
}

export interface AcceptInviteCredentials {
  token: string
  email: string
  display_name: string
  password: string
}

/** Tab-facing identity — carries NO token (R1). */
export interface AuthStatus {
  authenticated: boolean
  my_user_id?: string
  workspace_id?: string
  role?: string
  expires_at?: string
}

/** Application-level auth outcome (token-free); a wrong password is not an RPC fault. */
export type AuthResult = { ok: true; status: AuthStatus } | { ok: false; error: ApiError }

// ---------------------------------------------------------------------------
// Search (ENG-126) — the ONE read that is an HTTP call, not a local projection
// query. Postgres FTS is server-side (ENG-122); the token stays worker-side, so
// `search` is a top-level RPC method (NOT a `query` `q`, which are all local).
// Pagination is EXPLICIT and stateless: a tab re-calls `search` with the
// returned `cursor` to fetch the next page.
// ---------------------------------------------------------------------------

/** One `GET /v1/search` hit (server FTS row, readable-scoped). */
export interface SearchHit {
  message_id: string
  stream_id: string
  author_user_id: string
  text: string
  created_seq: number
  rank: number
  thread_root_id: string | null
}

/**
 * `search` params. `q` is the full-text query; `in` filters by stream, `from` by
 * author; `before`/`after` bound `created_seq` (ints); `limit` is 1..50; `cursor`
 * resumes a prior page. NO token/identity fields — the worker attaches the bearer.
 */
export interface SearchParams {
  q: string
  in?: string
  from?: string
  before?: number
  after?: number
  limit?: number
  cursor?: string
}

/** `search` result — a page of hits + an opaque `cursor` for the next page. */
export interface SearchResult {
  hits: SearchHit[]
  next_cursor: string | null
}

/** `prefs.get` result — the notification-pref snapshot (default `all` when a stream is absent). */
export interface PrefsListResult {
  prefs: PrefsRow[]
}

// ---------------------------------------------------------------------------
// Admin (ENG-151) — HTTP pass-through RPCs over `/v1/admin/*` (owner/admin
// only, enforced server-side). Live reads/writes like `search`: the worker
// attaches the bearer and returns the server response verbatim — NOTHING is
// persisted to the local DB (no projection, no synced-KV, no event). Shapes
// mirror `server/msgd/api/schemas/admin.py` field-for-field.
// ---------------------------------------------------------------------------

/**
 * One workspace member in the admin roster (`GET /v1/admin/members`, server
 * `MemberInfo`). `deactivated` is the boolean projection of
 * `deactivated_at IS NOT NULL` — the server does not expose the timestamp.
 * Emails are admin-visible BY DESIGN on this owner/admin-gated surface; they
 * never appear in the client-facing `directory.list` projection.
 */
export interface AdminMember {
  user_id: string
  display_name: string
  email: string
  role: string
  is_bot: boolean
  deactivated: boolean
}

/** `admin.members.list` result (server `MemberListResponse`). */
export interface AdminMembersResult {
  members: AdminMember[]
}

/**
 * Roles assignable via the admin PATCH (server `UpdateMemberRequest.role`
 * Literal) — `owner` is structurally excluded: it can never be assigned.
 */
export type AdminAssignableRole = 'admin' | 'member' | 'guest'

/**
 * `admin.members.update` params — `PATCH /v1/admin/members/{user_id}`. At
 * least one of `role`/`active` must be given (an empty PATCH is a server 422).
 * `active: false` deactivates (and bulk-revokes the target's sessions
 * server-side); `active: true` reactivates.
 */
export interface AdminMemberUpdateParams {
  user_id: string
  role?: AdminAssignableRole
  active?: boolean
}

/**
 * One PENDING invite (`GET /v1/admin/invites`, server `InviteInfo`). `id` is
 * the invite's sha256 `token_hash` — a revoke handle, NOT a credential; the
 * raw join token appears in no admin response. `expires_at` is RFC 3339.
 */
export interface AdminInvite {
  id: string
  role: string
  created_by: string
  expires_at: string
}

/** `admin.invites.list` result (server `InviteListResponse`; pending only). */
export interface AdminInvitesResult {
  invites: AdminInvite[]
}

/**
 * `admin.invites.create` params — `POST /v1/admin/invites`. `role` is the
 * assignable Literal (`owner` structurally excluded, exactly like the server
 * `CreateInviteRequest`). `ttl_seconds` is optional; the server defaults it
 * (7 days) and clamps it to its configured maximum (30 days).
 */
export interface AdminInviteCreateParams {
  role: AdminAssignableRole
  ttl_seconds?: number
}

/**
 * `admin.invites.create` result (server `InviteResponse`). `url` is the join
 * link with the RAW single-use invite token embedded — returned EXACTLY ONCE
 * at create time, never persisted (only its sha256 hash is stored), and never
 * available again from any list/read. `expires_at` is RFC 3339.
 */
export interface AdminInviteCreateResult {
  url: string
  expires_at: string
}

/** `admin.invites.revoke` result — the server 204 folded to a plain ack. */
export interface AdminInviteRevokeResult {
  ok: true
}

// ---------------------------------------------------------------------------
// Self-profile (`/v1/me`) — HTTP pass-through RPCs like `admin.*`: the worker
// attaches the bearer and returns the server response verbatim; nothing is
// persisted locally. Structurally SELF-ONLY: no params carry a user_id — the
// server resolves the target from the session. Shapes mirror
// `server/msgd/api/schemas/me.py` field-for-field.
// ---------------------------------------------------------------------------

/**
 * The caller's own profile (`GET /v1/me` / the `PATCH /v1/me` echo, server
 * `MeResponse`). `email` is the caller's OWN address (it never appears in the
 * client-facing `directory.list` projection for anyone else).
 */
export interface MeProfile {
  user_id: string
  display_name: string
  email: string
  role: string
  is_bot: boolean
  /** ENG-164 profile fields — `null` when unset. The server applies LAZY status
   * expiry before responding (an expired status reads as cleared). */
  title: string | null
  description: string | null
  status_emoji: string | null
  status_text: string | null
  status_expires_at: string | null
}

/**
 * The `status` object of `me.update` — replaces the custom status as a UNIT.
 * `clear_after` is the closed duration vocabulary the SERVER converts to an
 * absolute `status_expires_at` (the client never mints the timestamp); omitted
 * means the status never auto-clears.
 */
export interface MeStatusParams {
  emoji?: string | null
  text?: string | null
  clear_after?: '30m' | '1h' | 'today'
}

/**
 * `me.update` params — `PATCH /v1/me`, SUBSET semantics (ENG-164): only the
 * fields the caller sets are sent/applied; an explicit `null` clears `title` /
 * `description` / `status` (`display_name` is not clearable — server 422).
 * Bounds are the server's: display_name 1..200, title ≤100, description ≤500,
 * status text ≤100, emoji a single bounded grapheme.
 */
export interface MeUpdateParams {
  display_name?: string
  title?: string | null
  description?: string | null
  status?: MeStatusParams | null
}

/** Live-presence status for a workspace user (ENG-125), ephemeral (memory-only). */
export type PresenceStatus = 'online' | 'offline'

/** One presence entry in a {@link PresencePush} snapshot. */
export interface PresenceEntry {
  user_id: string
  status: PresenceStatus
}

/** `{kind:'presence'}` push — the FULL current workspace presence snapshot. */
export interface PresencePush {
  presence: PresenceEntry[]
}

/** `{kind:'typing'}` push — a stream's current (non-expired) typing user set. */
export interface TypingPush {
  stream_id: string
  user_ids: string[]
}

/** `{kind:'prefs'}` push — the full notification-pref snapshot on any change. */
export interface PrefsPush {
  prefs: PrefsRow[]
}

export type RpcRequest =
  | { method: 'meta.get'; params: { key: string } }
  | { method: 'query'; params: QueryParams }
  | { method: 'mutate'; params: MutateParams }
  | { method: 'ping'; params: Record<string, never> }
  | { method: 'auth.login'; params: LoginCredentials }
  | { method: 'auth.setup'; params: SetupCredentials }
  | { method: 'auth.acceptInvite'; params: AcceptInviteCredentials }
  | { method: 'auth.logout'; params: Record<string, never> }
  | { method: 'auth.status'; params: Record<string, never> }
  | { method: 'sync.status'; params: Record<string, never> }
  | { method: 'sync.backfill'; params: { stream_id: string } }
  | { method: 'sync.start'; params: Record<string, never> }
  | { method: 'sync.stop'; params: Record<string, never> }
  // ENG-119 file upload/download — all `fetch`/token/`/v1/files` stay worker-side.
  | { method: 'file.upload'; params: FileUploadParams }
  | { method: 'file.retry'; params: { upload_id: string } }
  | { method: 'file.cancel'; params: { upload_id: string } }
  | { method: 'file.fetch'; params: { file_id: string; variant: 'blob' | 'thumbnail' } }
  // ENG-126 — search (HTTP FTS, token worker-side), synced-KV read-state/prefs,
  // and the outbound typing signal. `readState.mark`/`prefs.set` mutate a
  // server-authoritative per-user KV (NOT the event log); `typing.send` is a
  // fire-and-forget ephemeral WS signal (client-throttled, dropped when offline).
  | { method: 'search'; params: SearchParams }
  // ENG-151 admin — HTTP pass-through over `/v1/admin/*` (token worker-side;
  // owner/admin enforced server-side; a 403/404/422 surfaces as a coded error).
  | { method: 'admin.members.list'; params: Record<string, never> }
  | { method: 'admin.members.update'; params: AdminMemberUpdateParams }
  | { method: 'admin.invites.list'; params: Record<string, never> }
  | { method: 'admin.invites.create'; params: AdminInviteCreateParams }
  | { method: 'admin.invites.revoke'; params: { id: string } }
  // Self-profile — HTTP pass-through over `/v1/me` (token worker-side;
  // structurally self-only; a 401/422 surfaces as a coded error).
  | { method: 'me.get'; params: Record<string, never> }
  | { method: 'me.update'; params: MeUpdateParams }
  | { method: 'readState.mark'; params: { stream_id: string; last_read_seq: number } }
  | { method: 'prefs.get'; params: Record<string, never> }
  | { method: 'prefs.set'; params: { stream_id: string; level: PrefLevel } }
  | { method: 'typing.send'; params: { stream_id: string } }

export type RpcMethod = RpcRequest['method']

/** Push topics — ENG-79/80 add topics without touching the transport. */
export type Topic =
  | { kind: 'stream'; stream_id: string }
  | { kind: 'status' }
  | { kind: 'sync' }
  // ENG-119: per-upload progress. The tab subscribes on its minted `upload_id`
  // before issuing `file.upload`, then reads the phase machine off these pushes.
  | { kind: 'upload'; upload_id: string }
  // ENG-126 ephemeral signals + prefs reactivity. `presence` is workspace-wide;
  // `typing` is per-stream; `prefs` fans the whole snapshot on any change. Late
  // subscribers seed from the current in-memory snapshot on their first push.
  | { kind: 'presence' }
  | { kind: 'typing'; stream_id: string }
  | { kind: 'prefs' }

/** Payload delivered on a push, keyed to the topic. */
export interface StreamPush {
  stream_id: string
}
export type PushPayload<T extends Topic> = T extends { kind: 'status' }
  ? WorkerStatus
  : T extends { kind: 'sync' }
    ? SyncStatus
    : T extends { kind: 'stream' }
      ? StreamPush
      : T extends { kind: 'upload' }
        ? UploadProgress
        : T extends { kind: 'presence' }
          ? PresencePush
          : T extends { kind: 'typing' }
            ? TypingPush
            : T extends { kind: 'prefs' }
              ? PrefsPush
              : never

// Tab → Worker frames. Every frame carries `clientId` so the leader's
// BroadcastChannel can fan responses to the right follower.
export type ToWorker =
  | { t: 'hello'; clientId: string }
  | { t: 'req'; id: string; clientId: string; req: RpcRequest }
  | { t: 'sub'; id: string; clientId: string; topic: Topic }
  | { t: 'unsub'; id: string; clientId: string }
  | { t: 'bye'; clientId: string }

// Worker → Tab frames.
export type FromWorker =
  | { t: 'res'; id: string; ok: true; result: unknown }
  | { t: 'res'; id: string; ok: false; error: RpcError }
  | { t: 'push'; topic: Topic; payload: unknown }
  | { t: 'status'; status: WorkerStatus }

/** The only output of WorkerCore: address a frame to a client (D-3). */
export type MessageSink = (clientId: string, msg: FromWorker) => void

/**
 * The thin platform seam a `WorkerClient` is built on. Each transport
 * (SharedWorker / leader / solo) implements it; the RPC caller sits on top and
 * is identical across all three.
 */
export interface Transport {
  post(frame: ToWorker): void
  onFrame(cb: (frame: FromWorker) => void): void
  status(): WorkerStatus
  onStatus(handler: (s: WorkerStatus) => void): Unsubscribe
  ready(): Promise<void>
  dispose(): void
}

// ---------------------------------------------------------------------------
// WorkerClient — the ONE object every store consumes (D-1). Identical surface
// across the SharedWorker, leader, and solo transports.
// ---------------------------------------------------------------------------

export type Unsubscribe = () => void

export interface WorkerStatus {
  transport: 'shared-worker' | 'leader' | 'solo'
  db: 'persistent' | 'memory'
  role: 'leader' | 'follower' | 'n/a'
}

export interface WorkerClient {
  /** Resolves once the worker/leader is reachable and the DB is open. */
  ready(): Promise<void>

  /** Read a projection. Discriminated on `params.q`; result keyed to the query. */
  query<Q extends QueryParams>(params: Q): Promise<QueryResult<Q>>

  /** Enqueue a durable mutation / set read-state. Discriminated on `params.m`. */
  mutate<M extends MutateParams>(params: M): Promise<MutateResult<M>>

  /** Subscribe to worker→tab pushes. Returns an unsubscribe fn. */
  subscribe<T extends Topic>(topic: T, handler: (payload: PushPayload<T>) => void): Unsubscribe

  /** Current transport/connection status. */
  status(): WorkerStatus
  onStatus(handler: (s: WorkerStatus) => void): Unsubscribe

  /**
   * Auth namespace (ENG-78). The tab issues intent; the worker owns the token.
   * `login/setup/acceptInvite` return token-free application-level results;
   * `status` returns identity only. No method ever exposes the raw token (R1).
   */
  auth: {
    login(c: LoginCredentials): Promise<AuthResult>
    setup(c: SetupCredentials): Promise<AuthResult>
    acceptInvite(c: AcceptInviteCredentials): Promise<AuthResult>
    logout(): Promise<{ ok: true }>
    status(): Promise<AuthStatus>
  }

  /**
   * Sync namespace (ENG-79/82). Thin tab-facing accessors over the already-
   * registered `sync.status` / `sync.backfill` RPC handlers — no new worker
   * logic. The shell reads the initial status here (the live stream arrives on
   * the `{kind:'sync'}` push) and drives scroll-top scrollback via `backfill`,
   * which extends the stream's window backward one server page (§10).
   */
  sync: {
    status(): Promise<SyncStatus>
    backfill(streamId: string): Promise<BackfillResult>
  }

  /**
   * Files namespace (ENG-119). Thin wrappers over the worker `file.*` RPCs. The tab
   * mints `upload_id` and subscribes via `onProgress` BEFORE calling `upload` (no
   * lost-first-frame race); `download`/`thumbnail` return opaque bytes the TAB turns
   * into a `blob:` URL. Every `fetch`/token/`/v1/files` call lives worker-side —
   * this namespace only shuttles clone-safe data across the RPC boundary (R1).
   */
  files: {
    upload(params: FileUploadParams): Promise<UploadAck>
    retry(uploadId: string): Promise<UploadAck>
    cancel(uploadId: string): Promise<UploadAck>
    download(fileId: string): Promise<FileFetchResult>
    thumbnail(fileId: string): Promise<FileFetchResult>
    /** ENG-152: the workspace file listing — sugar over `query({q:'files.list'})`. */
    list(): Promise<FilesListResult>
    onProgress(uploadId: string, cb: (payload: UploadProgress) => void): Unsubscribe
  }

  /**
   * Search (ENG-126). The ONE read that hits the HTTP API rather than the local
   * projection — Postgres FTS is server-side. The token stays worker-side; the tab
   * passes only filters + an opaque `cursor` and reads back hits + `next_cursor`.
   */
  search(params: SearchParams): Promise<SearchResult>

  /**
   * Admin namespace (ENG-151). HTTP pass-through over the worker's authed
   * client — owner/admin gating, the policy matrix, and all error semantics
   * are SERVER truth; the worker forwards + maps a 403/404/422 to a coded
   * `RpcCallError` (`forbidden` / `not-found` / `validation-error`). Nothing
   * is projected or persisted locally, and no method exposes a token or URL.
   */
  admin: {
    members: {
      list(): Promise<AdminMembersResult>
      update(params: AdminMemberUpdateParams): Promise<AdminMember>
    }
    invites: {
      list(): Promise<AdminInvitesResult>
      create(params: AdminInviteCreateParams): Promise<AdminInviteCreateResult>
      revoke(params: { id: string }): Promise<AdminInviteRevokeResult>
    }
  }

  /**
   * Self-profile namespace (`/v1/me`). HTTP pass-through over the worker's
   * authed client, mirroring `admin` — structurally self-only (no user_id on
   * any param), live server truth, nothing persisted locally. The rename a
   * successful `update` triggers reaches the UI via the normal sync path: the
   * server appends `user.profile_updated` to workspace-meta and the local
   * directory fold renames the member.
   */
  me: {
    get(): Promise<MeProfile>
    update(params: MeUpdateParams): Promise<MeProfile>
  }

  /**
   * Read-state (ENG-126). `mark` records the newest read `seq` for a stream —
   * optimistic + monotonic (never rewinds), reconciled with the server GREATEST.
   * The unread/mention badge clears instantly via the `{kind:'stream'}` push.
   */
  readState: {
    mark(streamId: string, seq: number): Promise<ReadStateRow>
  }

  /**
   * Notification prefs (ENG-126). `get` returns the snapshot (default `all` per
   * absent stream); `set` writes the per-channel level (LWW). Changes fan on the
   * `{kind:'prefs'}` push.
   */
  prefs: {
    get(): Promise<PrefsListResult>
    set(streamId: string, level: PrefLevel): Promise<PrefsRow>
  }

  /**
   * Presence (ENG-126) — ephemeral, memory-only, workspace-wide. `subscribe` seeds
   * from the current in-memory snapshot on its first push and updates on every
   * live frame; nothing is persisted, and the set is wiped on a socket drop.
   */
  presence: {
    subscribe(cb: (payload: PresencePush) => void): Unsubscribe
  }

  /**
   * Typing (ENG-126) — ephemeral, memory-only, per-stream. `subscribe` receives a
   * stream's live typing set (auto-expiring ~5s); `send` emits a throttled
   * outbound typing signal (dropped silently when not `live`).
   */
  typing: {
    subscribe(streamId: string, cb: (payload: TypingPush) => void): Unsubscribe
    send(streamId: string): Promise<{ ok: true }>
  }

  /** Detach this tab (close port / leave channel). Idempotent. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Pure helpers shared by core + rpc (no platform deps).
// ---------------------------------------------------------------------------

/** Stable string key for a topic, used to match pushes to subscribers. */
export function topicKey(topic: Topic): string {
  switch (topic.kind) {
    case 'status':
      return 'status'
    case 'sync':
      return 'sync'
    case 'stream':
      return `stream:${topic.stream_id}`
    case 'upload':
      return `upload:${topic.upload_id}`
    case 'presence':
      return 'presence'
    case 'typing':
      return `typing:${topic.stream_id}`
    case 'prefs':
      return 'prefs'
  }
}
