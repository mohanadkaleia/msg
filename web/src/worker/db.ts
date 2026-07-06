// worker/db.ts — the Dexie schema (§5.2, verbatim) + the MsgDb persistence
// abstraction (D-4) and graceful-degradation boot (D-5).
//
// Two independent version numbers:
//   • Dexie `version(1)`      — the IndexedDB index layout (below, verbatim).
//   • PROJECTION_VERSION      — derived-table validity (types.ts); a mismatch
//                               drops + rebuilds derived tables, never events.

import Dexie, { type DexieOptions, type Table } from 'dexie'

import { rebuildMessagesProjection } from './projection'
import {
  DERIVED_TABLES,
  META_PROJECTION_VERSION,
  PROJECTION_VERSION,
  type CursorRow,
  type EventRow,
  type MessageRow,
  type MetaRow,
  type MsgDb,
  type OutboxRow,
  type ReadStateRow,
  type StreamRow,
  type TableName,
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
  streams!: Table<StreamRow, string>
  cursors!: Table<CursorRow, string>
  outbox!: Table<OutboxRow, string>
  read_state!: Table<ReadStateRow, string>
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
  }
}

// ---------------------------------------------------------------------------
// DexieDb — the persistent MsgDb implementation. Wraps MsgDB; Dexie's richer
// fluent API stays inside this class, callers see only the MsgDb interface.
// ---------------------------------------------------------------------------

export class DexieDb implements MsgDb {
  readonly persistence = 'persistent' as const

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

  async putOutbox(rows: readonly OutboxRow[]): Promise<void> {
    await this.db.outbox.bulkPut([...rows])
  }

  async listOutbox(): Promise<OutboxRow[]> {
    return this.db.outbox.toArray()
  }

  async putMessages(rows: readonly MessageRow[]): Promise<void> {
    await this.db.messages.bulkPut([...rows])
  }

  async putStreams(rows: readonly StreamRow[]): Promise<void> {
    await this.db.streams.bulkPut([...rows])
  }

  async putCursors(rows: readonly CursorRow[]): Promise<void> {
    await this.db.cursors.bulkPut([...rows])
  }

  async putReadState(rows: readonly ReadStateRow[]): Promise<void> {
    await this.db.read_state.bulkPut([...rows])
  }

  async clearDerivedTables(): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.messages, this.db.streams, this.db.cursors, this.db.read_state],
      async () => {
        await Promise.all([
          this.db.messages.clear(),
          this.db.streams.clear(),
          this.db.cursors.clear(),
          this.db.read_state.clear(),
        ])
      },
    )
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

  async listStreams(): Promise<StreamRow[]> {
    return this.db.streams.toArray()
  }

  async getStream(streamId: string): Promise<StreamRow | undefined> {
    return this.db.streams.get(streamId)
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
      case 'streams':
        return this.db.streams.count()
      case 'cursors':
        return this.db.cursors.count()
      case 'outbox':
        return this.db.outbox.count()
      case 'read_state':
        return this.db.read_state.count()
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

  private readonly metaMap = new Map<string, unknown>()
  private readonly eventsMap = new Map<string, EventRow>()
  private readonly outboxMap = new Map<string, OutboxRow>()
  private readonly messagesMap = new Map<string, MessageRow>()
  private readonly streamsMap = new Map<string, StreamRow>()
  private readonly cursorsMap = new Map<string, CursorRow>()
  private readonly readStateMap = new Map<string, ReadStateRow>()

  private static eventKey(streamId: string, seq: number): string {
    return `${streamId}::${seq}`
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

  putOutbox(rows: readonly OutboxRow[]): Promise<void> {
    for (const row of rows) {
      this.outboxMap.set(row.event_id, row)
    }
    return Promise.resolve()
  }

  listOutbox(): Promise<OutboxRow[]> {
    return Promise.resolve([...this.outboxMap.values()])
  }

  putMessages(rows: readonly MessageRow[]): Promise<void> {
    for (const row of rows) this.messagesMap.set(row.message_id, row)
    return Promise.resolve()
  }

  putStreams(rows: readonly StreamRow[]): Promise<void> {
    for (const row of rows) this.streamsMap.set(row.stream_id, row)
    return Promise.resolve()
  }

  putCursors(rows: readonly CursorRow[]): Promise<void> {
    for (const row of rows) this.cursorsMap.set(row.stream_id, row)
    return Promise.resolve()
  }

  putReadState(rows: readonly ReadStateRow[]): Promise<void> {
    for (const row of rows) this.readStateMap.set(row.stream_id, row)
    return Promise.resolve()
  }

  clearDerivedTables(): Promise<void> {
    this.messagesMap.clear()
    this.streamsMap.clear()
    this.cursorsMap.clear()
    this.readStateMap.clear()
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

  listStreams(): Promise<StreamRow[]> {
    return Promise.resolve([...this.streamsMap.values()])
  }

  getStream(streamId: string): Promise<StreamRow | undefined> {
    return Promise.resolve(this.streamsMap.get(streamId))
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
      case 'streams':
        return Promise.resolve(this.streamsMap.size)
      case 'cursors':
        return Promise.resolve(this.cursorsMap.size)
      case 'outbox':
        return Promise.resolve(this.outboxMap.size)
      case 'read_state':
        return Promise.resolve(this.readStateMap.size)
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
 * ONLY `messages` is rebuilt locally: `streams`/`cursors`/`read_state` are
 * echoes of server-authoritative state, refilled by ENG-79's resumed pulls
 * (§5.2 "then resume pulls"), not derivable from the message `events` alone.
 * Replay logic lives in `projection.ts` (db.ts imports the one function) so
 * there is no db.ts↔projection.ts cycle.
 */
export async function rebuildProjections(db: MsgDb): Promise<void> {
  const remaining = await db.count('messages')
  if (remaining !== 0) {
    throw new Error('rebuildProjections: derived tables must be cleared before rebuild')
  }
  await rebuildMessagesProjection(db)
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
