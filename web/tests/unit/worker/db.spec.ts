import { describe, expect, it, vi } from 'vitest'
import { IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb'

import {
  checkProjectionVersion,
  DexieDb,
  MemoryDb,
  openDb,
  rebuildProjections,
} from '../../../src/worker/db'
import { applyEventsToProjection } from '../../../src/worker/projection'
import { PROJECTION_VERSION, type FileRow, type MsgDb } from '../../../src/worker/types'

import { fakeIdbOptions, makeFakeMsgDB, stubEnvelope } from './helpers'
import { fileId, fileUploadedEvent } from './projfixtures'

describe('MsgDB schema (§5.2, verbatim)', () => {
  it('declares the schema tables with the load-bearing indexes', async () => {
    const db = makeFakeMsgDB()
    await db.open()
    try {
      // ENG-100 (M3) added the `reactions` + `thread_participants` derived sets;
      // ENG-120 added the `files` set; ENG-126 added the `prefs` synced-KV table.
      expect(db.tables.map((t) => t.name).sort()).toEqual([
        'cursors',
        'events',
        'files',
        'messages',
        'meta',
        'outbox',
        'prefs',
        'reactions',
        'read_state',
        'streams',
        'thread_participants',
      ])

      // reactions: compound membership pk + a message_id secondary index.
      expect(db.reactions.schema.primKey.keyPath).toEqual(['message_id', 'author_user_id', 'emoji'])
      expect(db.reactions.schema.indexes.map((i) => i.keyPath)).toContainEqual('message_id')
      // thread_participants: compound pk + a root_message_id secondary index.
      expect(db.thread_participants.schema.primKey.keyPath).toEqual(['root_message_id', 'user_id'])
      expect(db.thread_participants.schema.indexes.map((i) => i.keyPath)).toContainEqual(
        'root_message_id',
      )
      // files (ENG-120): file_id pk + a stream_id secondary index.
      expect(db.files.schema.primKey.keyPath).toBe('file_id')
      expect(db.files.schema.indexes.map((i) => i.keyPath)).toContainEqual('stream_id')

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
      // prefs (ENG-126): synced-KV table keyed by stream_id (Dexie version(4)).
      expect(db.prefs.schema.primKey.keyPath).toBe('stream_id')
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
  await db.putOutbox([
    {
      event_id: 'o1',
      created_at: 1,
      body: { text: 'hi' },
      event_hash: 'sha256:o1',
      message_id: 'm_o1',
      stream_id: 's1',
      state: 'queued',
    },
  ])
  await db.putMessages([
    {
      message_id: 'm1',
      stream_id: 's1',
      created_seq: 1,
      author_user_id: 'u1',
      text: '',
      format: 'plain',
      mention_user_ids: [],
      file_ids: [],
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
    // source tables preserved
    expect(await db.count('events')).toBe(1)
    expect(await db.count('outbox')).toBe(1)
    // ENG-126: read_state is SYNCED-KV, NOT derived — it SURVIVES a rebuild (the
    // fix: it used to be wrongly dropped). Refilled from /v1/read-state, not replay.
    expect(await db.count('read_state')).toBe(1)
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
        file_ids: [],
      },
    ])
    await expect(rebuildProjections(db)).rejects.toThrow(/must be cleared/)
  })
})

// ---------------------------------------------------------------------------
// ENG-120 files accessors + version(3)/PROJECTION_VERSION-bump rebuild.
// ---------------------------------------------------------------------------

const F1 = fileId(1)
const F2 = fileId(2)

function fileRow(id: string, over: Partial<FileRow> = {}): FileRow {
  return {
    file_id: id,
    sha256: 'a'.repeat(64),
    name: 'f.png',
    mime_type: 'image/png',
    size_bytes: 7,
    stream_id: 's1',
    ...over,
  }
}

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('files accessors (ENG-120) [$name]', ({ make }) => {
  it('putFiles/getFile/getFilesByIds/getAllFiles round-trip; getFilesByIds omits misses', async () => {
    const db = await make()
    await db.putFiles([fileRow(F1), fileRow(F2)])
    expect((await db.getFile(F1))?.file_id).toBe(F1)
    expect(await db.getFile('f_missing')).toBeUndefined()
    // getFilesByIds returns only the PRESENT rows (a missing id is silently dropped).
    const got = await db.getFilesByIds([F1, 'f_absent', F2])
    expect(got.map((r) => r.file_id).sort()).toEqual([F1, F2].sort())
    expect(await db.count('files')).toBe(2)
    expect((await db.getAllFiles()).length).toBe(2)
    await db.close()
  })

  it('clearDerivedTables wipes files', async () => {
    const db = await make()
    await db.putFiles([fileRow(F1)])
    await db.clearDerivedTables()
    expect(await db.count('files')).toBe(0)
    await db.close()
  })

  it('a PROJECTION_VERSION-bump rebuild drops + repopulates files from cached events', async () => {
    const db = await make()
    const events = [fileUploadedEvent({ streamId: 's1', seq: 1, fileId: F1 })]
    await db.putEvents(events)
    await applyEventsToProjection(db, 's1', events)
    expect(await db.count('files')).toBe(1)

    await db.metaPut('projection_version', 0) // stale ⇒ mismatch ⇒ drop + rebuild
    const { rebuilt } = await checkProjectionVersion(db)
    expect(rebuilt).toBe(true)
    // files was cleared AND repopulated from the cached file.uploaded event.
    expect(await db.count('files')).toBe(1)
    expect((await db.getFile(F1))?.stream_id).toBe('s1')
    expect(await db.metaGet<number>('projection_version')).toBe(PROJECTION_VERSION)
    await db.close()
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('synced-KV wipe is SEPARATE from the derived wipe (ENG-126) [$name]', ({ make }) => {
  it('clearDerivedTables PRESERVES read_state + prefs (rebuild-exempt)', async () => {
    const db = await make()
    await db.putReadState([{ stream_id: 's1', last_read_seq: 7 }])
    await db.putPrefs([{ stream_id: 's1', level: 'mute' }])
    await db.clearDerivedTables()
    expect(await db.count('read_state')).toBe(1)
    expect(await db.count('prefs')).toBe(1)
    await db.close()
  })

  it('clearSyncedKv wipes read_state + prefs (logout hygiene) but not derived tables', async () => {
    const db = await make()
    await db.putReadState([{ stream_id: 's1', last_read_seq: 7 }])
    await db.putPrefs([{ stream_id: 's1', level: 'mute' }])
    await db.putStreams([{ stream_id: 's1', kind: 'channel', head_seq: 1, member: true }])
    await db.clearSyncedKv()
    expect(await db.count('read_state')).toBe(0)
    expect(await db.count('prefs')).toBe(0)
    // clearSyncedKv is scoped to synced-KV — it does not touch derived tables.
    expect(await db.count('streams')).toBe(1)
    await db.close()
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('upsertReadStateMonotonic (ENG-126 atomic GREATEST) [$name]', ({ make }) => {
  it('writes only a strictly-higher seq; reports whether it advanced', async () => {
    const db = await make()
    expect(await db.upsertReadStateMonotonic('s1', 5)).toBe(true)
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(5)
    expect(await db.upsertReadStateMonotonic('s1', 3)).toBe(false) // lower → no write
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(5)
    expect(await db.upsertReadStateMonotonic('s1', 5)).toBe(false) // equal → no write
    expect(await db.upsertReadStateMonotonic('s1', 9)).toBe(true) // higher → advances
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(9)
    await db.close()
  })

  it('concurrent compare-and-sets converge to the MAX (last-write cannot lower it)', async () => {
    const db = await make()
    // Fire a burst concurrently; regardless of settle order the marker ends at max.
    await Promise.all([
      db.upsertReadStateMonotonic('s1', 3),
      db.upsertReadStateMonotonic('s1', 11),
      db.upsertReadStateMonotonic('s1', 7),
      db.upsertReadStateMonotonic('s1', 2),
    ])
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(11)
    await db.close()
  })
})
