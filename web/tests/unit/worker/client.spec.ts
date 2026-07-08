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
    // The `mutate` verb now carries real outbox mutations (ENG-81); an
    // `outbox.retry` on an unknown id is a coded-error-free no-op → { ok: true }.
    await expect(client.mutate({ m: 'outbox.retry', event_id: 'e_missing' })).resolves.toEqual({
      ok: true,
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

/** A transport that records posted frames and echoes each `req` back as its result
 *  (`{ method, params }`) so a wiring test can assert what the client sent. */
function echoTransport(): { transport: Transport; frames: ToWorker[] } {
  let onFrame: (f: FromWorker) => void = () => {}
  const frames: ToWorker[] = []
  const transport: Transport = {
    post: (f: ToWorker) => {
      frames.push(f)
      if (f.t === 'req') {
        const { id, req } = f
        queueMicrotask(() =>
          onFrame({ t: 'res', id, ok: true, result: { method: req.method, params: req.params } }),
        )
      } else if (f.t === 'sub') {
        const { id } = f
        queueMicrotask(() => onFrame({ t: 'res', id, ok: true, result: { subscribed: true } }))
      }
    },
    onFrame: (cb) => {
      onFrame = cb
    },
    ready: () => Promise.resolve(),
    status: () => ({ transport: 'solo', db: 'memory', role: 'n/a' }),
    onStatus: () => () => {},
    dispose: () => {},
  }
  return { transport, frames }
}

describe('WorkerClient.files namespace wiring (ENG-119)', () => {
  it('routes each files.* call to the right RPC frame', async () => {
    const { transport, frames } = echoTransport()
    const client = makeWorkerClient('c1', transport)
    const file = new File(['bytes'], 'a.txt', { type: 'text/plain' })

    const ack = (await client.files.upload({
      upload_id: 'up1',
      stream_id: 's1',
      file,
    })) as unknown as {
      method: string
      params: { upload_id: string; stream_id: string }
    }
    expect(ack.method).toBe('file.upload')
    expect(ack.params).toMatchObject({ upload_id: 'up1', stream_id: 's1' })

    await client.files.retry('up1')
    await client.files.cancel('up1')
    await client.files.download('f_1')
    await client.files.thumbnail('f_1')

    const reqs = frames.filter((f): f is Extract<ToWorker, { t: 'req' }> => f.t === 'req')
    expect(reqs.map((f) => f.req.method)).toEqual([
      'file.upload',
      'file.retry',
      'file.cancel',
      'file.fetch',
      'file.fetch',
    ])
    // download → variant 'blob'; thumbnail → variant 'thumbnail'.
    const fetches = reqs.filter((f) => f.req.method === 'file.fetch')
    expect(fetches.map((f) => (f.req.params as { variant: string }).variant)).toEqual([
      'blob',
      'thumbnail',
    ])
  })

  it('onProgress subscribes to the per-upload topic', () => {
    const { transport, frames } = echoTransport()
    const client = makeWorkerClient('c1', transport)

    const unsub = client.files.onProgress('up1', () => {})
    const sub = frames.find((f): f is Extract<ToWorker, { t: 'sub' }> => f.t === 'sub')
    expect(sub?.topic).toEqual({ kind: 'upload', upload_id: 'up1' })
    unsub()
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
