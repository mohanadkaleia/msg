// worker/db.ts — the Dexie schema (§5.2, verbatim) + the MsgDb persistence
// abstraction (D-4) and graceful-degradation boot (D-5).
//
// Two independent version numbers:
//   • Dexie `version(1)`      — the IndexedDB index layout (below, verbatim).
//   • PROJECTION_VERSION      — derived-table validity (types.ts); a mismatch
//                               drops + rebuilds derived tables, never events.

import Dexie, { type DexieOptions, type Table } from 'dexie'

import { applyOutboxToProjection } from './outbox'
import { rebuildMessagesProjection } from './projection'
import {
  DERIVED_TABLES,
  META_PROJECTION_VERSION,
  PROJECTION_VERSION,
  type CursorRow,
  type EventRow,
  type FileRow,
  type MessageRow,
  type MetaRow,
  type MsgDb,
  type OutboxRow,
  type PrefsRow,
  type ReactionRow,
  type ReadStateRow,
  type StreamRow,
  type TableName,
  type ThreadParticipantRow,
} from './types'

/** Guard against engines that hang the IndexedDB open (D-5). */
const OPEN_TIMEOUT_MS = 3000

// ---------------------------------------------------------------------------
// Dexie subclass — §5.2 schema, verbatim. Indexes are load-bearing; do not
// drift them without bumping the Dexie version and adding an `.upgrade()`.
// ---------------------------------------------------------------------------

export class MsgDB extends Dexie {
  events!: Table<EventRow, [string, number]>
  messages!: Table<MessageRow, string>
  reactions!: Table<ReactionRow, [string, string, string]>
  thread_participants!: Table<ThreadParticipantRow, [string, string]>
  files!: Table<FileRow, string>
  streams!: Table<StreamRow, string>
  cursors!: Table<CursorRow, string>
  outbox!: Table<OutboxRow, string>
  read_state!: Table<ReadStateRow, string>
  prefs!: Table<PrefsRow, string>
  meta!: Table<MetaRow, string>

  constructor(options?: DexieOptions) {
    super('msg', options)
    this.version(1).stores({
      events: '[stream_id+server_sequence], event_id, type',
      messages: 'message_id, stream_id, [stream_id+created_seq], thread_root_id',
      streams: 'stream_id, kind',
      cursors: 'stream_id',
      outbox: 'event_id, created_at',
      read_state: 'stream_id',
      meta: 'key',
    })
    // ENG-100 (M3): the `reactions` set (row per (message_id, author_user_id,
    // emoji) — `emoji` an exact-byte key component) + the `thread_participants`
    // set (row per (root_message_id, user_id)). Additive tables only; the
    // existing indexes are unchanged (Dexie carries them forward), so no
    // `.upgrade()` data migration is needed — a shape/handler change is handled
    // by the PROJECTION_VERSION bump (drop + rebuild derived tables).
    this.version(2).stores({
      reactions: '[message_id+author_user_id+emoji], message_id',
      thread_participants: '[root_message_id+user_id], root_message_id',
    })
    // ENG-120: the `files` set — one row per uploaded file, PK `file_id`
    // (immutable keyed upsert; a re-apply is byte-identical) + a `stream_id`
    // secondary index. Additive table only; the existing indexes are unchanged
    // (Dexie carries them forward), so no `.upgrade()` data migration is needed —
    // the PROJECTION_VERSION bump (4 → 5) drops + rebuilds the derived tables,
    // which populates `files` from the cached `file.uploaded` events on boot.
    this.version(3).stores({
      files: 'file_id, stream_id',
    })
    // ENG-126: the `prefs` synced-KV table — one row per `stream_id` (the LWW
    // notification level pulled from `/v1/prefs`). Additive table only; the
    // existing indexes are unchanged (Dexie carries them forward), so NO
    // `.upgrade()` data migration is needed. Critically this is a Dexie
    // INDEX-LAYOUT bump ONLY — it does NOT (and must not) bump PROJECTION_VERSION:
    // `prefs` is server-authoritative synced state, not a derived table, so it is
    // NOT dropped/rebuilt on a projection-version change (see types.ts D3).
    this.version(4).stores({
      prefs: 'stream_id',
    })
  }
}

// ---------------------------------------------------------------------------
// DexieDb — the persistent MsgDb implementation. Wraps MsgDB; Dexie's richer
// fluent API stays inside this class, callers see only the MsgDb interface.
// ---------------------------------------------------------------------------

export class DexieDb implements MsgDb {
  readonly persistence = 'persistent' as const
  /** ENG-165: no local FTS — search stays the server HTTP call on this backend. */
  readonly capabilities = { fts: false } as const

  constructor(private readonly db: MsgDB) {}

  async metaGet<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.db.meta.get(key)
    return row?.value as T | undefined
  }

  async metaPut(key: string, value: unknown): Promise<void> {
    await this.db.meta.put({ key, value })
  }

  async putEvents(rows: readonly EventRow[]): Promise<void> {
    await this.db.events.bulkPut([...rows])
  }

  async listEventSequences(streamId: string): Promise<number[]> {
    // The compound `[stream_id+server_sequence]` index yields keys already
    // ordered by server_sequence ascending within the stream.
    const keys = await this.db.events
      .where('[stream_id+server_sequence]')
      .between([streamId, Dexie.minKey], [streamId, Dexie.maxKey])
      .primaryKeys()
    return keys.map((k) => k[1])
  }

  async deleteEventsBySequence(streamId: string, sequences: readonly number[]): Promise<void> {
    await this.db.events.bulkDelete(sequences.map((s): [string, number] => [streamId, s]))
  }

  async minStoredSeq(streamId: string): Promise<number | undefined> {
    const first = await this.db.events
      .where('[stream_id+server_sequence]')
      .between([streamId, Dexie.minKey], [streamId, Dexie.maxKey])
      .first()
    return first?.server_sequence
  }

  async getCursor(streamId: string): Promise<CursorRow | undefined> {
    return this.db.cursors.get(streamId)
  }

  async listCursors(): Promise<CursorRow[]> {
    return this.db.cursors.toArray()
  }

  async listStreams(): Promise<StreamRow[]> {
    return this.db.streams.toArray()
  }

  async getStream(streamId: string): Promise<StreamRow | undefined> {
    return this.db.streams.get(streamId)
  }

  async putOutbox(rows: readonly OutboxRow[]): Promise<void> {
    await this.db.outbox.bulkPut([...rows])
  }

  async listOutbox(): Promise<OutboxRow[]> {
    return this.db.outbox.toArray()
  }

  async getOutbox(eventId: string): Promise<OutboxRow | undefined> {
    return this.db.outbox.get(eventId)
  }

  async deleteOutbox(eventId: string): Promise<void> {
    await this.db.outbox.delete(eventId)
  }

  async hasEvent(eventId: string): Promise<boolean> {
    return (await this.db.events.where('event_id').equals(eventId).count()) > 0
  }

  async putMessages(rows: readonly MessageRow[]): Promise<void> {
    await this.db.messages.bulkPut([...rows])
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.db.messages.delete(messageId)
  }

  // -- ENG-100 reactions + thread participants -----------------------------

  async putReactions(rows: readonly ReactionRow[]): Promise<void> {
    await this.db.reactions.bulkPut([...rows])
  }

  async getReaction(
    messageId: string,
    authorUserId: string,
    emoji: string,
  ): Promise<ReactionRow | undefined> {
    return this.db.reactions.get([messageId, authorUserId, emoji])
  }

  async getReactionsForMessage(messageId: string): Promise<ReactionRow[]> {
    const rows = await this.db.reactions.where('message_id').equals(messageId).toArray()
    return rows.filter((r) => r.present) // observable = present only
  }

  async deleteReactionsForMessage(messageId: string): Promise<void> {
    await this.db.reactions.where('message_id').equals(messageId).delete()
  }

  async getAllReactions(): Promise<ReactionRow[]> {
    return this.db.reactions.toArray()
  }

  async putThreadParticipants(rows: readonly ThreadParticipantRow[]): Promise<void> {
    await this.db.thread_participants.bulkPut([...rows])
  }

  async deleteThreadParticipantsForRoot(rootMessageId: string): Promise<void> {
    await this.db.thread_participants.where('root_message_id').equals(rootMessageId).delete()
  }

  async getAllThreadParticipants(): Promise<ThreadParticipantRow[]> {
    return this.db.thread_participants.toArray()
  }

  async listThreadParticipantsByRoot(rootMessageId: string): Promise<ThreadParticipantRow[]> {
    return this.db.thread_participants.where('root_message_id').equals(rootMessageId).toArray()
  }

  async listRepliesByRoot(rootMessageId: string): Promise<MessageRow[]> {
    return this.db.messages.where('thread_root_id').equals(rootMessageId).toArray()
  }

  // -- ENG-120 files (keyed upsert; mirror of `file.uploaded`) --------------

  async putFiles(rows: readonly FileRow[]): Promise<void> {
    await this.db.files.bulkPut([...rows])
  }

  async getFile(fileId: string): Promise<FileRow | undefined> {
    return this.db.files.get(fileId)
  }

  async getFilesByIds(fileIds: readonly string[]): Promise<FileRow[]> {
    // `bulkGet` returns an entry per id (undefined for a miss); drop the misses
    // so callers get only the PRESENT rows (pending ids are computed by the query).
    const rows = await this.db.files.bulkGet([...fileIds])
    return rows.filter((r): r is FileRow => r !== undefined)
  }

  async getAllFiles(): Promise<FileRow[]> {
    return this.db.files.toArray()
  }

  async putStreams(rows: readonly StreamRow[]): Promise<void> {
    await this.db.streams.bulkPut([...rows])
  }

  async bumpStreamHead(streamId: string, seq: number): Promise<boolean> {
    // ENG-150: read-modify-write inside ONE rw transaction so the GREATEST check
    // and the write are atomic (mirrors upsertReadStateMonotonic) — head_seq only
    // ever moves UP. A missing row is a no-op: `/v1/sync` authors stream rows.
    return this.db.transaction('rw', this.db.streams, async () => {
      const existing = await this.db.streams.get(streamId)
      if (!existing || seq <= existing.head_seq) return false
      await this.db.streams.put({ ...existing, head_seq: seq })
      return true
    })
  }

  async putCursors(rows: readonly CursorRow[]): Promise<void> {
    await this.db.cursors.bulkPut([...rows])
  }

  async putReadState(rows: readonly ReadStateRow[]): Promise<void> {
    await this.db.read_state.bulkPut([...rows])
  }

  async upsertReadStateMonotonic(streamId: string, seq: number): Promise<boolean> {
    // Read-modify-write inside ONE rw transaction so the GREATEST check and the
    // write are atomic — no interleave can let a lower seq clobber a higher one.
    return this.db.transaction('rw', this.db.read_state, async () => {
      const existing = await this.db.read_state.get(streamId)
      const stored = existing?.last_read_seq ?? -1
      if (seq <= stored) return false
      await this.db.read_state.put({ stream_id: streamId, last_read_seq: seq })
      return true
    })
  }

  async putPrefs(rows: readonly PrefsRow[]): Promise<void> {
    await this.db.prefs.bulkPut([...rows])
  }

  async listPrefs(): Promise<PrefsRow[]> {
    return this.db.prefs.toArray()
  }

  async getPrefs(streamId: string): Promise<PrefsRow | undefined> {
    return this.db.prefs.get(streamId)
  }

  async clearDerivedTables(): Promise<void> {
    // ENG-126: `read_state` (and `prefs`) are NOT cleared here — they are
    // synced-KV, not derived from `events`, so a projection rebuild must PRESERVE
    // them (they are refilled from `/v1/read-state` + `/v1/prefs`, not replay).
    await this.db.transaction(
      'rw',
      [
        this.db.messages,
        this.db.reactions,
        this.db.thread_participants,
        this.db.files,
        this.db.streams,
        this.db.cursors,
      ],
      async () => {
        await Promise.all([
          this.db.messages.clear(),
          this.db.reactions.clear(),
          this.db.thread_participants.clear(),
          this.db.files.clear(),
          this.db.streams.clear(),
          this.db.cursors.clear(),
        ])
      },
    )
  }

  async clearSyncedKv(): Promise<void> {
    // Logout hygiene (ENG-126): a shared machine must not leak the previous user's
    // read positions / notification levels. Distinct from clearDerivedTables — a
    // projection rebuild keeps these; a logout wipes them.
    await this.db.transaction('rw', [this.db.read_state, this.db.prefs], async () => {
      await Promise.all([this.db.read_state.clear(), this.db.prefs.clear()])
    })
  }

  // -- ENG-80 projection reads (fluent Dexie, index-bounded) ---------------

  async listStreamIds(): Promise<string[]> {
    // Read only the compound primary keys (never full rows), dedupe the stream id.
    const pks = await this.db.events.toCollection().primaryKeys()
    return [...new Set(pks.map((k) => k[0]))]
  }

  async getEventsForStream(streamId: string): Promise<EventRow[]> {
    // The compound index yields rows ascending by server_sequence within a stream.
    return this.db.events
      .where('[stream_id+server_sequence]')
      .between([streamId, Dexie.minKey], [streamId, Dexie.maxKey])
      .toArray()
  }

  async getMessage(messageId: string): Promise<MessageRow | undefined> {
    return this.db.messages.get(messageId)
  }

  async listMessagesByStream(
    streamId: string,
    opts: { beforeSeq?: number; limit: number },
  ): Promise<MessageRow[]> {
    const upper: [string, number | typeof Dexie.maxKey] =
      opts.beforeSeq !== undefined ? [streamId, opts.beforeSeq] : [streamId, Dexie.maxKey]
    // Upper bound is EXCLUSIVE when paginating by before_seq (created_seq < beforeSeq).
    const includeUpper = opts.beforeSeq === undefined
    return this.db.messages
      .where('[stream_id+created_seq]')
      .between([streamId, Dexie.minKey], upper, true, includeUpper)
      .reverse() // DESC created_seq (newest first)
      .limit(opts.limit)
      .toArray()
  }

  async getAllMessages(): Promise<MessageRow[]> {
    return this.db.messages.toArray()
  }

  async listReadState(): Promise<ReadStateRow[]> {
    return this.db.read_state.toArray()
  }

  async getReadState(streamId: string): Promise<ReadStateRow | undefined> {
    return this.db.read_state.get(streamId)
  }

  async listStreamMessagesAfter(streamId: string, afterSeq: number): Promise<MessageRow[]> {
    // Lower bound EXCLUSIVE (created_seq > afterSeq); bounded by the compound index.
    return this.db.messages
      .where('[stream_id+created_seq]')
      .between([streamId, afterSeq], [streamId, Dexie.maxKey], false, true)
      .toArray()
  }

  async count(table: TableName): Promise<number> {
    switch (table) {
      case 'events':
        return this.db.events.count()
      case 'messages':
        return this.db.messages.count()
      case 'reactions':
        return this.db.reactions.count()
      case 'thread_participants':
        return this.db.thread_participants.count()
      case 'files':
        return this.db.files.count()
      case 'streams':
        return this.db.streams.count()
      case 'cursors':
        return this.db.cursors.count()
      case 'outbox':
        return this.db.outbox.count()
      case 'read_state':
        return this.db.read_state.count()
      case 'prefs':
        return this.db.prefs.count()
      case 'meta':
        return this.db.meta.count()
      default:
        throw new Error(`unknown table: ${String(table)}`)
    }
  }

  close(): Promise<void> {
    this.db.close()
    return Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// MemoryDb — Map-backed fallback (D-5) + fastest unit-test double. No
// persistence; everything still works online.
// ---------------------------------------------------------------------------

export class MemoryDb implements MsgDb {
  readonly persistence = 'memory' as const
  /** ENG-165: no local FTS — search stays the server HTTP call on this backend. */
  readonly capabilities = { fts: false } as const

  private readonly metaMap = new Map<string, unknown>()
  private readonly eventsMap = new Map<string, EventRow>()
  private readonly outboxMap = new Map<string, OutboxRow>()
  private readonly messagesMap = new Map<string, MessageRow>()
  private readonly reactionsMap = new Map<string, ReactionRow>()
  private readonly participantsMap = new Map<string, ThreadParticipantRow>()
  private readonly filesMap = new Map<string, FileRow>()
  private readonly streamsMap = new Map<string, StreamRow>()
  private readonly cursorsMap = new Map<string, CursorRow>()
  private readonly readStateMap = new Map<string, ReadStateRow>()
  private readonly prefsMap = new Map<string, PrefsRow>()

  private static eventKey(streamId: string, seq: number): string {
    return `${streamId}::${seq}`
  }

  // JSON-array key: collision-free even when `emoji` contains any byte
  // (separators, control chars) — the emoji domain is opaque bytes.
  private static reactionKey(messageId: string, authorUserId: string, emoji: string): string {
    return JSON.stringify([messageId, authorUserId, emoji])
  }

  private static participantKey(rootMessageId: string, userId: string): string {
    return JSON.stringify([rootMessageId, userId])
  }

  metaGet<T = unknown>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.metaMap.get(key) as T | undefined)
  }

  metaPut(key: string, value: unknown): Promise<void> {
    this.metaMap.set(key, value)
    return Promise.resolve()
  }

  putEvents(rows: readonly EventRow[]): Promise<void> {
    for (const row of rows) {
      this.eventsMap.set(MemoryDb.eventKey(row.stream_id, row.server_sequence), row)
    }
    return Promise.resolve()
  }

  listEventSequences(streamId: string): Promise<number[]> {
    const seqs = [...this.eventsMap.values()]
      .filter((r) => r.stream_id === streamId)
      .map((r) => r.server_sequence)
      .sort((a, b) => a - b)
    return Promise.resolve(seqs)
  }

  deleteEventsBySequence(streamId: string, sequences: readonly number[]): Promise<void> {
    for (const seq of sequences) {
      this.eventsMap.delete(MemoryDb.eventKey(streamId, seq))
    }
    return Promise.resolve()
  }

  minStoredSeq(streamId: string): Promise<number | undefined> {
    let min: number | undefined
    for (const r of this.eventsMap.values()) {
      if (r.stream_id !== streamId) continue
      if (min === undefined || r.server_sequence < min) min = r.server_sequence
    }
    return Promise.resolve(min)
  }

  getCursor(streamId: string): Promise<CursorRow | undefined> {
    return Promise.resolve(this.cursorsMap.get(streamId))
  }

  listCursors(): Promise<CursorRow[]> {
    return Promise.resolve([...this.cursorsMap.values()])
  }

  listStreams(): Promise<StreamRow[]> {
    return Promise.resolve([...this.streamsMap.values()])
  }

  getStream(streamId: string): Promise<StreamRow | undefined> {
    return Promise.resolve(this.streamsMap.get(streamId))
  }

  putOutbox(rows: readonly OutboxRow[]): Promise<void> {
    for (const row of rows) {
      this.outboxMap.set(row.event_id, row)
    }
    return Promise.resolve()
  }

  listOutbox(): Promise<OutboxRow[]> {
    return Promise.resolve([...this.outboxMap.values()])
  }

  getOutbox(eventId: string): Promise<OutboxRow | undefined> {
    return Promise.resolve(this.outboxMap.get(eventId))
  }

  deleteOutbox(eventId: string): Promise<void> {
    this.outboxMap.delete(eventId)
    return Promise.resolve()
  }

  hasEvent(eventId: string): Promise<boolean> {
    for (const row of this.eventsMap.values()) {
      if (row.event_id === eventId) return Promise.resolve(true)
    }
    return Promise.resolve(false)
  }

  putMessages(rows: readonly MessageRow[]): Promise<void> {
    for (const row of rows) this.messagesMap.set(row.message_id, row)
    return Promise.resolve()
  }

  deleteMessage(messageId: string): Promise<void> {
    this.messagesMap.delete(messageId)
    return Promise.resolve()
  }

  // -- ENG-100 reactions + thread participants -----------------------------

  putReactions(rows: readonly ReactionRow[]): Promise<void> {
    for (const r of rows) {
      this.reactionsMap.set(MemoryDb.reactionKey(r.message_id, r.author_user_id, r.emoji), r)
    }
    return Promise.resolve()
  }

  getReaction(
    messageId: string,
    authorUserId: string,
    emoji: string,
  ): Promise<ReactionRow | undefined> {
    return Promise.resolve(
      this.reactionsMap.get(MemoryDb.reactionKey(messageId, authorUserId, emoji)),
    )
  }

  getReactionsForMessage(messageId: string): Promise<ReactionRow[]> {
    return Promise.resolve(
      [...this.reactionsMap.values()].filter((r) => r.message_id === messageId && r.present),
    )
  }

  deleteReactionsForMessage(messageId: string): Promise<void> {
    for (const [key, r] of this.reactionsMap) {
      if (r.message_id === messageId) this.reactionsMap.delete(key)
    }
    return Promise.resolve()
  }

  getAllReactions(): Promise<ReactionRow[]> {
    return Promise.resolve([...this.reactionsMap.values()])
  }

  putThreadParticipants(rows: readonly ThreadParticipantRow[]): Promise<void> {
    for (const r of rows) {
      this.participantsMap.set(MemoryDb.participantKey(r.root_message_id, r.user_id), r)
    }
    return Promise.resolve()
  }

  deleteThreadParticipantsForRoot(rootMessageId: string): Promise<void> {
    for (const [key, r] of this.participantsMap) {
      if (r.root_message_id === rootMessageId) this.participantsMap.delete(key)
    }
    return Promise.resolve()
  }

  getAllThreadParticipants(): Promise<ThreadParticipantRow[]> {
    return Promise.resolve([...this.participantsMap.values()])
  }

  listThreadParticipantsByRoot(rootMessageId: string): Promise<ThreadParticipantRow[]> {
    return Promise.resolve(
      [...this.participantsMap.values()].filter((r) => r.root_message_id === rootMessageId),
    )
  }

  listRepliesByRoot(rootMessageId: string): Promise<MessageRow[]> {
    return Promise.resolve(
      [...this.messagesMap.values()].filter((m) => m.thread_root_id === rootMessageId),
    )
  }

  // -- ENG-120 files (keyed upsert; same shapes as DexieDb) -----------------

  putFiles(rows: readonly FileRow[]): Promise<void> {
    for (const row of rows) this.filesMap.set(row.file_id, row)
    return Promise.resolve()
  }

  getFile(fileId: string): Promise<FileRow | undefined> {
    return Promise.resolve(this.filesMap.get(fileId))
  }

  getFilesByIds(fileIds: readonly string[]): Promise<FileRow[]> {
    const rows: FileRow[] = []
    for (const id of fileIds) {
      const row = this.filesMap.get(id)
      if (row !== undefined) rows.push(row)
    }
    return Promise.resolve(rows)
  }

  getAllFiles(): Promise<FileRow[]> {
    return Promise.resolve([...this.filesMap.values()])
  }

  putStreams(rows: readonly StreamRow[]): Promise<void> {
    for (const row of rows) this.streamsMap.set(row.stream_id, row)
    return Promise.resolve()
  }

  bumpStreamHead(streamId: string, seq: number): Promise<boolean> {
    // ENG-150: synchronous Map access is naturally atomic — no await between the
    // GREATEST check and the write (mirrors the Dexie txn). Missing row → no-op.
    const existing = this.streamsMap.get(streamId)
    if (!existing || seq <= existing.head_seq) return Promise.resolve(false)
    this.streamsMap.set(streamId, { ...existing, head_seq: seq })
    return Promise.resolve(true)
  }

  putCursors(rows: readonly CursorRow[]): Promise<void> {
    for (const row of rows) this.cursorsMap.set(row.stream_id, row)
    return Promise.resolve()
  }

  putReadState(rows: readonly ReadStateRow[]): Promise<void> {
    for (const row of rows) this.readStateMap.set(row.stream_id, row)
    return Promise.resolve()
  }

  upsertReadStateMonotonic(streamId: string, seq: number): Promise<boolean> {
    // Synchronous Map access is naturally atomic — no await between read + write,
    // so the GREATEST compare-and-set cannot interleave (mirrors the Dexie txn).
    const stored = this.readStateMap.get(streamId)?.last_read_seq ?? -1
    if (seq <= stored) return Promise.resolve(false)
    this.readStateMap.set(streamId, { stream_id: streamId, last_read_seq: seq })
    return Promise.resolve(true)
  }

  putPrefs(rows: readonly PrefsRow[]): Promise<void> {
    for (const row of rows) this.prefsMap.set(row.stream_id, row)
    return Promise.resolve()
  }

  listPrefs(): Promise<PrefsRow[]> {
    return Promise.resolve([...this.prefsMap.values()])
  }

  getPrefs(streamId: string): Promise<PrefsRow | undefined> {
    return Promise.resolve(this.prefsMap.get(streamId))
  }

  clearDerivedTables(): Promise<void> {
    // ENG-126: `read_state` + `prefs` are synced-KV (NOT derived) — preserved
    // across a rebuild, mirroring DexieDb.clearDerivedTables.
    this.messagesMap.clear()
    this.reactionsMap.clear()
    this.participantsMap.clear()
    this.filesMap.clear()
    this.streamsMap.clear()
    this.cursorsMap.clear()
    return Promise.resolve()
  }

  clearSyncedKv(): Promise<void> {
    // Logout hygiene (ENG-126) — wipe synced-KV; SEPARATE from clearDerivedTables.
    this.readStateMap.clear()
    this.prefsMap.clear()
    return Promise.resolve()
  }

  // -- ENG-80 projection reads (Map filter/sort; same shapes as DexieDb) ----

  listStreamIds(): Promise<string[]> {
    const ids = new Set<string>()
    for (const row of this.eventsMap.values()) ids.add(row.stream_id)
    return Promise.resolve([...ids])
  }

  getEventsForStream(streamId: string): Promise<EventRow[]> {
    const rows = [...this.eventsMap.values()]
      .filter((r) => r.stream_id === streamId)
      .sort((a, b) => a.server_sequence - b.server_sequence)
    return Promise.resolve(rows)
  }

  getMessage(messageId: string): Promise<MessageRow | undefined> {
    return Promise.resolve(this.messagesMap.get(messageId))
  }

  listMessagesByStream(
    streamId: string,
    opts: { beforeSeq?: number; limit: number },
  ): Promise<MessageRow[]> {
    const rows = [...this.messagesMap.values()]
      .filter(
        (m) =>
          m.stream_id === streamId &&
          (opts.beforeSeq === undefined || m.created_seq < opts.beforeSeq),
      )
      .sort((a, b) => b.created_seq - a.created_seq) // DESC created_seq
      .slice(0, opts.limit)
    return Promise.resolve(rows)
  }

  getAllMessages(): Promise<MessageRow[]> {
    return Promise.resolve([...this.messagesMap.values()])
  }

  listReadState(): Promise<ReadStateRow[]> {
    return Promise.resolve([...this.readStateMap.values()])
  }

  getReadState(streamId: string): Promise<ReadStateRow | undefined> {
    return Promise.resolve(this.readStateMap.get(streamId))
  }

  listStreamMessagesAfter(streamId: string, afterSeq: number): Promise<MessageRow[]> {
    const rows = [...this.messagesMap.values()]
      .filter((m) => m.stream_id === streamId && m.created_seq > afterSeq)
      .sort((a, b) => a.created_seq - b.created_seq) // ASC created_seq
    return Promise.resolve(rows)
  }

  count(table: TableName): Promise<number> {
    switch (table) {
      case 'events':
        return Promise.resolve(this.eventsMap.size)
      case 'messages':
        return Promise.resolve(this.messagesMap.size)
      case 'reactions':
        return Promise.resolve(this.reactionsMap.size)
      case 'thread_participants':
        return Promise.resolve(this.participantsMap.size)
      case 'files':
        return Promise.resolve(this.filesMap.size)
      case 'streams':
        return Promise.resolve(this.streamsMap.size)
      case 'cursors':
        return Promise.resolve(this.cursorsMap.size)
      case 'outbox':
        return Promise.resolve(this.outboxMap.size)
      case 'read_state':
        return Promise.resolve(this.readStateMap.size)
      case 'prefs':
        return Promise.resolve(this.prefsMap.size)
      case 'meta':
        return Promise.resolve(this.metaMap.size)
      default:
        throw new Error(`unknown table: ${String(table)}`)
    }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// Boot (D-5) — the single entry point. Probe IndexedDB → DexieDb, else
// MemoryDb. `fake-indexeddb` is injected via `options.indexedDB` in tests so
// the test shim never ships in the bundle.
// ---------------------------------------------------------------------------

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new Error('openDb timed out'))
    }, ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function openDb(options?: DexieOptions): Promise<MsgDb> {
  const hasInjected = options?.indexedDB != null
  const hasGlobal = typeof indexedDB !== 'undefined'
  if (!hasInjected && !hasGlobal) {
    // No IndexedDB at all (jsdom, some sandboxes) — degrade immediately.
    return new MemoryDb()
  }
  try {
    const db = new MsgDB(options)
    await withTimeout(db.open(), OPEN_TIMEOUT_MS, () => db.close())
    return new DexieDb(db)
  } catch {
    // Private browsing / disabled IDB throws (SecurityError, InvalidStateError,
    // quota) — everything still works online, just without persistence.
    return new MemoryDb()
  }
}

// ---------------------------------------------------------------------------
// PROJECTION_VERSION plumbing (D-4). On boot, a mismatch clears the derived
// tables and rebuilds; `events` + `outbox` are never touched.
// ---------------------------------------------------------------------------

/**
 * Rebuild the derived `messages` projection from the cached `events` (ENG-80,
 * §12 invariant 6, client side). The caller (`checkProjectionVersion`) has
 * already cleared the derived tables; this asserts that invariant, then replays
 * `events → messages` via the SAME `applyEventsToProjection` the incremental
 * path uses — which is what makes rebuild ≡ incremental true by construction.
 *
 * ONLY `messages` is rebuilt locally: `streams`/`cursors` are echoes of
 * server-authoritative state, refilled by ENG-79's resumed pulls (§5.2 "then
 * resume pulls"), not derivable from the message `events` alone. The synced-KV
 * `read_state` + `prefs` tables (ENG-126) are NEITHER cleared NOR rebuilt here —
 * they SURVIVE the rebuild untouched and are reconciled from `/v1/read-state` +
 * `/v1/prefs` on the next rising-edge-into-`live` (see types.ts D3). Replay logic
 * lives in `projection.ts` (db.ts imports the one function) so there is no
 * db.ts↔projection.ts cycle.
 */
export async function rebuildProjections(db: MsgDb): Promise<void> {
  const remaining = await db.count('messages')
  if (remaining !== 0) {
    throw new Error('rebuildProjections: derived tables must be cleared before rebuild')
  }
  // 1. Replay settled rows from the `events` cache (ENG-80).
  await rebuildMessagesProjection(db)
  // 2. Re-derive still-pending/failed rows from `outbox` (ENG-81 §8) via the SAME
  //    `buildPendingMessageRow` the incremental send path uses — an outbox row whose
  //    `event_id` is already in `events` (crash between putEvents + deleteOutbox) is
  //    skipped, so the settled row from step 1 wins, exactly as incrementally. This
  //    keeps rebuild ≡ incremental true by construction, pending rows included.
  await applyOutboxToProjection(db)
}

/**
 * Reconcile the stored PROJECTION_VERSION with the current one. On mismatch (or
 * missing), drop the derived tables, rebuild, and stamp the new version.
 * Returns whether a rebuild happened.
 */
export async function checkProjectionVersion(db: MsgDb): Promise<{ rebuilt: boolean }> {
  const stored = await db.metaGet<number>(META_PROJECTION_VERSION)
  if (stored === PROJECTION_VERSION) {
    return { rebuilt: false }
  }
  await db.clearDerivedTables()
  await rebuildProjections(db)
  await db.metaPut(META_PROJECTION_VERSION, PROJECTION_VERSION)
  return { rebuilt: true }
}

/** The derived-table names, re-exported for tests/consumers. */
export { DERIVED_TABLES }
