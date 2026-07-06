import { describe, expect, it, vi } from 'vitest'
import { IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb'

import {
  checkProjectionVersion,
  DexieDb,
  MemoryDb,
  openDb,
  rebuildProjections,
} from '../../../src/worker/db'
import { PROJECTION_VERSION, type MsgDb } from '../../../src/worker/types'

import { fakeIdbOptions, makeFakeMsgDB, stubEnvelope } from './helpers'

describe('MsgDB schema (§5.2, verbatim)', () => {
  it('declares the seven tables with the load-bearing indexes', async () => {
    const db = makeFakeMsgDB()
    await db.open()
    try {
      expect(db.tables.map((t) => t.name).sort()).toEqual([
        'cursors',
        'events',
        'messages',
        'meta',
        'outbox',
        'read_state',
        'streams',
      ])

      // events: compound primary key + secondary indexes.
      expect(db.events.schema.primKey.keyPath).toEqual(['stream_id', 'server_sequence'])
      expect(db.events.schema.indexes.map((i) => i.name)).toEqual(
        expect.arrayContaining(['event_id', 'type']),
      )

      // messages: single pk + the compound [stream_id+created_seq] index.
      expect(db.messages.schema.primKey.keyPath).toBe('message_id')
      const messageIndexKeyPaths = db.messages.schema.indexes.map((i) => i.keyPath)
      expect(messageIndexKeyPaths).toContainEqual(['stream_id', 'created_seq'])
      expect(messageIndexKeyPaths).toContainEqual('thread_root_id')

      expect(db.streams.schema.primKey.keyPath).toBe('stream_id')
      expect(db.cursors.schema.primKey.keyPath).toBe('stream_id')
      expect(db.outbox.schema.primKey.keyPath).toBe('event_id')
      expect(db.read_state.schema.primKey.keyPath).toBe('stream_id')
      expect(db.meta.schema.primKey.keyPath).toBe('key')
    } finally {
      db.close()
    }
  })
})

describe('openDb (D-5 graceful degradation)', () => {
  it('opens a persistent DexieDb when IndexedDB works', async () => {
    const db = await openDb(fakeIdbOptions())
    expect(db.persistence).toBe('persistent')
    expect(db).toBeInstanceOf(DexieDb)
    await db.metaPut('my_user_id', 'u-1')
    expect(await db.metaGet<string>('my_user_id')).toBe('u-1')
    await db.close()
  })

  it('degrades to an in-memory store when IndexedDB is absent', async () => {
    vi.stubGlobal('indexedDB', undefined)
    try {
      const db = await openDb()
      expect(db.persistence).toBe('memory')
      expect(db).toBeInstanceOf(MemoryDb)
      // still fully functional online, just not persistent
      await db.metaPut('k', 'v')
      expect(await db.metaGet('k')).toBe('v')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('degrades to memory when opening throws (private browsing)', async () => {
    const throwing = {
      open() {
        throw new DOMException('IndexedDB disabled', 'SecurityError')
      },
      deleteDatabase() {
        throw new DOMException('IndexedDB disabled', 'SecurityError')
      },
      cmp() {
        return 0
      },
      databases() {
        return Promise.resolve([])
      },
    } as unknown as IDBFactory

    const db = await openDb({
      indexedDB: throwing,
      IDBKeyRange: FakeIDBKeyRange,
    })
    expect(db.persistence).toBe('memory')
  })
})

async function seedAllTables(db: MsgDb): Promise<void> {
  await db.putEvents([
    { stream_id: 's1', server_sequence: 1, event_id: 'e1', type: 'msg', envelope: stubEnvelope(1) },
  ])
  await db.putOutbox([{ event_id: 'o1', created_at: 1, body: { text: 'hi' }, state: 'queued' }])
  await db.putMessages([
    {
      message_id: 'm1',
      stream_id: 's1',
      created_seq: 1,
      author_user_id: 'u1',
      text: '',
      format: 'plain',
      mention_user_ids: [],
    },
  ])
  await db.putStreams([{ stream_id: 's1', kind: 'channel', head_seq: 1, member: true }])
  await db.putCursors([{ stream_id: 's1', last_contiguous_seq: 1, oldest_loaded_seq: 1 }])
  await db.putReadState([{ stream_id: 's1', last_read_seq: 1 }])
}

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('PROJECTION_VERSION reconciliation [$name]', ({ make }) => {
  it('drops ONLY the derived tables on a version mismatch', async () => {
    const db = await make()
    await seedAllTables(db)
    await db.metaPut('projection_version', 0) // stale ⇒ mismatch

    const { rebuilt } = await checkProjectionVersion(db)

    expect(rebuilt).toBe(true)
    // derived tables dropped
    expect(await db.count('messages')).toBe(0)
    expect(await db.count('streams')).toBe(0)
    expect(await db.count('cursors')).toBe(0)
    expect(await db.count('read_state')).toBe(0)
    // source tables preserved
    expect(await db.count('events')).toBe(1)
    expect(await db.count('outbox')).toBe(1)
    // version stamped forward
    expect(await db.metaGet<number>('projection_version')).toBe(PROJECTION_VERSION)
    await db.close()
  })

  it('is a no-op when the version already matches', async () => {
    const db = await make()
    await seedAllTables(db)
    await db.metaPut('projection_version', PROJECTION_VERSION)

    const { rebuilt } = await checkProjectionVersion(db)

    expect(rebuilt).toBe(false)
    expect(await db.count('messages')).toBe(1)
    expect(await db.count('events')).toBe(1)
    await db.close()
  })
})

describe('rebuildProjections stub', () => {
  it('requires the derived tables to be cleared first', async () => {
    const db = new MemoryDb()
    await db.putMessages([
      {
        message_id: 'm1',
        stream_id: 's1',
        created_seq: 1,
        author_user_id: 'u1',
        text: '',
        format: 'plain',
        mention_user_ids: [],
      },
    ])
    await expect(rebuildProjections(db)).rejects.toThrow(/must be cleared/)
  })
})
