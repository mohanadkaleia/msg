// worker/core.ts — WorkerCore: ALL worker logic, transport-agnostic (D-3).
//
// It touches nothing but (1) an MsgDb handle and (2) a MessageSink. It never
// references `self`, ports, channels, or locks — that is what makes the sync
// engine (ENG-79) and projections (ENG-80), which register handlers here,
// unit-testable in vitest against fake-indexeddb or MemoryDb, no browser.

import { checkProjectionVersion } from './db'
import {
  MAX_CACHED_EVENTS_PER_STREAM,
  topicKey,
  type MessageSink,
  type MsgDb,
  type NotImplementedResult,
  type PushPayload,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
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
  query: NotImplementedResult
  mutate: NotImplementedResult
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

export class WorkerCore {
  private readonly handlers = new Map<RpcMethod, AnyRpcHandler>()
  /** Keyed by the subscription's correlation id. */
  private readonly subs = new Map<string, Subscription>()

  constructor(
    private readonly db: MsgDb,
    private readonly sink: MessageSink,
  ) {
    this.registerDefaults()
  }

  /** Run once after construction: reconcile PROJECTION_VERSION (D-4). */
  async init(): Promise<void> {
    await checkProjectionVersion(this.db)
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

  // -- ENG-77 stub handlers ------------------------------------------------
  // `ping` and `meta.get` are real (they prove the round trip end to end);
  // `query`/`mutate` are registered but report not_implemented until ENG-80/81.

  private registerDefaults(): void {
    this.register('ping', () => Promise.resolve({ pong: true }))

    this.register('meta.get', async (req) => {
      const value = await this.db.metaGet(req.params.key)
      return { key: req.params.key, value }
    })

    this.register('query', (req) =>
      Promise.resolve({ code: 'not_implemented', detail: req.params.q }),
    )

    this.register('mutate', (req) =>
      Promise.resolve({ code: 'not_implemented', detail: req.params.m }),
    )
  }
}

function toRpcError(err: unknown): RpcError {
  return {
    code: 'handler_error',
    detail: err instanceof Error ? err.message : String(err),
  }
}
