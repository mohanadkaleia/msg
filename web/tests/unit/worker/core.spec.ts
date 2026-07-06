import { describe, expect, it } from 'vitest'

import { MemoryDb, openDb } from '../../../src/worker/db'
import { WorkerCore } from '../../../src/worker/core'
import {
  MAX_CACHED_EVENTS_PER_STREAM,
  type EventRow,
  type FromWorker,
  type MsgDb,
} from '../../../src/worker/types'

import { collectingSink, fakeIdbOptions } from './helpers'

function lastRes(frames: Array<{ clientId: string; msg: FromWorker }>, id: string): FromWorker {
  const found = frames.find((f) => f.msg.t === 'res' && f.msg.id === id)?.msg
  if (!found) throw new Error(`no res frame for id ${id}`)
  return found
}

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('WorkerCore round trips [$name]', ({ make }) => {
  it('answers ping', async () => {
    const db = await make()
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(db, sink)
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'p1',
      clientId: 'c1',
      req: { method: 'ping', params: {} },
    })

    expect(lastRes(frames, 'p1')).toEqual({ t: 'res', id: 'p1', ok: true, result: { pong: true } })
    await db.close()
  })

  it('reads meta.get', async () => {
    const db = await make()
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(db, sink)
    await core.init()
    await db.metaPut('my_user_id', 'user-42')

    await core.handle('c1', {
      t: 'req',
      id: 'g1',
      clientId: 'c1',
      req: { method: 'meta.get', params: { key: 'my_user_id' } },
    })

    expect(lastRes(frames, 'g1')).toEqual({
      t: 'res',
      id: 'g1',
      ok: true,
      result: { key: 'my_user_id', value: 'user-42' },
    })
    await db.close()
  })

  it('returns not_implemented for stub query/mutate', async () => {
    const db = await make()
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(db, sink)
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'q1',
      clientId: 'c1',
      req: { method: 'query', params: { q: 'messages' } },
    })

    expect(lastRes(frames, 'q1')).toEqual({
      t: 'res',
      id: 'q1',
      ok: true,
      result: { code: 'not_implemented', detail: 'messages' },
    })
    await db.close()
  })
})

describe('WorkerCore.publish', () => {
  it('fans a push out to only the subscribed clients', async () => {
    const db = new MemoryDb()
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(db, sink)
    await core.init()

    // c1 subscribes to stream s1; c2 subscribes to status only.
    await core.handle('c1', {
      t: 'sub',
      id: 's-c1',
      clientId: 'c1',
      topic: { kind: 'stream', stream_id: 's1' },
    })
    await core.handle('c2', { t: 'sub', id: 's-c2', clientId: 'c2', topic: { kind: 'status' } })

    core.publish({ kind: 'stream', stream_id: 's1' }, { stream_id: 's1' })

    const pushes = frames.filter((f) => f.msg.t === 'push')
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toEqual({
      clientId: 'c1',
      msg: { t: 'push', topic: { kind: 'stream', stream_id: 's1' }, payload: { stream_id: 's1' } },
    })
  })

  it('stops delivering after the client unsubscribes / disconnects', async () => {
    const db = new MemoryDb()
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(db, sink)
    await core.init()

    await core.handle('c1', {
      t: 'sub',
      id: 'sub1',
      clientId: 'c1',
      topic: { kind: 'stream', stream_id: 's1' },
    })
    await core.handle('c1', { t: 'bye', clientId: 'c1' })

    core.publish({ kind: 'stream', stream_id: 's1' }, { stream_id: 's1' })
    expect(frames.filter((f) => f.msg.t === 'push')).toHaveLength(0)
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('WorkerCore.evictStream (D-6) [$name]', ({ make }) => {
  it('keeps the newest MAX events and never touches the outbox', async () => {
    const db = await make()
    const total = MAX_CACHED_EVENTS_PER_STREAM + 500 // 2500
    const events: EventRow[] = Array.from({ length: total }, (_, i) => ({
      stream_id: 's1',
      server_sequence: i,
      event_id: `e${i}`,
      type: 'msg',
    }))
    await db.putEvents(events)
    await db.putOutbox([
      { event_id: 'o1', created_at: 1, body: {}, state: 'queued' },
      { event_id: 'o2', created_at: 2, body: {}, state: 'queued' },
    ])

    const core = new WorkerCore(db, () => {
      /* no sink output needed for eviction */
    })
    await core.evictStream('s1')

    const remaining = await db.listEventSequences('s1')
    expect(remaining).toHaveLength(MAX_CACHED_EVENTS_PER_STREAM)
    // newest kept: sequences 500..2499
    expect(remaining[0]).toBe(500)
    expect(remaining.at(-1)).toBe(total - 1)
    // outbox is a different table with no handle in evictStream — untouched
    expect(await db.count('outbox')).toBe(2)
    await db.close()
  }, 30000)

  it('is a no-op below the cap', async () => {
    const db = new MemoryDb()
    await db.putEvents([{ stream_id: 's1', server_sequence: 0, event_id: 'e0', type: 'msg' }])
    const core = new WorkerCore(db, () => {
      /* no sink output */
    })
    await core.evictStream('s1')
    expect(await db.count('events')).toBe(1)
  })
})

describe('WorkerCore.init reconciles PROJECTION_VERSION', () => {
  it('clears only derived tables when the stored version is stale', async () => {
    const db = new MemoryDb()
    await db.metaPut('projection_version', 0)
    await db.putEvents([{ stream_id: 's1', server_sequence: 1, event_id: 'e1', type: 'msg' }])
    await db.putOutbox([{ event_id: 'o1', created_at: 1, body: {}, state: 'queued' }])
    await db.putMessages([{ message_id: 'm1', stream_id: 's1', created_seq: 1 }])

    const core = new WorkerCore(db, () => {
      /* no sink output */
    })
    await core.init()

    expect(await db.count('messages')).toBe(0)
    expect(await db.count('events')).toBe(1)
    expect(await db.count('outbox')).toBe(1)
  })
})
