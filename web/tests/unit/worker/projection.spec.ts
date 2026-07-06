import { afterEach, describe, expect, it, vi } from 'vitest'

import { MemoryDb, openDb } from '../../../src/worker/db'
import { applyEventsToProjection, dumpMessages, listMessages } from '../../../src/worker/projection'
import type { MsgDb } from '../../../src/worker/types'

import { fakeIdbOptions } from './helpers'
import {
  malformedMessageEvent,
  messageCreatedEvent,
  metaEvent,
  unknownTypeEvent,
} from './projfixtures'

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('applyEventsToProjection [$name]', ({ make }) => {
  it('materializes a message.created v1 row with the correct columns', async () => {
    const db = await make()
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({
        streamId: 's1',
        seq: 4,
        messageId: 'm_a',
        text: 'café ☕',
        format: 'plain',
        authorUserId: 'u_bob',
        threadRootId: 'm_root',
        mentions: ['u_x', 'u_y'],
      }),
    ])

    const row = await db.getMessage('m_a')
    expect(row).toEqual({
      message_id: 'm_a',
      stream_id: 's1',
      created_seq: 4,
      author_user_id: 'u_bob',
      text: 'café ☕',
      format: 'plain',
      thread_root_id: 'm_root',
      mention_user_ids: ['u_x', 'u_y'],
    })
    await db.close()
  })

  it('omits thread_root_id for a root message (null in payload)', async () => {
    const db = await make()
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm_root_msg' }),
    ])
    const row = await db.getMessage('m_root_msg')
    expect(row).toBeDefined()
    expect('thread_root_id' in row!).toBe(false)
    await db.close()
  })

  it('stores mention_user_ids verbatim from payload.mentions (user-independent)', async () => {
    const db = await make()
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({
        streamId: 's1',
        seq: 1,
        messageId: 'm_m',
        mentions: ['u_1', 'u_2', 'u_3'],
      }),
    ])
    const row = await db.getMessage('m_m')
    expect(row?.mention_user_ids).toEqual(['u_1', 'u_2', 'u_3'])
    await db.close()
  })

  it('skips an unknown type (widget.exploded) — no row, no throw (D9)', async () => {
    const db = await make()
    await expect(
      applyEventsToProjection(db, 's1', [unknownTypeEvent('s1', 1)]),
    ).resolves.toBeUndefined()
    expect(await db.count('messages')).toBe(0)
    await db.close()
  })

  it('skips message.created v2 — above-max version (D9)', async () => {
    const db = await make()
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm_v2', typeVersion: 2 }),
    ])
    expect(await db.count('messages')).toBe(0)
    await db.close()
  })

  it('skips a meta event (channel.created) — no row', async () => {
    const db = await make()
    await applyEventsToProjection(db, 's1', [metaEvent('s1', 1)])
    expect(await db.count('messages')).toBe(0)
    await db.close()
  })

  it('skips a malformed-known payload with a warn, never a throw', async () => {
    const db = await make()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      applyEventsToProjection(db, 's1', [malformedMessageEvent('s1', 1)]),
    ).resolves.toBeUndefined()
    expect(await db.count('messages')).toBe(0)
    expect(warn).toHaveBeenCalledOnce()
    await db.close()
  })

  it('skips a body-less event (missing envelope) without crashing', async () => {
    const db = await make()
    await applyEventsToProjection(db, 's1', [
      { stream_id: 's1', server_sequence: 1, event_id: 'e_x', type: 'message.created' },
    ])
    expect(await db.count('messages')).toBe(0)
    await db.close()
  })

  it('is idempotent: re-applying the same events leaves the dump unchanged', async () => {
    const db = await make()
    const events = [
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm_1', text: 'one' }),
      messageCreatedEvent({ streamId: 's1', seq: 2, messageId: 'm_2', text: 'two' }),
    ]
    await applyEventsToProjection(db, 's1', events)
    const first = await dumpMessages(db)
    await applyEventsToProjection(db, 's1', events)
    const second = await dumpMessages(db)

    expect(second).toBe(first)
    expect(await db.count('messages')).toBe(2)
    await db.close()
  })

  it('applies out-of-order events by ascending server_sequence', async () => {
    const db = await make()
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({ streamId: 's1', seq: 3, messageId: 'm_3' }),
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm_1' }),
      messageCreatedEvent({ streamId: 's1', seq: 2, messageId: 'm_2' }),
    ])
    const page = await listMessages(db, 's1', { limit: 10 })
    expect(page.messages.map((m) => m.created_seq)).toEqual([3, 2, 1]) // DESC
    await db.close()
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('listMessages clamps limit/before_seq [$name]', ({ make }) => {
  async function seed3(db: MsgDb): Promise<void> {
    await applyEventsToProjection(
      db,
      's1',
      [1, 2, 3].map((seq) => messageCreatedEvent({ streamId: 's1', seq, messageId: `m_${seq}` })),
    )
  }

  it('clamps limit=Infinity to a bounded page (fixes the has_more quirk)', async () => {
    const db = await make()
    await seed3(db)
    const page = await listMessages(db, 's1', { limit: Number.POSITIVE_INFINITY })
    expect(page.messages.map((m) => m.created_seq)).toEqual([3, 2, 1]) // bounded, all cached rows
    expect(page.has_more).toBe(false)
    await db.close()
  })

  it('clamps limit=0 and negatives to at least 1', async () => {
    const db = await make()
    await seed3(db)
    for (const bad of [0, -5]) {
      const page = await listMessages(db, 's1', { limit: bad })
      expect(page.messages.map((m) => m.created_seq)).toEqual([3])
      expect(page.has_more).toBe(true)
    }
    await db.close()
  })

  it('leaves a normal limit unaffected', async () => {
    const db = await make()
    await seed3(db)
    const page = await listMessages(db, 's1', { limit: 2 })
    expect(page.messages.map((m) => m.created_seq)).toEqual([3, 2])
    expect(page.has_more).toBe(true)
    await db.close()
  })

  it('coerces an invalid before_seq (NaN) to the head', async () => {
    const db = await make()
    await seed3(db)
    const page = await listMessages(db, 's1', { beforeSeq: Number.NaN, limit: 2 })
    expect(page.messages.map((m) => m.created_seq)).toEqual([3, 2])
    await db.close()
  })
})

describe('dumpMessages ordering', () => {
  it('sorts by (stream_id, created_seq, message_id) with compact fixed-key JSON', async () => {
    const db = new MemoryDb()
    await applyEventsToProjection(db, 's2', [
      messageCreatedEvent({ streamId: 's2', seq: 1, messageId: 'm_z', text: 'z' }),
    ])
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({ streamId: 's1', seq: 2, messageId: 'm_b', text: 'b' }),
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm_a', text: 'a' }),
    ])

    const dump = await dumpMessages(db)
    const lines = dump.split('\n')
    // s1 before s2; within s1 ascending created_seq.
    expect(lines.map((l) => (JSON.parse(l) as { message_id: string }).message_id)).toEqual([
      'm_a',
      'm_b',
      'm_z',
    ])
    // Fixed key order + compact separators (no spaces).
    expect(lines[0]).toBe(
      '{"message_id":"m_a","stream_id":"s1","created_seq":1,"author_user_id":"u_author","text":"a","format":"markdown","thread_root_id":null,"mention_user_ids":[]}',
    )
  })
})
