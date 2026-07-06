import { describe, expect, it } from 'vitest'

import { WorkerCore } from '../../../src/worker/core'
import { MemoryDb, openDb } from '../../../src/worker/db'
import { applyEventsToProjection } from '../../../src/worker/projection'
import type { FromWorker, MsgDb, QueryParams } from '../../../src/worker/types'

import { collectingSink, fakeIdbOptions } from './helpers'
import { messageCreatedEvent } from './projfixtures'

function resultFor(frames: Array<{ clientId: string; msg: FromWorker }>, id: string): unknown {
  const msg = frames.find((f) => f.msg.t === 'res' && f.msg.id === id)?.msg
  if (!msg || msg.t !== 'res' || !msg.ok) throw new Error(`no ok res frame for id ${id}`)
  return msg.result
}

/** Init the core (stamps projection_version) THEN seed — so init's rebuild doesn't wipe. */
async function bootedCore(db: MsgDb): Promise<{
  runQuery: (id: string, params: QueryParams) => Promise<unknown>
}> {
  const { sink, frames } = collectingSink()
  const core = new WorkerCore(db, sink)
  await core.init()
  return {
    runQuery: async (id, params) => {
      await core.handle('c1', { t: 'req', id, clientId: 'c1', req: { method: 'query', params } })
      return resultFor(frames, id)
    },
  }
}

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('projection query RPC [$name]', ({ make }) => {
  it('messages.list paginates newest-first via before_seq/limit + has_more', async () => {
    const db = await make()
    const { runQuery } = await bootedCore(db)
    await applyEventsToProjection(
      db,
      's1',
      [1, 2, 3, 4, 5].map((seq) =>
        messageCreatedEvent({ streamId: 's1', seq, messageId: `m_${seq}` }),
      ),
    )

    const page1 = (await runQuery('a', { q: 'messages.list', stream_id: 's1', limit: 2 })) as {
      messages: Array<{ created_seq: number }>
      has_more: boolean
    }
    expect(page1.messages.map((m) => m.created_seq)).toEqual([5, 4])
    expect(page1.has_more).toBe(true)

    const page2 = (await runQuery('b', {
      q: 'messages.list',
      stream_id: 's1',
      before_seq: 4,
      limit: 2,
    })) as { messages: Array<{ created_seq: number }>; has_more: boolean }
    expect(page2.messages.map((m) => m.created_seq)).toEqual([3, 2])
    expect(page2.has_more).toBe(true)

    const page3 = (await runQuery('c', {
      q: 'messages.list',
      stream_id: 's1',
      before_seq: 2,
      limit: 2,
    })) as { messages: Array<{ created_seq: number }>; has_more: boolean }
    expect(page3.messages.map((m) => m.created_seq)).toEqual([1])
    expect(page3.has_more).toBe(false)
    await db.close()
  })

  it('message.get returns the row on a hit and null on a miss', async () => {
    const db = await make()
    const { runQuery } = await bootedCore(db)
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm_hit', text: 'found' }),
    ])

    const hit = (await runQuery('h', { q: 'message.get', message_id: 'm_hit' })) as {
      message: { message_id: string; text: string } | null
    }
    expect(hit.message).toMatchObject({ message_id: 'm_hit', text: 'found' })

    const miss = (await runQuery('m', { q: 'message.get', message_id: 'm_nope' })) as {
      message: unknown
    }
    expect(miss.message).toBeNull()
    await db.close()
  })

  it('streams.list returns streams merged with unread/mention badges', async () => {
    const db = await make()
    const { runQuery } = await bootedCore(db)
    await db.putStreams([
      { stream_id: 's1', kind: 'channel', name: 'general', head_seq: 5, member: true },
      { stream_id: 's2', kind: 'channel', name: 'random', head_seq: 2, member: true },
    ])
    await db.putReadState([
      { stream_id: 's1', last_read_seq: 2 },
      { stream_id: 's2', last_read_seq: 2 },
    ])

    const res = (await runQuery('s', { q: 'streams.list' })) as {
      streams: Array<{ stream_id: string; name?: string; unread: number; mention: boolean }>
    }
    const byId = Object.fromEntries(res.streams.map((s) => [s.stream_id, s]))
    expect(byId.s1).toMatchObject({ stream_id: 's1', name: 'general', unread: 3, mention: false })
    expect(byId.s2).toMatchObject({ stream_id: 's2', name: 'random', unread: 0, mention: false })
    await db.close()
  })

  it('an out-of-contract query resolves a typed error frame (not ok/undefined)', async () => {
    const db = await make()
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(db, sink)
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'bad',
      clientId: 'c1',
      // A version-skewed tab could send a `q` outside the contract.
      req: { method: 'query', params: { q: 'widgets.list' } as unknown as QueryParams },
    })

    const msg = frames.find((f) => f.msg.t === 'res' && f.msg.id === 'bad')?.msg
    if (!msg || msg.t !== 'res') throw new Error('no res frame')
    expect(msg.ok).toBe(false)
    if (msg.ok) throw new Error('expected an error frame')
    expect(msg.error.code).toBe('unknown-query')
    await db.close()
  })
})
