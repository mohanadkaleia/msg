// worker/rpc.ts — client-side correlation-id RPC plumbing, shared by both
// transports (D-2, D-7). Hand-rolled: a discriminated wire + a pending map, so
// the wire form is exactly what we can log in the sync simulation later.

import {
  topicKey,
  type FromWorker,
  type RpcError,
  type RpcRequest,
  type ToWorker,
  type Topic,
  type Unsubscribe,
} from './types'

const DEFAULT_TIMEOUT_MS = 15_000

/** Thrown when the worker returns `{ ok: false }`. Carries the wire error. */
export class RpcCallError extends Error {
  readonly code: string
  readonly detail: string | undefined
  constructor(error: RpcError) {
    super(`RPC error: ${error.code}${error.detail ? ` (${error.detail})` : ''}`)
    this.name = 'RpcCallError'
    this.code = error.code
    this.detail = error.detail
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

interface SubEntry {
  topic: Topic
  handler: (payload: unknown) => void
}

export interface RpcCaller {
  /** Send a request; resolves with the worker's result, rejects on error/timeout. */
  request(req: RpcRequest): Promise<unknown>
  /** Register a push subscription; returns an unsubscribe fn. */
  subscribe(topic: Topic, handler: (payload: unknown) => void): Unsubscribe
  /** Feed an inbound worker→tab frame in (called by the transport). */
  handleFrame(frame: FromWorker): void
  /** Reject all pending requests and clear timers. */
  dispose(): void
}

export interface RpcCallerOptions {
  timeoutMs?: number
  /** Dev guard: assert request payloads are structured-clone-safe. */
  assertCloneablePayloads?: boolean
}

/**
 * Build an RPC caller over a raw post function. `clientId` stamps every frame so
 * the leader's BroadcastChannel can address responses back to this tab.
 */
export function createRpcCaller(
  clientId: string,
  post: (frame: ToWorker) => void,
  options: RpcCallerOptions = {},
): RpcCaller {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const guard = options.assertCloneablePayloads ?? isDev()

  const pending = new Map<string, Pending>()
  const subs = new Map<string, SubEntry>()
  let disposed = false

  function request(req: RpcRequest): Promise<unknown> {
    if (disposed) return Promise.reject(new Error('RPC caller disposed'))
    if (guard) assertCloneable(req)
    const id = crypto.randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`RPC timeout after ${timeoutMs}ms: ${req.method}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      post({ t: 'req', id, clientId, req })
    })
  }

  function subscribe(topic: Topic, handler: (payload: unknown) => void): Unsubscribe {
    const id = crypto.randomUUID()
    subs.set(id, { topic, handler })
    post({ t: 'sub', id, clientId, topic })
    return () => {
      if (!subs.delete(id)) return
      post({ t: 'unsub', id, clientId })
    }
  }

  function handleFrame(frame: FromWorker): void {
    switch (frame.t) {
      case 'res': {
        const p = pending.get(frame.id)
        if (!p) return // sub/unsub acks and stale frames have no pending entry
        clearTimeout(p.timer)
        pending.delete(frame.id)
        if (frame.ok) p.resolve(frame.result)
        else p.reject(new RpcCallError(frame.error))
        return
      }
      case 'push': {
        const key = topicKey(frame.topic)
        for (const entry of subs.values()) {
          if (topicKey(entry.topic) === key) entry.handler(frame.payload)
        }
        return
      }
      case 'status':
        // Status pushes are surfaced through the transport's own onStatus, not
        // the RPC caller; ignore here.
        return
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('RPC caller disposed'))
    }
    pending.clear()
    subs.clear()
  }

  return { request, subscribe, handleFrame, dispose }
}

function isDev(): boolean {
  try {
    return import.meta.env.DEV
  } catch {
    return false
  }
}

/**
 * Dev guard (D-7, risk 4): throw a clear error if `value` is not
 * structured-clone-safe (e.g. carries a function or class instance) instead of
 * letting a `DataCloneError` surface only at the transport boundary.
 */
export function assertCloneable(value: unknown): void {
  try {
    structuredClone(value)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Value is not structured-clone-safe: ${detail}`)
  }
}
