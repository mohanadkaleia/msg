import { describe, expect, it } from 'vitest'

import { checkProjectionVersion, MemoryDb, openDb } from '../../../src/worker/db'
import { PrefsManager } from '../../../src/worker/prefs'
import { META_PROJECTION_VERSION, PROJECTION_VERSION, type MsgDb } from '../../../src/worker/types'

import { FakeHttpClient, FakeSyncServer, fakeIdbOptions } from './helpers'

interface Harness {
  mgr: PrefsManager
  db: MsgDb
  http: FakeHttpClient
  server: FakeSyncServer
  pushes: number
}

function makeHarness(db: MsgDb): Harness {
  const server = new FakeSyncServer()
  const http = new FakeHttpClient(server)
  const h: Harness = { mgr: null as unknown as PrefsManager, db, http, server, pushes: 0 }
  h.mgr = new PrefsManager({ db, http, publishPrefs: () => (h.pushes += 1) })
  return h
}

describe('PrefsManager (ENG-126 synced-KV, LWW)', () => {
  it('set PUTs and LWW-upserts the pref row', async () => {
    const h = makeHarness(new MemoryDb())
    const row = await h.mgr.set('s1', 'mentions')

    expect(row).toEqual({ stream_id: 's1', level: 'mentions' })
    expect(await h.mgr.getLevel('s1')).toBe('mentions')
    expect(h.http.putCalls).toContainEqual({
      path: '/v1/prefs',
      body: { stream_id: 's1', level: 'mentions' },
    })
    expect(h.server.prefs.get('s1')).toBe('mentions')
    expect(h.pushes).toBeGreaterThan(0)
  })

  it('set is LWW: a later set REPLACES the earlier level unconditionally', async () => {
    const h = makeHarness(new MemoryDb())
    await h.mgr.set('s1', 'mute')
    await h.mgr.set('s1', 'all')
    expect(await h.mgr.getLevel('s1')).toBe('all')
  })

  it('echo LWW-replaces unconditionally (no ordering)', async () => {
    const h = makeHarness(new MemoryDb())
    await h.mgr.applyEcho({ stream_id: 's1', level: 'mute' })
    expect(await h.mgr.getLevel('s1')).toBe('mute')
    await h.mgr.applyEcho({ stream_id: 's1', level: 'mentions' })
    expect(await h.mgr.getLevel('s1')).toBe('mentions')
  })

  it('getLevel defaults to `all` when a stream is absent', async () => {
    const h = makeHarness(new MemoryDb())
    expect(await h.mgr.getLevel('never-set')).toBe('all')
  })

  it('bootstrap seeds the mirror from GET /v1/prefs', async () => {
    const h = makeHarness(new MemoryDb())
    h.server.prefs.set('s1', 'mentions')
    h.server.prefs.set('s2', 'mute')
    await h.mgr.bootstrap()
    expect(await h.mgr.getLevel('s1')).toBe('mentions')
    expect(await h.mgr.getLevel('s2')).toBe('mute')
  })

  it('list returns the full pref snapshot', async () => {
    const h = makeHarness(new MemoryDb())
    await h.mgr.set('s1', 'all')
    await h.mgr.set('s2', 'mute')
    const list = await h.mgr.list()
    expect(list).toHaveLength(2)
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('prefs SURVIVES a projection rebuild [$name]', ({ make }) => {
  it('is preserved by clearDerivedTables (synced-KV, not derived)', async () => {
    const db = await make()
    await db.putPrefs([{ stream_id: 's1', level: 'mute' }])
    await db.clearDerivedTables()
    expect((await db.getPrefs('s1'))?.level).toBe('mute')
    await db.close()
  })

  it('is preserved across a forced PROJECTION_VERSION rebuild', async () => {
    const db = await make()
    await db.putPrefs([{ stream_id: 's1', level: 'mentions' }])
    await db.metaPut(META_PROJECTION_VERSION, PROJECTION_VERSION - 1)

    const { rebuilt } = await checkProjectionVersion(db)

    expect(rebuilt).toBe(true)
    expect((await db.getPrefs('s1'))?.level).toBe('mentions')
    await db.close()
  })
})

describe('Dexie version(4) prefs table is orthogonal to PROJECTION_VERSION', () => {
  it('adding the prefs table did NOT bump PROJECTION_VERSION (stays 5)', () => {
    expect(PROJECTION_VERSION).toBe(5)
  })

  it('opening the version(4) DB with an in-sync projection version does NOT rebuild', async () => {
    const db = await openDb(fakeIdbOptions())
    // Simulate an existing install already at the current projection version.
    await db.metaPut(META_PROJECTION_VERSION, PROJECTION_VERSION)
    await db.putPrefs([{ stream_id: 's1', level: 'mute' }])

    const { rebuilt } = await checkProjectionVersion(db)

    // The prefs table is a Dexie INDEX-layout bump only — no projection rebuild.
    expect(rebuilt).toBe(false)
    expect((await db.getPrefs('s1'))?.level).toBe('mute')
    await db.close()
  })
})
