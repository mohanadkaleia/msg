// worker/client.ts — the single entry the stores call (D-1). Feature-detects
// the transport once (SharedWorker → leader → solo), wires the RPC caller, and
// returns the ONE WorkerClient whose surface is identical across all three.
//
// `makeWorkerClient` and `detectTransportKind` are exported so the transport
// selection and the client surface are unit-testable without a browser.

import { WorkerCore } from './core'
import { openDb } from './db'
import { createLeaderTransport } from './leader'
import { createRpcCaller } from './rpc'
import {
  type FromWorker,
  type MsgDb,
  type MutateParams,
  type MutateResult,
  type PushPayload,
  type QueryParams,
  type QueryResult,
  type Topic,
  type ToWorker,
  type Transport,
  type Unsubscribe,
  type WorkerClient,
  type WorkerStatus,
} from './types'

const CHANNEL_NAME = 'msg-worker'

// ---------------------------------------------------------------------------
// Feature detection (D-1).
// ---------------------------------------------------------------------------

export interface WorkerEnv {
  hasSharedWorker: boolean
  hasLocks: boolean
  hasBroadcastChannel: boolean
}

/**
 * Choose the transport: SharedWorker if present; else a Web Locks leader if
 * both locks and BroadcastChannel exist; else a degenerate single-tab `solo`
 * (no cross-tab coherence — acceptable long tail, risk 7).
 */
export function detectTransportKind(env: WorkerEnv): WorkerStatus['transport'] {
  if (env.hasSharedWorker) return 'shared-worker'
  if (env.hasLocks && env.hasBroadcastChannel) return 'leader'
  return 'solo'
}

function currentEnv(): WorkerEnv {
  return {
    hasSharedWorker: typeof SharedWorker !== 'undefined',
    hasLocks: typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks != null,
    hasBroadcastChannel: typeof BroadcastChannel !== 'undefined',
  }
}

// ---------------------------------------------------------------------------
// The client surface — identical over any Transport.
// ---------------------------------------------------------------------------

export function makeWorkerClient(clientId: string, transport: Transport): WorkerClient {
  const caller = createRpcCaller(clientId, (f) => {
    transport.post(f)
  })
  transport.onFrame((f) => {
    caller.handleFrame(f)
  })

  return {
    ready: () => transport.ready(),
    query<Q extends QueryParams>(params: Q): Promise<QueryResult<Q>> {
      return caller.request({ method: 'query', params }) as Promise<QueryResult<Q>>
    },
    mutate<M extends MutateParams>(params: M): Promise<MutateResult<M>> {
      return caller.request({ method: 'mutate', params }) as Promise<MutateResult<M>>
    },
    subscribe<T extends Topic>(topic: T, handler: (payload: PushPayload<T>) => void): Unsubscribe {
      return caller.subscribe(topic, (payload) => {
        handler(payload as PushPayload<T>)
      })
    },
    status: () => transport.status(),
    onStatus: (h) => transport.onStatus(h),
    dispose: () => {
      caller.dispose()
      transport.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// Transports.
// ---------------------------------------------------------------------------

/** Degenerate single-tab transport: WorkerCore in-page, no election, no channel. */
export async function createSoloTransport(
  clientId: string,
  openDbFn: () => Promise<MsgDb>,
): Promise<Transport> {
  const db = await openDbFn()
  let frameHandler: ((f: FromWorker) => void) | undefined
  const core = new WorkerCore(db, (targetClientId, msg) => {
    if (targetClientId === clientId) frameHandler?.(msg)
  })
  await core.init()
  void core.handle(clientId, { t: 'hello', clientId })
  const status: WorkerStatus = { transport: 'solo', db: db.persistence, role: 'n/a' }

  return {
    post: (f) => {
      void core.handle(clientId, f)
    },
    onFrame: (cb) => {
      frameHandler = cb
    },
    ready: () => Promise.resolve(),
    status: () => status,
    onStatus: () => () => {
      /* solo status is static */
    },
    dispose: () => {
      void core.handle(clientId, { t: 'bye', clientId })
      void db.close()
    },
  }
}

/** SharedWorker transport (browser only; smoke-tested in ENG-83). */
function createSharedWorkerTransport(clientId: string): Transport {
  const worker = new SharedWorker(new URL('./shared-worker.ts', import.meta.url), {
    type: 'module',
  })
  const port = worker.port
  port.start()
  let frameHandler: ((f: FromWorker) => void) | undefined
  port.onmessage = (ev: MessageEvent<FromWorker>): void => {
    frameHandler?.(ev.data)
  }
  const hello: ToWorker = { t: 'hello', clientId }
  port.postMessage(hello)
  const status: WorkerStatus = {
    transport: 'shared-worker',
    db: typeof indexedDB !== 'undefined' ? 'persistent' : 'memory',
    role: 'n/a',
  }

  return {
    post: (f) => {
      port.postMessage(f)
    },
    onFrame: (cb) => {
      frameHandler = cb
    },
    ready: () => Promise.resolve(),
    status: () => status,
    onStatus: () => () => {
      /* shared-worker status is static at this layer */
    },
    dispose: () => {
      const bye: ToWorker = { t: 'bye', clientId }
      port.postMessage(bye)
      port.close()
    },
  }
}

// ---------------------------------------------------------------------------
// The factory the stores call.
// ---------------------------------------------------------------------------

export interface CreateWorkerClientOptions {
  /** Override feature detection (tests). */
  env?: WorkerEnv
  /** Override the DB boot (tests / degraded control). */
  openDb?: () => Promise<MsgDb>
  /** Override the client id (tests). */
  clientId?: string
}

export async function createWorkerClient(
  options: CreateWorkerClientOptions = {},
): Promise<WorkerClient> {
  const env = options.env ?? currentEnv()
  const clientId = options.clientId ?? crypto.randomUUID()
  const openDbFn = options.openDb ?? (() => openDb())
  const kind = detectTransportKind(env)

  let transport: Transport
  switch (kind) {
    case 'shared-worker':
      transport = createSharedWorkerTransport(clientId)
      break
    case 'leader':
      transport = createLeaderTransport({
        clientId,
        // Real LockManager / BroadcastChannel satisfy the injected interfaces.
        locks: navigator.locks,
        channel: new BroadcastChannel(CHANNEL_NAME),
        openDb: openDbFn,
      })
      break
    case 'solo':
      transport = await createSoloTransport(clientId, openDbFn)
      break
  }

  const client = makeWorkerClient(clientId, transport)
  await client.ready()
  return client
}
