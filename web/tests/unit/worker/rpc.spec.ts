import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertCloneable, createRpcCaller, RpcCallError } from '../../../src/worker/rpc'
import type { ToWorker } from '../../../src/worker/types'

function reqId(f: ToWorker | undefined): string {
  if (!f || f.t !== 'req') throw new Error('expected a req frame')
  return f.id
}

describe('createRpcCaller correlation', () => {
  it('matches responses to requests even out of order', async () => {
    const outbound: ToWorker[] = []
    const caller = createRpcCaller('c1', (f) => outbound.push(f))

    const p1 = caller.request({ method: 'ping', params: {} })
    const p2 = caller.request({ method: 'meta.get', params: { key: 'x' } })
    const id1 = reqId(outbound[0])
    const id2 = reqId(outbound[1])
    expect(id1).not.toBe(id2)

    // Respond to the second request first.
    caller.handleFrame({ t: 'res', id: id2, ok: true, result: { second: true } })
    caller.handleFrame({ t: 'res', id: id1, ok: true, result: { first: true } })

    await expect(p1).resolves.toEqual({ first: true })
    await expect(p2).resolves.toEqual({ second: true })
  })

  it('rejects with RpcCallError on an error response', async () => {
    const outbound: ToWorker[] = []
    const caller = createRpcCaller('c1', (f) => outbound.push(f))

    const p = caller.request({ method: 'ping', params: {} })
    caller.handleFrame({
      t: 'res',
      id: reqId(outbound[0]),
      ok: false,
      error: { code: 'boom', detail: 'nope' },
    })

    await expect(p).rejects.toBeInstanceOf(RpcCallError)
    await expect(p).rejects.toMatchObject({ code: 'boom', detail: 'nope' })
  })

  it('ignores a res frame with no matching pending id', () => {
    const caller = createRpcCaller('c1', () => {
      /* no outbound needed */
    })
    // Must not throw for an unknown correlation id (stale/sub-ack frames).
    expect(() => caller.handleFrame({ t: 'res', id: 'ghost', ok: true, result: 1 })).not.toThrow()
  })
})

describe('createRpcCaller timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects a request that is never answered', async () => {
    vi.useFakeTimers()
    const outbound: ToWorker[] = []
    const caller = createRpcCaller('c1', (f) => outbound.push(f), { timeoutMs: 1000 })

    const p = caller.request({ method: 'ping', params: {} })
    const rejection = expect(p).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(1001)
    await rejection
  })
})

describe('createRpcCaller push routing', () => {
  it('delivers a push only to handlers on the matching topic', () => {
    const caller = createRpcCaller('c1', () => {
      /* no outbound needed */
    })
    const streamHits: unknown[] = []
    const statusHits: unknown[] = []
    caller.subscribe({ kind: 'stream', stream_id: 's1' }, (p) => streamHits.push(p))
    caller.subscribe({ kind: 'status' }, (p) => statusHits.push(p))

    caller.handleFrame({
      t: 'push',
      topic: { kind: 'stream', stream_id: 's1' },
      payload: { stream_id: 's1' },
    })

    expect(streamHits).toEqual([{ stream_id: 's1' }])
    expect(statusHits).toEqual([])
  })

  it('stops delivering after unsubscribe', () => {
    const caller = createRpcCaller('c1', () => {
      /* no outbound needed */
    })
    const hits: unknown[] = []
    const unsub = caller.subscribe({ kind: 'stream', stream_id: 's1' }, (p) => hits.push(p))
    unsub()
    caller.handleFrame({ t: 'push', topic: { kind: 'stream', stream_id: 's1' }, payload: {} })
    expect(hits).toHaveLength(0)
  })
})

describe('assertCloneable (dev guard)', () => {
  it('rejects functions and other non-cloneable values', () => {
    expect(() => assertCloneable(() => 1)).toThrow(/structured-clone/)
    expect(() => assertCloneable({ ok: true, nested: { fn: () => 1 } })).toThrow(/structured-clone/)
  })

  it('accepts plain structured-clone-safe data', () => {
    expect(() => assertCloneable({ a: 1, b: 'x', c: [1, 2, { d: true }] })).not.toThrow()
  })

  it('is enforced by request when the guard is on', () => {
    const caller = createRpcCaller(
      'c1',
      () => {
        /* no outbound needed */
      },
      { assertCloneablePayloads: true },
    )
    const bad = {
      method: 'query',
      params: { q: 'message.get', message_id: (() => 1) as unknown as string },
    } as const
    expect(() => caller.request(bad)).toThrow(/structured-clone/)
  })
})
