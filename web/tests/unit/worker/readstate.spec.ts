import { describe, expect, it } from 'vitest'

import { checkProjectionVersion, MemoryDb, openDb } from '../../../src/worker/db'
import { ReadStateManager } from '../../../src/worker/readstate'
import { META_PROJECTION_VERSION, PROJECTION_VERSION, type MsgDb } from '../../../src/worker/types'

import { FakeHttpClient, FakeSyncServer, fakeIdbOptions } from './helpers'

interface Harness {
  mgr: ReadStateManager
  db: MsgDb
  http: FakeHttpClient
  server: FakeSyncServer
  pushes: string[]
}

function makeHarness(db: MsgDb): Harness {
  const server = new FakeSyncServer()
  const http = new FakeHttpClient(server)
  const pushes: string[] = []
  const mgr = new ReadStateManager({ db, http, publishStream: (s) => pushes.push(s) })
  return { mgr, db, http, server, pushes }
}

describe('ReadStateManager (ENG-126 synced-KV, monotonic)', () => {
  it('mark PUTs and optimistically upserts the read_state row', async () => {
    const h = makeHarness(new MemoryDb())
    await h.mgr.mark('s1', 5)

    expect((await h.db.getReadState('s1'))?.last_read_seq).toBe(5)
    // PUT hit the server with the exact body.
    expect(h.http.putCalls).toContainEqual({
      path: '/v1/read-state',
      body: { stream_id: 's1', last_read_seq: 5 },
    })
    expect(h.server.readState.get('s1')).toBe(5)
    // The badge push fired (at least the optimistic one).
    expect(h.pushes).toContain('s1')
  })

  it('mark publishes the stream BEFORE awaiting the server (optimistic badge clear)', async () => {
    const h = makeHarness(new MemoryDb())
    await h.mgr.mark('s1', 9)
    // The optimistic path published `s1` and persisted the read seq (never rewound).
    expect(h.pushes[0]).toBe('s1')
    expect((await h.db.getReadState('s1'))?.last_read_seq).toBe(9)
  })

  it('echo is monotonic: a lower seq is ignored, a higher seq wins', async () => {
    const h = makeHarness(new MemoryDb())
    await h.mgr.applyEcho({ stream_id: 's1', last_read_seq: 7 })
    expect((await h.db.getReadState('s1'))?.last_read_seq).toBe(7)

    await h.mgr.applyEcho({ stream_id: 's1', last_read_seq: 3 }) // lower → ignored
    expect((await h.db.getReadState('s1'))?.last_read_seq).toBe(7)

    await h.mgr.applyEcho({ stream_id: 's1', last_read_seq: 12 }) // higher → wins
    expect((await h.db.getReadState('s1'))?.last_read_seq).toBe(12)
  })

  it('adopts a server-effective value HIGHER than the optimistic one', async () => {
    const h = makeHarness(new MemoryDb())
    // Another device already marked s1 at 20 (server GREATEST holds it).
    h.server.readState.set('s1', 20)
    await h.mgr.mark('s1', 8)
    // The PUT echoed the effective 20; the mirror adopted it (never rewinds to 8).
    expect((await h.db.getReadState('s1'))?.last_read_seq).toBe(20)
  })

  it('never rewinds when the server-effective value is our optimistic one', async () => {
    const h = makeHarness(new MemoryDb())
    await h.mgr.mark('s1', 15)
    await h.mgr.mark('s1', 10) // stale mark: optimistic no-op, effective stays 15
    expect((await h.db.getReadState('s1'))?.last_read_seq).toBe(15)
  })

  it('a concurrent mark + echo converge to the MAX (atomic monotonic upsert)', async () => {
    const h = makeHarness(new MemoryDb())
    // An RPC mark and an inbound WS echo reconcile the same marker at the same time.
    await Promise.all([
      h.mgr.mark('s1', 4),
      h.mgr.applyEcho({ stream_id: 's1', last_read_seq: 12 }),
    ])
    // The higher value wins irrespective of settle order — never clobbered down to 4.
    expect((await h.db.getReadState('s1'))?.last_read_seq).toBe(12)
  })

  it('bootstrap seeds the mirror from GET /v1/read-state (ignoring head_seq/unread)', async () => {
    const h = makeHarness(new MemoryDb())
    h.server.readState.set('s1', 4)
    h.server.readState.set('s2', 9)
    await h.mgr.bootstrap()
    expect((await h.db.getReadState('s1'))?.last_read_seq).toBe(4)
    expect((await h.db.getReadState('s2'))?.last_read_seq).toBe(9)
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('read_state SURVIVES a projection rebuild [$name]', ({ make }) => {
  it('is preserved by clearDerivedTables (synced-KV, not derived)', async () => {
    const db = await make()
    await db.putReadState([{ stream_id: 's1', last_read_seq: 11 }])
    await db.clearDerivedTables()
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(11)
    await db.close()
  })

  it('is preserved across a forced PROJECTION_VERSION rebuild (the opposite of the old bug)', async () => {
    const db = await make()
    await db.putReadState([{ stream_id: 's1', last_read_seq: 11 }])
    // Stamp a STALE projection version so checkProjectionVersion drops+rebuilds.
    await db.metaPut(META_PROJECTION_VERSION, PROJECTION_VERSION - 1)

    const { rebuilt } = await checkProjectionVersion(db)

    expect(rebuilt).toBe(true)
    // The rebuild wiped derived tables but read_state SURVIVED.
    expect((await db.getReadState('s1'))?.last_read_seq).toBe(11)
    await db.close()
  })
})
