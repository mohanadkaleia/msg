// worker/shared-worker.ts — the SharedWorker entry point (D-1, D-3). A thin
// adapter: it owns the per-tab `MessagePort`s and hands every inbound frame to
// the ONE shared WorkerCore, which holds all logic. No business logic here, so
// the fact that it is only smoke-testable in Playwright (ENG-83) costs nothing.
//
// This is the `new SharedWorker(new URL('./shared-worker.ts', import.meta.url),
// { type: 'module' })` target pre-wired by ENG-75 (`worker: { format: 'es' }`).

import { WorkerCore } from './core'
import { openDb } from './db'
import type { FromWorker, ToWorker } from './types'

const ctx = self as unknown as SharedWorkerGlobalScope

const ports = new Map<string, MessagePort>()
let corePromise: Promise<WorkerCore> | undefined

function getCore(): Promise<WorkerCore> {
  if (!corePromise) {
    corePromise = (async (): Promise<WorkerCore> => {
      const db = await openDb()
      const core = new WorkerCore(db, (clientId: string, msg: FromWorker) => {
        ports.get(clientId)?.postMessage(msg)
      })
      await core.init()
      return core
    })()
  }
  return corePromise
}

ctx.onconnect = (event: MessageEvent): void => {
  const port = event.ports[0]
  if (!port) return
  port.start()
  port.onmessage = (ev: MessageEvent<ToWorker>): void => {
    const msg = ev.data
    if (msg.t === 'hello') ports.set(msg.clientId, port)
    void getCore()
      .then((core) => core.handle(msg.clientId, msg))
      .catch((err: unknown) => {
        console.error('[shared-worker] handle failed', err)
      })
    if (msg.t === 'bye') ports.delete(msg.clientId)
  }
}
