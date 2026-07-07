// worker/core.ts — WorkerCore: ALL worker logic, transport-agnostic (D-3).
//
// It touches nothing but (1) an MsgDb handle and (2) a MessageSink. It never
// references `self`, ports, channels, or locks — that is what makes the sync
// engine (ENG-79) and projections (ENG-80), which register handlers here,
// unit-testable in vitest against fake-indexeddb or MemoryDb, no browser.

import { AuthManager } from './auth'
import { checkProjectionVersion } from './db'
import { createHttpClient, type HttpClient } from './http'
import { Outbox } from './outbox'
import {
  applyEventsToProjection,
  getMessage,
  listDirectory,
  listMessages,
  listStreamsForSidebar,
} from './projection'
import { SyncEngine } from './sync'
import { browserWsFactory, type WsFactory } from './ws'
import {
  MAX_CACHED_EVENTS_PER_STREAM,
  RpcCodedError,
  topicKey,
  type ApplyEventsToProjection,
  type AuthResult,
  type BackfillResult,
  type MessageSink,
  type MsgDb,
  type MutateParams,
  type MutateResultUnion,
  type PushPayload,
  type QueryParams,
  type QueryResultUnion,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type SyncStatus,
  type ToWorker,
  type Topic,
} from './types'

/**
 * The result each RPC method resolves to. ENG-79/80/81 refine `query`/`mutate`
 * here as they add real reads/mutations; the entry keeps handler + call-site
 * types precise with no re-narrowing.
 */
export interface RpcResultMap {
  'meta.get': { key: string; value: unknown }
  ping: { pong: true }
  query: QueryResultUnion
  mutate: MutateResultUnion
  'auth.login': AuthResult
  'auth.setup': AuthResult
  'auth.acceptInvite': AuthResult
  'auth.status': AuthResult
  'auth.logout': { ok: true }
  'sync.status': SyncStatus
  'sync.backfill': BackfillResult
  'sync.start': { ok: true }
  'sync.stop': { ok: true }
}

/** A handler typed to exactly one method's request variant and result. */
export type RpcHandlerFor<M extends RpcMethod> = (
  req: Extract<RpcRequest, { method: M }>,
  clientId: string,
) => Promise<RpcResultMap[M]>

/** The loose internal shape stored in the registry (over the whole union). */
type AnyRpcHandler = (req: RpcRequest, clientId: string) => Promise<unknown>

interface Subscription {
  clientId: string
  topic: Topic
}

/**
 * WorkerCore construction knobs. The HTTP client is injectable so tests pass a
 * fake `fetch` with no network; the production default is real `fetch` over
 * same-origin relative `/v1` paths (R-f). All three transports construct
 * WorkerCore with no options, so the default path is zero-config.
 */
export interface WorkerCoreOptions {
  /** A fully-formed HTTP client (tests). Wins over `fetchImpl`/`baseUrl`. */
  http?: HttpClient
  /** Inject a fake `fetch` (tests) while keeping the default token wiring. */
  fetchImpl?: typeof fetch
  /** Override the API base URL (default '' → relative same-origin paths). */
  baseUrl?: string
  /**
   * ENG-80's projection build, injected into the sync engine (§3). Default
   * (ENG-81 FOLD-IN): the REAL `applyEventsToProjection` bound to this core's db,
   * so `new WorkerCore(db, sink)` (all three transport entry points) lands live
   * WS events in `messages`. Tests wanting the inert seam inject the no-op.
   */
  applyToProjection?: ApplyEventsToProjection
  /**
   * WS transport factory for the sync engine. Default {@link browserWsFactory}
   * (real `WebSocket`); tests inject a fake so no socket is opened.
   */
  wsFactory?: WsFactory
}

export class WorkerCore {
  private readonly handlers = new Map<RpcMethod, AnyRpcHandler>()
  /** Keyed by the subscription's correlation id. */
  private readonly subs = new Map<string, Subscription>()
  /** The session owner (ENG-78). Holds the token in-memory + persists to `meta`. */
  private readonly auth: AuthManager
  /** The replication loop (ENG-79). Started after auth, stopped on logout. */
  private readonly sync: SyncEngine
  /** The optimistic send + drain loop (ENG-81). */
  private readonly outbox: Outbox
  /** Latest sync state — gates the outbox drain to `live` + detects the rising edge. */
  private syncLive = false

  constructor(
    private readonly db: MsgDb,
    private readonly sink: MessageSink,
    options: WorkerCoreOptions = {},
  ) {
    // The HTTP client reads the token from — and clears the session through —
    // this same manager. `getToken`/`onUnauthorized` are invoked only at call
    // time (well after construction), so referencing `this.auth` here is safe.
    const http =
      options.http ??
      createHttpClient({
        baseUrl: options.baseUrl ?? '',
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        getToken: () => this.auth.getToken(),
        onUnauthorized: () => {
          // An expired/revoked session clears app-wide AND stops replication.
          this.sync.stop()
          return this.auth.clearSession()
        },
      })
    this.auth = new AuthManager(db, http)
    this.sync = new SyncEngine({
      http,
      wsFactory: options.wsFactory ?? browserWsFactory,
      db,
      getToken: () => this.auth.getToken(),
      // FOLD-IN (ENG-79/80 wiring gap, §7): default the seam to the REAL
      // projection so live WS events land in `messages`, not just `events`. One
      // constructor change fixes all three transport entry points (they share
      // this constructor). Tests that want the inert seam inject it explicitly.
      applyToProjection:
        options.applyToProjection ??
        ((streamId, events) => applyEventsToProjection(this.db, streamId, events)),
      emitStatus: (status) => this.onSyncStatus(status),
      publishStream: (streamId) =>
        this.publish({ kind: 'stream', stream_id: streamId }, { stream_id: streamId }),
    })
    this.outbox = new Outbox({
      db,
      http,
      authStatus: () => this.auth.status(),
      publishStream: (streamId) =>
        this.publish({ kind: 'stream', stream_id: streamId }, { stream_id: streamId }),
      // Only drain when the sync engine is live (§4): an offline/degraded compose
      // sits `queued`; the rising-edge-into-`live` kick (onSyncStatus) sends it.
      canDrain: () => this.syncLive,
    })
    this.registerDefaults()
    this.registerAuth()
    this.registerSync()
  }

  /**
   * Fan a sync status to `{kind:'sync'}` subscribers AND drive the outbox: track
   * `live` for the drain gate, and on the rising edge into `live` (reconnect /
   * first connect) kick the drain so queued offline sends flush themselves (§4).
   */
  private onSyncStatus(status: SyncStatus): void {
    const wasLive = this.syncLive
    this.syncLive = status.state === 'live'
    this.publish({ kind: 'sync' }, status)
    if (!wasLive && this.syncLive) this.outbox.drain()
  }

  /**
   * Run once after construction: reconcile PROJECTION_VERSION (D-4), restore the
   * session, and — if authenticated — start the sync engine (§12 lifecycle).
   */
  async init(): Promise<void> {
    await checkProjectionVersion(this.db)
    await this.auth.restore()
    if (this.auth.getToken()) this.sync.start()
  }

  /**
   * Worker-internal token accessor for the ENG-79 WS connect path (R8). Lives on
   * the core (which the transports own) and is NOT part of the tab-facing RPC
   * surface — no tab can reach it.
   */
  getToken(): string | null {
    return this.auth.getToken()
  }

  /**
   * Extension point for ENG-79/80/81. Per-method generic: `register('query', h)`
   * types `h`'s request as exactly the query variant and its result as the query
   * response — no defensive re-narrowing at the call site. Later registration wins.
   */
  register<M extends RpcMethod>(method: M, handler: RpcHandlerFor<M>): void {
    this.handlers.set(method, handler as AnyRpcHandler)
  }

  /** Route an inbound frame to the right handler and reply via the sink. */
  async handle(clientId: string, msg: ToWorker): Promise<void> {
    switch (msg.t) {
      case 'hello':
        // Client identity/addressing lives in the transports (ports / channel),
        // not in the core; nothing to track here at the shell stage.
        return
      case 'bye':
        this.removeClientSubscriptions(msg.clientId)
        return
      case 'sub':
        this.subs.set(msg.id, { clientId, topic: msg.topic })
        this.sink(clientId, { t: 'res', id: msg.id, ok: true, result: { subscribed: true } })
        return
      case 'unsub':
        this.subs.delete(msg.id)
        this.sink(clientId, { t: 'res', id: msg.id, ok: true, result: { unsubscribed: true } })
        return
      case 'req': {
        const handler = this.handlers.get(msg.req.method)
        if (!handler) {
          this.sink(clientId, {
            t: 'res',
            id: msg.id,
            ok: false,
            error: { code: 'unknown_method', detail: msg.req.method },
          })
          return
        }
        try {
          const result = await handler(msg.req, clientId)
          this.sink(clientId, { t: 'res', id: msg.id, ok: true, result })
        } catch (err) {
          this.sink(clientId, { t: 'res', id: msg.id, ok: false, error: toRpcError(err) })
        }
        return
      }
    }
  }

  /** Fan a push out to every client subscribed to `topic`. */
  publish<T extends Topic>(topic: T, payload: PushPayload<T>): void {
    const key = topicKey(topic)
    for (const sub of this.subs.values()) {
      if (topicKey(sub.topic) === key) {
        this.sink(sub.clientId, { t: 'push', topic, payload })
      }
    }
  }

  /**
   * Bounded-cache eviction (D-6): keep the newest ~MAX events for a stream,
   * delete older. It queries `events` only — it has no `outbox` handle, so it
   * structurally cannot touch pending sends. Not wired into a hot path here
   * (no apply loop until ENG-79); ships proven-safe.
   */
  async evictStream(streamId: string): Promise<void> {
    const seqs = await this.db.listEventSequences(streamId) // ascending
    if (seqs.length <= MAX_CACHED_EVENTS_PER_STREAM) return
    const cutoff = seqs.length - MAX_CACHED_EVENTS_PER_STREAM
    const toDelete = seqs.slice(0, cutoff)
    await this.db.deleteEventsBySequence(streamId, toDelete)
  }

  /** Drop all subscriptions held by a disconnecting client. */
  private removeClientSubscriptions(clientId: string): void {
    for (const [id, sub] of this.subs) {
      if (sub.clientId === clientId) this.subs.delete(id)
    }
  }

  // -- Default handlers ----------------------------------------------------
  // `ping`/`meta.get` prove the round trip; `query` is the real ENG-80
  // projection dispatcher; `mutate` stays not_implemented until ENG-81.

  private registerDefaults(): void {
    this.register('ping', () => Promise.resolve({ pong: true }))

    this.register('meta.get', async (req) => {
      const value = await this.db.metaGet(req.params.key)
      return { key: req.params.key, value }
    })

    this.register('query', (req) => this.handleQuery(req.params))

    this.register('mutate', (req) => this.handleMutate(req.params))
  }

  /**
   * Mutation dispatcher (ENG-81). Discriminated on `params.m` (exhaustive
   * `switch`, mirroring `handleQuery`), each arm delegating to the `Outbox`. All
   * identity is read worker-side inside the outbox — never from the tab.
   */
  private handleMutate(params: MutateParams): Promise<MutateResultUnion> {
    switch (params.m) {
      case 'outbox.send':
        return this.outbox.send(params)
      case 'outbox.retry':
        return this.outbox.retry(params.event_id)
      case 'outbox.delete':
        return this.outbox.delete(params.event_id)
      default:
        // Exhaustive: a new MutateParams member without a case is a COMPILE error
        // (params narrows to `never`); an out-of-contract `m` throws a coded error.
        return assertNeverMutate(params)
    }
  }

  /**
   * Projection query dispatcher (ENG-80). Reads from the local `messages`
   * projection via projection.ts/badges.ts — never the HTTP API for message
   * data. `myUserId` (for mention badges) comes from the worker-owned session.
   */
  private handleQuery(params: QueryParams): Promise<QueryResultUnion> {
    switch (params.q) {
      case 'messages.list':
        return listMessages(this.db, params.stream_id, {
          ...(params.before_seq !== undefined ? { beforeSeq: params.before_seq } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        })
      case 'streams.list':
        return this.listStreams()
      case 'message.get':
        return getMessage(this.db, params.message_id).then((message) => ({ message }))
      case 'directory.list':
        return listDirectory(this.db)
      default:
        // Exhaustive: a new QueryParams member without a case is a COMPILE error
        // here (params narrows to `never`). At runtime an out-of-contract `q`
        // (e.g. a version-skewed tab) throws → `handle` frames a typed
        // `{ ok: false, error: { code: 'unknown-query' } }`, never a silent
        // `{ ok: true, result: undefined }` the shell would mis-render.
        return assertNeverQuery(params)
    }
  }

  private async listStreams(): Promise<QueryResultUnion> {
    const myUserId = this.auth.status().my_user_id ?? ''
    return { streams: await listStreamsForSidebar(this.db, myUserId) }
  }

  // -- ENG-78 auth handlers ------------------------------------------------
  // Real handlers delegating to the AuthManager (R5). Results are token-free
  // application-level values — a wrong password is NOT an RPC rejection, so the
  // RpcCallError reject path stays reserved for genuine transport/handler faults.

  private registerAuth(): void {
    this.register('auth.login', async (req) => {
      const result = await this.auth.login(req.params)
      if (result.ok) this.sync.start()
      return result
    })
    this.register('auth.setup', async (req) => {
      const result = await this.auth.setup(req.params)
      if (result.ok) this.sync.start()
      return result
    })
    this.register('auth.acceptInvite', async (req) => {
      const result = await this.auth.acceptInvite(req.params)
      if (result.ok) this.sync.start()
      return result
    })
    this.register('auth.logout', async () => {
      this.sync.stop()
      return this.auth.logout()
    })
    this.register('auth.status', () =>
      Promise.resolve({ ok: true, status: this.auth.status() } satisfies AuthResult),
    )
  }

  // -- ENG-79 sync handlers ------------------------------------------------
  // Delegate the four sync.* RPCs to the SyncEngine. `start`/`stop` are
  // idempotent; the engine also auto-starts in `init()`/login and stops on
  // logout, so these are mostly for diagnostics + explicit control.

  private registerSync(): void {
    this.register('sync.status', () => Promise.resolve(this.sync.status()))
    this.register('sync.backfill', (req) => this.sync.backfill(req.params.stream_id))
    this.register('sync.start', () => {
      this.sync.start()
      return Promise.resolve({ ok: true as const })
    })
    this.register('sync.stop', () => {
      this.sync.stop()
      return Promise.resolve({ ok: true as const })
    })
  }
}

/**
 * Exhaustiveness guard for the query dispatcher: unreachable for an in-contract
 * `q`, so `params` narrows to `never` (a missing case is a compile error). At
 * runtime it throws a coded error `handle` turns into a clean `unknown-query`
 * frame rather than resolving `undefined`.
 */
function assertNeverQuery(params: never): never {
  throw new RpcCodedError('unknown-query', `unhandled query: ${JSON.stringify(params)}`)
}

/** Exhaustiveness guard for the mutation dispatcher (mirror of `assertNeverQuery`). */
function assertNeverMutate(params: never): never {
  throw new RpcCodedError('unknown-mutation', `unhandled mutation: ${JSON.stringify(params)}`)
}

function toRpcError(err: unknown): RpcError {
  if (err instanceof RpcCodedError) {
    return { code: err.code, detail: err.message }
  }
  return {
    code: 'handler_error',
    detail: err instanceof Error ? err.message : String(err),
  }
}
