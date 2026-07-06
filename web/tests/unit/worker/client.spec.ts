import { describe, expect, it } from 'vitest'

import {
  createSoloTransport,
  detectTransportKind,
  makeWorkerClient,
} from '../../../src/worker/client'
import { WorkerCore } from '../../../src/worker/core'
import { MemoryDb } from '../../../src/worker/db'
import type { FromWorker, ToWorker, Transport } from '../../../src/worker/types'

describe('detectTransportKind (feature detection, D-1)', () => {
  it('prefers a SharedWorker when available', () => {
    expect(
      detectTransportKind({ hasSharedWorker: true, hasLocks: true, hasBroadcastChannel: true }),
    ).toBe('shared-worker')
  })

  it('falls back to a Web Locks leader when there is no SharedWorker', () => {
    expect(
      detectTransportKind({ hasSharedWorker: false, hasLocks: true, hasBroadcastChannel: true }),
    ).toBe('leader')
  })

  it('degrades to solo when neither SharedWorker nor locks+channel exist', () => {
    expect(
      detectTransportKind({ hasSharedWorker: false, hasLocks: false, hasBroadcastChannel: true }),
    ).toBe('solo')
    expect(
      detectTransportKind({ hasSharedWorker: false, hasLocks: true, hasBroadcastChannel: false }),
    ).toBe('solo')
  })
})

/** A fake Transport backed by an in-page WorkerCore, exposing the core so a
 *  test can drive pushes. Proves the WorkerClient surface works over any
 *  Transport without a browser. */
function fakeTransport(clientId: string): { transport: Transport; core: WorkerCore } {
  let frameHandler: ((f: FromWorker) => void) | undefined
  const core = new WorkerCore(new MemoryDb(), (target, msg) => {
    if (target === clientId) frameHandler?.(msg)
  })
  const transport: Transport = {
    post: (f: ToWorker) => {
      void core.handle(clientId, f)
    },
    onFrame: (cb) => {
      frameHandler = cb
    },
    ready: () => core.init(),
    status: () => ({ transport: 'solo', db: 'memory', role: 'n/a' }),
    onStatus: () => () => {
      /* static */
    },
    dispose: () => {
      void core.handle(clientId, { t: 'bye', clientId })
    },
  }
  return { transport, core }
}

describe('makeWorkerClient surface (identical across transports)', () => {
  it('exposes ready/query/mutate/status over a Transport', async () => {
    const { transport } = fakeTransport('c1')
    const client = makeWorkerClient('c1', transport)
    await client.ready()

    expect(client.status()).toEqual({ transport: 'solo', db: 'memory', role: 'n/a' })
    await expect(client.query({ q: 'message.get', message_id: 'm_missing' })).resolves.toEqual({
      message: null,
    })
    await expect(client.mutate({ m: 'send' })).resolves.toEqual({
      code: 'not_implemented',
      detail: 'send',
    })
  })

  it('subscribes to pushes and stops after unsubscribe', async () => {
    const { transport, core } = fakeTransport('c1')
    const client = makeWorkerClient('c1', transport)
    await client.ready()

    const got: Array<{ stream_id: string }> = []
    const unsub = client.subscribe({ kind: 'stream', stream_id: 's1' }, (p) => got.push(p))
    await Promise.resolve()

    core.publish({ kind: 'stream', stream_id: 's1' }, { stream_id: 's1' })
    expect(got).toEqual([{ stream_id: 's1' }])

    unsub()
    await Promise.resolve()
    core.publish({ kind: 'stream', stream_id: 's1' }, { stream_id: 's1' })
    expect(got).toHaveLength(1)

    client.dispose()
    expect(() => {
      client.dispose()
    }).not.toThrow() // idempotent
  })
})

describe('createSoloTransport', () => {
  it('boots an in-page WorkerCore and answers via the client surface', async () => {
    const transport = await createSoloTransport('solo-1', () => Promise.resolve(new MemoryDb()))
    const client = makeWorkerClient('solo-1', transport)
    await client.ready()

    expect(client.status()).toEqual({ transport: 'solo', db: 'memory', role: 'n/a' })
    await expect(client.query({ q: 'streams.list' })).resolves.toEqual({ streams: [] })
    client.dispose()
  })
})
