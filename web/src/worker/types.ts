// worker/types.ts — the transport-agnostic contract (ENG-77).
//
// Pure types + consts + a couple of pure helpers, no platform globals and no
// runtime dependencies, so this module is importable from BOTH the tab side
// (stores, ENG-82) and the worker side (SharedWorker / leader). Everything on
// the wire is plain, structured-clone-safe data.

// ---------------------------------------------------------------------------
// Versioning + bounds
// ---------------------------------------------------------------------------

/**
 * App-level version guarding the *derived* tables (`messages`, `streams`,
 * `cursors`, `read_state`). Bumping it forces a rebuild of the derived tables
 * from the raw `events` cache; it does NOT touch the IndexedDB index layout
 * (that is the Dexie `version()` number in `db.ts`). See TDD §5.2, D-4.
 */
export const PROJECTION_VERSION = 1

/** `meta` key under which the current `PROJECTION_VERSION` is stored. */
export const META_PROJECTION_VERSION = 'projection_version'

/** Bounded cache: newest ~N events kept per stream; older pages re-fetched. */
export const MAX_CACHED_EVENTS_PER_STREAM = 2000

// ---------------------------------------------------------------------------
// Dexie row shapes (§5.2). Only a subset of these fields is indexed (see the
// `.stores()` strings in db.ts); the rest are enforced by strict typing here.
// ---------------------------------------------------------------------------

/** Raw event envelope — the evictable source cache. ENG-79 fills the envelope. */
export interface EventRow {
  stream_id: string
  server_sequence: number
  event_id: string
  type: string
  /** Full envelope payload lands with ENG-79; opaque plain data until then. */
  envelope?: Record<string, unknown>
}

/** Projected message row (derived). ENG-80 fills the render fields. */
export interface MessageRow {
  message_id: string
  stream_id: string
  created_seq: number
  thread_root_id?: string
  /** Body / render fields land with ENG-80. */
  body?: Record<string, unknown>
}

/** Projected stream row (derived). */
export interface StreamRow {
  stream_id: string
  kind: string
  name?: string
  visibility?: string
  head_seq: number
  member: boolean
}

/** Per-stream cursor row (derived echo of pull progress). */
export interface CursorRow {
  stream_id: string
  last_contiguous_seq: number
  oldest_loaded_seq: number
}

/** Pending local send. Source-of-truth-ish: never derived, never evicted. */
export interface OutboxRow {
  event_id: string
  created_at: number
  body: Record<string, unknown>
  state: 'queued' | 'sending' | 'rejected'
}

/** Local echo of the server read-state KV (derived). */
export interface ReadStateRow {
  stream_id: string
  last_read_seq: number
}

/** Generic key/value meta row (source): projection_version, my_user_id, … */
export interface MetaRow {
  key: string
  value: unknown
}

/** The seven tables of the §5.2 schema. */
export type TableName =
  'events' | 'messages' | 'streams' | 'cursors' | 'outbox' | 'read_state' | 'meta'

/** Derived tables — safe to drop + rebuild from `events` + server pulls. */
export const DERIVED_TABLES = ['messages', 'streams', 'cursors', 'read_state'] as const
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

  // outbox (source; never evicted, never dropped)
  putOutbox(rows: readonly OutboxRow[]): Promise<void>
  listOutbox(): Promise<OutboxRow[]>

  // derived tables (seeding here doubles as the ENG-80 rebuild write surface)
  putMessages(rows: readonly MessageRow[]): Promise<void>
  putStreams(rows: readonly StreamRow[]): Promise<void>
  putCursors(rows: readonly CursorRow[]): Promise<void>
  putReadState(rows: readonly ReadStateRow[]): Promise<void>
  clearDerivedTables(): Promise<void>

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

/** Read taxonomy — ENG-80 replaces the stub member with real projection reads. */
export type QueryParams = { q: string }

/** Mutation taxonomy — ENG-81 replaces the stub member with real mutations. */
export type MutateParams = { m: string }

/** Stub result shapes; ENG-80/81 specialise these conditionally on the input. */
export interface NotImplementedResult {
  code: 'not_implemented'
  detail?: string
}
export type QueryResult<Q extends QueryParams> = Q extends QueryParams
  ? NotImplementedResult
  : never
export type MutateResult<M extends MutateParams> = M extends MutateParams
  ? NotImplementedResult
  : never

export interface RpcError {
  code: string
  detail?: string
}

export type RpcRequest =
  | { method: 'meta.get'; params: { key: string } }
  | { method: 'query'; params: QueryParams }
  | { method: 'mutate'; params: MutateParams }
  | { method: 'ping'; params: Record<string, never> }

export type RpcMethod = RpcRequest['method']

/** Push topics — ENG-79/80 add topics without touching the transport. */
export type Topic = { kind: 'stream'; stream_id: string } | { kind: 'status' }

/** Payload delivered on a push, keyed to the topic. */
export interface StreamPush {
  stream_id: string
}
export type PushPayload<T extends Topic> = T extends { kind: 'status' }
  ? WorkerStatus
  : T extends { kind: 'stream' }
    ? StreamPush
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
    case 'stream':
      return `stream:${topic.stream_id}`
  }
}
