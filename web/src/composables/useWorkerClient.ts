// composables/useWorkerClient.ts — the ONE seam through which the shell reaches
// the worker (ENG-82). Every store / component resolves its WorkerClient here,
// never by importing the transport internals or the HTTP client. Production
// returns the module-level singleton (`getWorkerClient`); tests inject a fake
// via `setWorkerClient` so components run browser-free with no SharedWorker.
//
// This indirection is what keeps the shell a DUMB view over the worker RPC: the
// only surface it can touch is `WorkerClient` (query / mutate / subscribe /
// auth / sync). The session token stays worker-side and is unreachable here.

import { getWorkerClient, type WorkerClient } from '../worker'

let override: WorkerClient | undefined

/**
 * Resolve the WorkerClient the shell talks to. Returns the test override when
 * one is set, otherwise the lazily-created singleton for this tab.
 */
export function resolveWorkerClient(): Promise<WorkerClient> {
  if (override) return Promise.resolve(override)
  return getWorkerClient()
}

/** Inject a fake WorkerClient (tests). Pass `undefined` to restore the default. */
export function setWorkerClient(client: WorkerClient | undefined): void {
  override = client
}
