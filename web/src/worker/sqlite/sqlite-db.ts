// worker/sqlite/sqlite-db.ts — SqliteDb, the third MsgDb implementation
// (ENG-165, M6-1: the Tauri-desktop persistence backend).
//
// Design: a THIN MAPPER over the SqlDriver seam (driver.ts). Each MsgDb table
// is one SQLite table storing the row VERBATIM as JSON in a `data` TEXT column,
// plus the key/range columns the queries need (denormalized copies, exactly
// like the Dexie indexes). Rows therefore round-trip byte-identically to the
// DexieDb/MemoryDb shapes, and the whole projection/rebuild layer
// (`checkProjectionVersion` / `rebuildProjections` / `applyEventsToProjection`)
// runs UNCHANGED over this backend — invariant 6 is preserved by construction.
//
// Semantics mirror DexieDb method-for-method (see db.ts); the msgdb-conformance
// suite runs the identical spec over MemoryDb, DexieDb and SqliteDb.
//
// FTS5 (ENG-166, M6-2): `messages_fts` is an EXTERNAL-CONTENT FTS5 table over
// `messages.text`, maintained strictly inside `putMessages`/`deleteMessage` —
// the two methods every message write flows through — in the SAME transaction
// as the row write, so the index cannot drift from the projection.
// `clearDerivedTables` wipes it too ('delete-all'), so a projection rebuild
// reconstructs the index through the normal `putMessages` path (invariant 6
// holds for search: rebuild ≡ incremental). `capabilities.fts` is true here;
// WorkerCore routes `search` to the local index on that flag.

import {
  META_SESSION_TOKEN,
  type CursorRow,
  type EventRow,
  type FileRow,
  type FtsSearchOptions,
  type MessageRow,
  type MsgDb,
  type OutboxRow,
  type PrefsRow,
  type ReactionRow,
  type ReadStateRow,
  type SearchHit,
  type StreamRow,
  type TableName,
  type ThreadParticipantRow,
} from '../types'

import type { SqlDriver, SqlValue } from './driver'

// ---------------------------------------------------------------------------
// Schema — one table per MsgDb table: indexed key columns + the verbatim JSON
// row in `data`. `read_state` is the one exception: its row IS its two columns
// ({stream_id, last_read_seq}), so no JSON column is needed and the monotonic
// CAS can be a single arithmetic UPDATE. Mirrors the Dexie `.stores()` strings
// in db.ts — do not drift the key/index set without doing both.
// ---------------------------------------------------------------------------

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     data TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     stream_id TEXT NOT NULL,
     server_sequence INTEGER NOT NULL,
     event_id TEXT NOT NULL,
     type TEXT NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (stream_id, server_sequence)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_event_id ON events (event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type ON events (type)`,
  `CREATE TABLE IF NOT EXISTS messages (
     message_id TEXT PRIMARY KEY,
     stream_id TEXT NOT NULL,
     created_seq INTEGER NOT NULL,
     thread_root_id TEXT,
     text TEXT NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_stream_seq ON messages (stream_id, created_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages (thread_root_id)`,
  // ENG-166 (M6-2): the local full-text index — an EXTERNAL-CONTENT FTS5 table
  // over `messages.text` (content= / content_rowid=), so the text is stored
  // once (in `messages`) and the FTS table holds only the index. External
  // content means SQLite does NOT maintain it automatically: every write goes
  // through `putMessages`/`deleteMessage` below, which issue the documented
  // 'delete'-with-old-values + insert maintenance in the same transaction.
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
     text,
     content='messages',
     content_rowid='rowid'
   )`,
  `CREATE TABLE IF NOT EXISTS reactions (
     message_id TEXT NOT NULL,
     author_user_id TEXT NOT NULL,
     emoji TEXT NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (message_id, author_user_id, emoji)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions (message_id)`,
  `CREATE TABLE IF NOT EXISTS thread_participants (
     root_message_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     data TEXT NOT NULL,
     PRIMARY KEY (root_message_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS files (
     file_id TEXT PRIMARY KEY,
     stream_id TEXT NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_files_stream ON files (stream_id)`,
  `CREATE TABLE IF NOT EXISTS streams (
     stream_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cursors (
     stream_id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS outbox (
     event_id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     data TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS read_state (
     stream_id TEXT PRIMARY KEY,
     last_read_seq INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS prefs (
     stream_id TEXT PRIMARY KEY,
     data TEXT NOT NULL
   )`,
]

/** The full table set — `count()`'s whitelist (also guards the interpolation). */
const TABLES: readonly TableName[] = [
  'events',
  'messages',
  'reactions',
  'thread_participants',
  'files',
  'streams',
  'cursors',
  'outbox',
  'read_state',
  'prefs',
  'meta',
]

/** Chunk size for `IN (…)`/bulk statements — well under SQLite's variable cap. */
const CHUNK = 500

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)])
  return out
}

function placeholders(n: number): string {
  return new Array<string>(n).fill('?').join(', ')
}

/** Parse the verbatim JSON `data` column back into the row it round-trips. */
function parseRows<T>(rows: readonly { data: string }[]): T[] {
  return rows.map((r) => JSON.parse(r.data) as T)
}

// ---------------------------------------------------------------------------
// SqliteDb
// ---------------------------------------------------------------------------

export class SqliteDb implements MsgDb {
  /** File-backed SQLite — writes survive a restart (`:memory:` is test-only). */
  readonly persistence = 'persistent' as const
  /** ENG-166 (M6-2): FTS5 is live — WorkerCore serves `search` locally on this flag. */
  readonly capabilities = { fts: true } as const

  constructor(private readonly driver: SqlDriver) {}

  // -- meta -----------------------------------------------------------------
  // The value is wrapped (`{v: …}`) rather than stringified bare so that an
  // `undefined` value round-trips to `undefined` exactly as Dexie's
  // `row?.value` read does (JSON has no bare `undefined`).

  async metaGet<T = unknown>(key: string): Promise<T | undefined> {
    const rows = await this.driver.select<{ data: string }>(`SELECT data FROM meta WHERE key = ?`, [
      key,
    ])
    const first = rows[0]
    if (first === undefined) return undefined
    return (JSON.parse(first.data) as { v?: T }).v
  }

  async metaPut(key: string, value: unknown): Promise<void> {
    // ENG-168 (M6-4) fail-closed guard: this database file
    // (`projections.sqlite3`) lives INSIDE the portable workspace folder — the
    // folder users hand to `msgctl verify` / zip / sync. The bearer token must
    // NEVER be written into it, not even by accident: the AuthManager routes
    // the token through the SecretStore seam, and this guard makes any other
    // path a loud error instead of a silent credential leak.
    if (key === META_SESSION_TOKEN) {
      throw new Error(
        'SqliteDb.metaPut: refusing to store the session token in projections.sqlite3 ' +
          '(it sits inside the portable workspace folder); route it through the SecretStore (ENG-168)',
      )
    }
    await this.driver.execute(`INSERT OR REPLACE INTO meta (key, data) VALUES (?, ?)`, [
      key,
      JSON.stringify({ v: value }),
    ])
  }

  // -- events (source cache; evictable) --------------------------------------

  async putEvents(rows: readonly EventRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        await this.driver.execute(
          `INSERT OR REPLACE INTO events (stream_id, server_sequence, event_id, type, data)
           VALUES (?, ?, ?, ?, ?)`,
          [row.stream_id, row.server_sequence, row.event_id, row.type, JSON.stringify(row)],
        )
      }
    })
  }

  async listEventSequences(streamId: string): Promise<number[]> {
    const rows = await this.driver.select<{ server_sequence: number }>(
      `SELECT server_sequence FROM events WHERE stream_id = ? ORDER BY server_sequence ASC`,
      [streamId],
    )
    return rows.map((r) => r.server_sequence)
  }

  async deleteEventsBySequence(streamId: string, sequences: readonly number[]): Promise<void> {
    if (sequences.length === 0) return
    await this.driver.transaction(async () => {
      for (const chunk of chunked(sequences, CHUNK)) {
        await this.driver.execute(
          `DELETE FROM events WHERE stream_id = ? AND server_sequence IN (${placeholders(chunk.length)})`,
          [streamId, ...chunk],
        )
      }
    })
  }

  async minStoredSeq(streamId: string): Promise<number | undefined> {
    const rows = await this.driver.select<{ m: number | null }>(
      `SELECT MIN(server_sequence) AS m FROM events WHERE stream_id = ?`,
      [streamId],
    )
    return rows[0]?.m ?? undefined
  }

  async hasEvent(eventId: string): Promise<boolean> {
    const rows = await this.driver.select<{ one: number }>(
      `SELECT 1 AS one FROM events WHERE event_id = ? LIMIT 1`,
      [eventId],
    )
    return rows.length > 0
  }

  async listStreamIds(): Promise<string[]> {
    const rows = await this.driver.select<{ stream_id: string }>(
      `SELECT DISTINCT stream_id FROM events`,
    )
    return rows.map((r) => r.stream_id)
  }

  async getEventsForStream(streamId: string): Promise<EventRow[]> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM events WHERE stream_id = ? ORDER BY server_sequence ASC`,
      [streamId],
    )
    return parseRows<EventRow>(rows)
  }

  // -- cursors ----------------------------------------------------------------

  async getCursor(streamId: string): Promise<CursorRow | undefined> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM cursors WHERE stream_id = ?`,
      [streamId],
    )
    return parseRows<CursorRow>(rows)[0]
  }

  async listCursors(): Promise<CursorRow[]> {
    const rows = await this.driver.select<{ data: string }>(`SELECT data FROM cursors`)
    return parseRows<CursorRow>(rows)
  }

  async putCursors(rows: readonly CursorRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        await this.driver.execute(
          `INSERT OR REPLACE INTO cursors (stream_id, data) VALUES (?, ?)`,
          [row.stream_id, JSON.stringify(row)],
        )
      }
    })
  }

  // -- outbox (source; never evicted, never dropped) --------------------------

  async putOutbox(rows: readonly OutboxRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        await this.driver.execute(
          `INSERT OR REPLACE INTO outbox (event_id, created_at, data) VALUES (?, ?, ?)`,
          [row.event_id, row.created_at, JSON.stringify(row)],
        )
      }
    })
  }

  async listOutbox(): Promise<OutboxRow[]> {
    // Deterministic oldest-first (the drain key), event_id tiebreak.
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM outbox ORDER BY created_at ASC, event_id ASC`,
    )
    return parseRows<OutboxRow>(rows)
  }

  async getOutbox(eventId: string): Promise<OutboxRow | undefined> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM outbox WHERE event_id = ?`,
      [eventId],
    )
    return parseRows<OutboxRow>(rows)[0]
  }

  async deleteOutbox(eventId: string): Promise<void> {
    await this.driver.execute(`DELETE FROM outbox WHERE event_id = ?`, [eventId])
  }

  // -- messages (derived) ------------------------------------------------------

  async putMessages(rows: readonly MessageRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        // ENG-166 FTS maintenance, external-content pattern: an external-content
        // FTS5 table must be told the OLD values before its row changes (the
        // documented 'delete' command), so — all inside this one transaction —
        // (1) un-index the previous text if the message already exists, (2)
        // upsert the row, (3) index the new text against the FRESH rowid
        // (INSERT OR REPLACE deletes + re-inserts, assigning a new rowid).
        await this.deleteFtsRow(row.message_id)
        await this.driver.execute(
          `INSERT OR REPLACE INTO messages (message_id, stream_id, created_seq, thread_root_id, text, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            row.message_id,
            row.stream_id,
            row.created_seq,
            row.thread_root_id ?? null,
            row.text,
            JSON.stringify(row),
          ],
        )
        const fresh = await this.driver.select<{ rowid: number }>(
          `SELECT rowid FROM messages WHERE message_id = ?`,
          [row.message_id],
        )
        const rowid = fresh[0]?.rowid
        if (rowid !== undefined) {
          await this.driver.execute(`INSERT INTO messages_fts (rowid, text) VALUES (?, ?)`, [
            rowid,
            row.text,
          ])
        }
      }
    })
  }

  /**
   * Un-index a message's CURRENT text (the external-content FTS5 'delete'
   * command, which requires the old values). No-op when the message has no
   * row. Must run inside the same transaction as the row write it precedes.
   */
  private async deleteFtsRow(messageId: string): Promise<void> {
    const old = await this.driver.select<{ rowid: number; text: string }>(
      `SELECT rowid, text FROM messages WHERE message_id = ?`,
      [messageId],
    )
    const row = old[0]
    if (row === undefined) return
    await this.driver.execute(
      `INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', ?, ?)`,
      [row.rowid, row.text],
    )
  }

  async deleteMessage(messageId: string): Promise<void> {
    // ENG-166: un-index BEFORE the row delete ('delete' needs the old text),
    // same transaction — a message never lingers in the index after removal.
    await this.driver.transaction(async () => {
      await this.deleteFtsRow(messageId)
      await this.driver.execute(`DELETE FROM messages WHERE message_id = ?`, [messageId])
    })
  }

  async getMessage(messageId: string): Promise<MessageRow | undefined> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM messages WHERE message_id = ?`,
      [messageId],
    )
    return parseRows<MessageRow>(rows)[0]
  }

  async listMessagesByStream(
    streamId: string,
    opts: { beforeSeq?: number; limit: number },
  ): Promise<MessageRow[]> {
    // Upper bound is EXCLUSIVE when paginating (created_seq < beforeSeq) —
    // mirrors DexieDb.listMessagesByStream. DESC created_seq (newest first).
    const rows =
      opts.beforeSeq !== undefined
        ? await this.driver.select<{ data: string }>(
            `SELECT data FROM messages WHERE stream_id = ? AND created_seq < ?
             ORDER BY created_seq DESC LIMIT ?`,
            [streamId, opts.beforeSeq, opts.limit],
          )
        : await this.driver.select<{ data: string }>(
            `SELECT data FROM messages WHERE stream_id = ?
             ORDER BY created_seq DESC LIMIT ?`,
            [streamId, opts.limit],
          )
    return parseRows<MessageRow>(rows)
  }

  async getAllMessages(): Promise<MessageRow[]> {
    const rows = await this.driver.select<{ data: string }>(`SELECT data FROM messages`)
    return parseRows<MessageRow>(rows)
  }

  async listStreamMessagesAfter(streamId: string, afterSeq: number): Promise<MessageRow[]> {
    // Lower bound EXCLUSIVE (created_seq > afterSeq), ASC — mirrors DexieDb.
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM messages WHERE stream_id = ? AND created_seq > ?
       ORDER BY created_seq ASC`,
      [streamId, afterSeq],
    )
    return parseRows<MessageRow>(rows)
  }

  async listRepliesByRoot(rootMessageId: string): Promise<MessageRow[]> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM messages WHERE thread_root_id = ?`,
      [rootMessageId],
    )
    return parseRows<MessageRow>(rows)
  }

  /**
   * The local FTS read (ENG-166, M6-2) — `capabilities.fts` backs onto this.
   * `opts.match` arrives ALREADY sanitized (searchLocalMessages quotes every
   * unit) and is bound as a parameter, never interpolated. Ranked best-first
   * by `bm25(messages_fts)` (SQLite bm25 is smaller-is-better, so ASC), tied
   * broken by `created_seq DESC` then `message_id DESC` — a total order, so
   * OFFSET pagination is stable. Excludes tombstones (redacted text can never
   * match, but the guard is explicit — mirrors the server `deleted == False`)
   * and pending/failed optimistic rows (server FTS can never return one; their
   * sentinel `created_seq` would also corrupt the before/after bounds).
   */
  async searchMessagesFts(opts: FtsSearchOptions): Promise<SearchHit[]> {
    const conditions: string[] = [
      `COALESCE(json_extract(m.data, '$.deleted'), 0) = 0`,
      `json_extract(m.data, '$.state') IS NULL`,
    ]
    const params: SqlValue[] = [opts.match]
    if (opts.streamId !== undefined) {
      conditions.push(`m.stream_id = ?`)
      params.push(opts.streamId)
    }
    if (opts.authorUserId !== undefined) {
      conditions.push(`json_extract(m.data, '$.author_user_id') = ?`)
      params.push(opts.authorUserId)
    }
    if (opts.beforeSeq !== undefined) {
      conditions.push(`m.created_seq < ?`)
      params.push(opts.beforeSeq)
    }
    if (opts.afterSeq !== undefined) {
      conditions.push(`m.created_seq > ?`)
      params.push(opts.afterSeq)
    }
    params.push(opts.limit, opts.offset)
    const rows = await this.driver.select<{ data: string; score: number }>(
      `SELECT m.data AS data, bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND ${conditions.join(' AND ')}
       ORDER BY bm25(messages_fts) ASC, m.created_seq DESC, m.message_id DESC
       LIMIT ? OFFSET ?`,
      params,
    )
    return rows.map((r) => {
      const row = JSON.parse(r.data) as MessageRow
      return {
        message_id: row.message_id,
        stream_id: row.stream_id,
        author_user_id: row.author_user_id,
        text: row.text,
        created_seq: row.created_seq,
        // bm25 is smaller-is-better (negative for a match); negate so `rank`
        // keeps the server convention (ts_rank_cd: HIGHER = more relevant).
        rank: -r.score,
        thread_root_id: row.thread_root_id ?? null,
      }
    })
  }

  // -- reactions (ENG-100 seq-aware LWW mirror) --------------------------------

  async putReactions(rows: readonly ReactionRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        await this.driver.execute(
          `INSERT OR REPLACE INTO reactions (message_id, author_user_id, emoji, data)
           VALUES (?, ?, ?, ?)`,
          [row.message_id, row.author_user_id, row.emoji, JSON.stringify(row)],
        )
      }
    })
  }

  async getReaction(
    messageId: string,
    authorUserId: string,
    emoji: string,
  ): Promise<ReactionRow | undefined> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM reactions WHERE message_id = ? AND author_user_id = ? AND emoji = ?`,
      [messageId, authorUserId, emoji],
    )
    return parseRows<ReactionRow>(rows)[0]
  }

  async getReactionsForMessage(messageId: string): Promise<ReactionRow[]> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM reactions WHERE message_id = ?`,
      [messageId],
    )
    // Observable = present only (tombstones excluded), same as DexieDb.
    return parseRows<ReactionRow>(rows).filter((r) => r.present)
  }

  async deleteReactionsForMessage(messageId: string): Promise<void> {
    await this.driver.execute(`DELETE FROM reactions WHERE message_id = ?`, [messageId])
  }

  async getAllReactions(): Promise<ReactionRow[]> {
    const rows = await this.driver.select<{ data: string }>(`SELECT data FROM reactions`)
    return parseRows<ReactionRow>(rows)
  }

  // -- thread participants (ENG-100 recompute-from-state set) -------------------

  async putThreadParticipants(rows: readonly ThreadParticipantRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        await this.driver.execute(
          `INSERT OR REPLACE INTO thread_participants (root_message_id, user_id, data)
           VALUES (?, ?, ?)`,
          [row.root_message_id, row.user_id, JSON.stringify(row)],
        )
      }
    })
  }

  async deleteThreadParticipantsForRoot(rootMessageId: string): Promise<void> {
    await this.driver.execute(`DELETE FROM thread_participants WHERE root_message_id = ?`, [
      rootMessageId,
    ])
  }

  async getAllThreadParticipants(): Promise<ThreadParticipantRow[]> {
    const rows = await this.driver.select<{ data: string }>(`SELECT data FROM thread_participants`)
    return parseRows<ThreadParticipantRow>(rows)
  }

  async listThreadParticipantsByRoot(rootMessageId: string): Promise<ThreadParticipantRow[]> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM thread_participants WHERE root_message_id = ?`,
      [rootMessageId],
    )
    return parseRows<ThreadParticipantRow>(rows)
  }

  // -- files (ENG-120 keyed upsert mirror) ---------------------------------------

  async putFiles(rows: readonly FileRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        await this.driver.execute(
          `INSERT OR REPLACE INTO files (file_id, stream_id, data) VALUES (?, ?, ?)`,
          [row.file_id, row.stream_id, JSON.stringify(row)],
        )
      }
    })
  }

  async getFile(fileId: string): Promise<FileRow | undefined> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM files WHERE file_id = ?`,
      [fileId],
    )
    return parseRows<FileRow>(rows)[0]
  }

  async getFilesByIds(fileIds: readonly string[]): Promise<FileRow[]> {
    if (fileIds.length === 0) return []
    const byId = new Map<string, FileRow>()
    for (const chunk of chunked(fileIds, CHUNK)) {
      const rows = await this.driver.select<{ data: string }>(
        `SELECT data FROM files WHERE file_id IN (${placeholders(chunk.length)})`,
        chunk,
      )
      for (const row of parseRows<FileRow>(rows)) byId.set(row.file_id, row)
    }
    // Input order, misses silently dropped — mirrors DexieDb's bulkGet+filter.
    const out: FileRow[] = []
    for (const id of fileIds) {
      const row = byId.get(id)
      if (row !== undefined) out.push(row)
    }
    return out
  }

  async getAllFiles(): Promise<FileRow[]> {
    const rows = await this.driver.select<{ data: string }>(`SELECT data FROM files`)
    return parseRows<FileRow>(rows)
  }

  // -- streams (derived echo of /v1/sync) ----------------------------------------

  async putStreams(rows: readonly StreamRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        await this.driver.execute(
          `INSERT OR REPLACE INTO streams (stream_id, kind, data) VALUES (?, ?, ?)`,
          [row.stream_id, row.kind, JSON.stringify(row)],
        )
      }
    })
  }

  async listStreams(): Promise<StreamRow[]> {
    const rows = await this.driver.select<{ data: string }>(`SELECT data FROM streams`)
    return parseRows<StreamRow>(rows)
  }

  async getStream(streamId: string): Promise<StreamRow | undefined> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM streams WHERE stream_id = ?`,
      [streamId],
    )
    return parseRows<StreamRow>(rows)[0]
  }

  async bumpStreamHead(streamId: string, seq: number): Promise<boolean> {
    // ENG-150 GREATEST compare-and-set as ONE statement — natively atomic in
    // SQLite (no read-modify-write window at all, vs. the Dexie rw-txn). The
    // guard `json_extract(...) < ?` makes a lower/equal seq a no-op, and a
    // missing row matches no WHERE — never fabricated (mirrors DexieDb).
    // `json_set` rewrites only `$.head_seq`; every other column of the stored
    // row survives verbatim.
    const rows = await this.driver.select<{ stream_id: string }>(
      `UPDATE streams SET data = json_set(data, '$.head_seq', ?)
       WHERE stream_id = ? AND json_extract(data, '$.head_seq') < ?
       RETURNING stream_id`,
      [seq, streamId, seq],
    )
    return rows.length > 0
  }

  // -- read_state (ENG-123/126 synced-KV; rebuild-exempt) --------------------------

  async putReadState(rows: readonly ReadStateRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        await this.driver.execute(
          `INSERT OR REPLACE INTO read_state (stream_id, last_read_seq) VALUES (?, ?)`,
          [row.stream_id, row.last_read_seq],
        )
      }
    })
  }

  async upsertReadStateMonotonic(streamId: string, seq: number): Promise<boolean> {
    // ENG-126 GREATEST compare-and-set as ONE upsert statement — natively
    // atomic (insert when absent; update only when strictly higher). RETURNING
    // yields a row iff the write happened, i.e. iff the marker advanced.
    const rows = await this.driver.select<{ stream_id: string }>(
      `INSERT INTO read_state (stream_id, last_read_seq) VALUES (?, ?)
       ON CONFLICT (stream_id) DO UPDATE SET last_read_seq = excluded.last_read_seq
       WHERE excluded.last_read_seq > read_state.last_read_seq
       RETURNING stream_id`,
      [streamId, seq],
    )
    return rows.length > 0
  }

  async listReadState(): Promise<ReadStateRow[]> {
    return this.driver.select<ReadStateRow>(`SELECT stream_id, last_read_seq FROM read_state`)
  }

  async getReadState(streamId: string): Promise<ReadStateRow | undefined> {
    const rows = await this.driver.select<ReadStateRow>(
      `SELECT stream_id, last_read_seq FROM read_state WHERE stream_id = ?`,
      [streamId],
    )
    return rows[0]
  }

  // -- prefs (ENG-126 synced-KV; rebuild-exempt) ------------------------------------

  async putPrefs(rows: readonly PrefsRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.driver.transaction(async () => {
      for (const row of rows) {
        await this.driver.execute(`INSERT OR REPLACE INTO prefs (stream_id, data) VALUES (?, ?)`, [
          row.stream_id,
          JSON.stringify(row),
        ])
      }
    })
  }

  async listPrefs(): Promise<PrefsRow[]> {
    const rows = await this.driver.select<{ data: string }>(`SELECT data FROM prefs`)
    return parseRows<PrefsRow>(rows)
  }

  async getPrefs(streamId: string): Promise<PrefsRow | undefined> {
    const rows = await this.driver.select<{ data: string }>(
      `SELECT data FROM prefs WHERE stream_id = ?`,
      [streamId],
    )
    return parseRows<PrefsRow>(rows)[0]
  }

  // -- wipes ---------------------------------------------------------------------

  async clearDerivedTables(): Promise<void> {
    // ENG-126: `read_state` + `prefs` are synced-KV, NOT derived — a projection
    // rebuild must PRESERVE them (mirrors DexieDb.clearDerivedTables). `events`
    // and `outbox` are source tables and likewise untouched.
    await this.driver.transaction(async () => {
      // ENG-166: wipe the FTS index with the table it shadows ('delete-all' is
      // the external-content bulk wipe) — the rebuild then reconstructs it
      // through putMessages, so rebuild ≡ incremental holds for search too.
      await this.driver.execute(`INSERT INTO messages_fts (messages_fts) VALUES ('delete-all')`)
      await this.driver.execute(`DELETE FROM messages`)
      await this.driver.execute(`DELETE FROM reactions`)
      await this.driver.execute(`DELETE FROM thread_participants`)
      await this.driver.execute(`DELETE FROM files`)
      await this.driver.execute(`DELETE FROM streams`)
      await this.driver.execute(`DELETE FROM cursors`)
    })
  }

  async clearSyncedKv(): Promise<void> {
    // Logout hygiene (ENG-126) — wipe synced-KV; SEPARATE from clearDerivedTables.
    await this.driver.transaction(async () => {
      await this.driver.execute(`DELETE FROM read_state`)
      await this.driver.execute(`DELETE FROM prefs`)
    })
  }

  // -- plumbing --------------------------------------------------------------------

  async count(table: TableName): Promise<number> {
    if (!TABLES.includes(table)) {
      throw new Error(`unknown table: ${String(table)}`)
    }
    // `table` is whitelist-validated above; interpolation is safe.
    const rows = await this.driver.select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    return rows[0]?.n ?? 0
  }

  async close(): Promise<void> {
    await this.driver.close()
  }
}

// ---------------------------------------------------------------------------
// Factory — mirrors `openDb` (db.ts). Accepts either a ready SqlDriver (the
// Tauri path, M6) or a filesystem path (Node/test convenience: lazily loads
// the better-sqlite3 driver — a DYNAMIC import so this module stays free of
// any static native-module dependency and is never a bundling hazard).
// ---------------------------------------------------------------------------

export async function openSqliteDb(driverOrPath: SqlDriver | string): Promise<SqliteDb> {
  let driver: SqlDriver
  if (typeof driverOrPath === 'string') {
    // M6-5: this module is now reachable from the (lazy) Tauri boot chunk, so
    // the Node-only branch must stay INVISIBLE to the bundler: a variable
    // specifier (+ @vite-ignore) is non-analyzable, keeping better-sqlite3 (a
    // native module) out of every emitted chunk. The string-path branch runs
    // only under Node (vitest / headless CI), where the runtime dynamic
    // import resolves normally.
    const nodeDriverModule = './node-driver'
    const { NodeSqlDriver } = (await import(
      /* @vite-ignore */ nodeDriverModule
    )) as typeof import('./node-driver')
    driver = new NodeSqlDriver(driverOrPath)
  } else {
    driver = driverOrPath
  }
  // Durability posture for the desktop file DB (both are harmless no-ops on
  // `:memory:`): WAL for concurrent-read friendliness, NORMAL sync (safe with
  // WAL; a power loss can lose the last commit, never corrupt the file).
  await driver.execute(`PRAGMA journal_mode=WAL`)
  await driver.execute(`PRAGMA synchronous=NORMAL`)
  for (const stmt of SCHEMA_STATEMENTS) {
    await driver.execute(stmt)
  }
  return new SqliteDb(driver)
}
