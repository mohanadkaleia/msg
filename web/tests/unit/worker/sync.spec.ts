import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MemoryDb } from '../../../src/worker/db'
import { BOOTSTRAP_CONCURRENCY, SyncEngine } from '../../../src/worker/sync'
import type {
  ApplyEventsToProjection,
  EventRow,
  MsgDb,
  SyncStatus,
} from '../../../src/worker/types'

import {
  buildWireEvent,
  corruptHash,
  FakeClock,
  FakeHttpClient,
  FakeSyncServer,
  flush,
  makeFakeWsFactory,
  until,
  untilAsync,
} from './helpers'

interface Harness {
  engine: SyncEngine
  db: MsgDb
  http: FakeHttpClient
  ws: ReturnType<typeof makeFakeWsFactory>
  clock: FakeClock
  statuses: SyncStatus[]
  streamPushes: string[]
  seamCalls: { streamId: string; seqs: number[] }[]
  onlineRef: { value: boolean }
}

interface HarnessOptions {
  server: FakeSyncServer
  db?: MsgDb
  applyToProjection?: ApplyEventsToProjection
}

function makeHarness(overrides: HarnessOptions): Harness {
  const server = overrides.server
  const db = overrides.db ?? new MemoryDb()
  const http = new FakeHttpClient(server)
  const ws = makeFakeWsFactory()
  const clock = new FakeClock()
  const statuses: SyncStatus[] = []
  const streamPushes: string[] = []
  const seamCalls: { streamId: string; seqs: number[] }[] = []
  const onlineRef = { value: true }

  const seam: ApplyEventsToProjection =
    overrides.applyToProjection ??
    ((streamId, events: readonly EventRow[]) => {
      seamCalls.push({ streamId, seqs: events.map((e) => e.server_sequence) })
      return Promise.resolve()
    })

  const engine = new SyncEngine({
    http,
    wsFactory: ws.wsFactory,
    db,
    getToken: () => 'tok',
    applyToProjection: seam,
    emitStatus: (s) => statuses.push(s),
    publishStream: (sid) => streamPushes.push(sid),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    isOnline: () => onlineRef.value,
    wsUrl: 'ws://test/v1/ws',
    heartbeatTimeoutMs: 40_000,
  })

  return { engine, db, http, ws, clock, statuses, streamPushes, seamCalls, onlineRef }
}

async function boot(h: Harness): Promise<void> {
  h.engine.start()
  h.ws.last().open()
  await until(() => h.engine.status().state === 'live')
}

async function seqs(db: MsgDb, streamId: string): Promise<number[]> {
  return db.listEventSequences(streamId)
}

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  warnSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// Bootstrap (§7)
// ---------------------------------------------------------------------------

describe('bootstrap', () => {
  it('catches up a behind stream and advances the cursor to head (converges to truth)', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 10)
    const h = makeHarness({ server })
    await h.db.putCursors([{ stream_id: 's1', last_contiguous_seq: 3, oldest_loaded_seq: 1 }])

    await boot(h)

    expect(await seqs(h.db, 's1')).toEqual([4, 5, 6, 7, 8, 9, 10])
    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(10)
    // seam saw the applied contiguous run 4..10.
    expect(h.seamCalls).toContainEqual({ streamId: 's1', seqs: [4, 5, 6, 7, 8, 9, 10] })
    expect(h.streamPushes).toContain('s1')
  })

  it('cold new stream pulls only the newest page and jumps the cursor to head', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 600) // > one page: newest 500 = seqs 101..600
    const h = makeHarness({ server })

    await boot(h)

    const stored = await seqs(h.db, 's1')
    expect(stored).toHaveLength(500)
    expect(stored[0]).toBe(101)
    expect(stored.at(-1)).toBe(600)
    const cursor = await h.db.getCursor('s1')
    expect(cursor?.last_contiguous_seq).toBe(600) // contiguous-from-window frontier
    expect(cursor?.oldest_loaded_seq).toBe(101)
    // The pull was a newest-page `before=601`, never a walk from seq 1.
    expect(h.http.countGets('before=601')).toBe(1)
    expect(h.http.countGets('after=0')).toBe(0)
  })

  it('syncs workspace-meta from seq 1 (after=0) regardless of head', async () => {
    const server = new FakeSyncServer()
    server.addStream({
      stream_id: 'meta',
      kind: 'workspace-meta',
      member: false,
      name: 'n',
      visibility: 'v',
    })
    await server.seed('meta', 4)
    const h = makeHarness({ server })

    await boot(h)

    expect(await seqs(h.db, 'meta')).toEqual([1, 2, 3, 4])
    expect((await h.db.getCursor('meta'))?.last_contiguous_seq).toBe(4)
    expect(h.http.countGets('after=0')).toBe(1)
    expect(h.http.countGets('before=')).toBe(0)
  })

  it('bounds bootstrap parallelism to BOOTSTRAP_CONCURRENCY across streams', async () => {
    const server = new FakeSyncServer()
    for (let i = 0; i < 10; i++) {
      server.addStream({ stream_id: `s${i}` })
      await server.seed(`s${i}`, 5)
    }
    const h = makeHarness({ server })
    server.pauseEvents()

    h.engine.start()
    h.ws.last().open()
    await flush(20) // let /v1/sync resolve and the pool saturate against the gate

    expect(h.http.inFlight).toBeLessThanOrEqual(BOOTSTRAP_CONCURRENCY)
    server.resumeEvents()
    await until(() => h.engine.status().state === 'live')

    expect(h.http.maxInFlight).toBeLessThanOrEqual(BOOTSTRAP_CONCURRENCY)
  })

  it('re-derives cursors from the events cache after a rebuild, pulling only the tail', async () => {
    // Simulate a PROJECTION_VERSION rebuild: cursors dropped, events intact.
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 8)
    const h = makeHarness({ server })
    // Local events 1..5 survive the rebuild; NO cursor row remains.
    const kept: EventRow[] = []
    for (let seq = 1; seq <= 5; seq++) {
      const ev = await buildWireEvent({ streamId: 's1', seq })
      kept.push({
        stream_id: 's1',
        server_sequence: seq,
        event_id: `e${seq}`,
        type: 'message.created',
        envelope: ev,
      })
    }
    await h.db.putEvents(kept)

    await boot(h)

    // Cursor was reconstructed to 5, then only 6..8 were pulled (after=5) — NOT a
    // full re-pull from seq 1 and NOT a cold newest-page.
    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(8)
    expect(await seqs(h.db, 's1')).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(h.http.countGets('after=5')).toBe(1)
    expect(h.http.countGets('after=0')).toBe(0)
    expect(h.http.countGets('before=')).toBe(0)
  })

  it('skips a hash-mismatch event, warns, and stops the cursor before the hole', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 6)
    const events = server.events('s1')
    events[2] = corruptHash(events[2]!) // corrupt seq 3
    const h = makeHarness({ server })
    // Known stream at 0 → forward catch-up (not the cold-start jump).
    await h.db.putCursors([{ stream_id: 's1', last_contiguous_seq: 0, oldest_loaded_seq: 0 }])

    await boot(h)

    // seq 3 is neither stored nor crossed; the cursor wedges at 2.
    expect(await seqs(h.db, 's1')).toEqual([1, 2, 4, 5, 6])
    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(2)
    expect(warnSpy).toHaveBeenCalled()
    // Only the contiguous run 1..2 was projected.
    expect(h.seamCalls).toEqual([{ streamId: 's1', seqs: [1, 2] }])
  })

  it('cold newest-page: a top-of-page hash mismatch does NOT falsely advance the frontier (no permanent hole)', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 5) // head 5, seqs 1..5, no local cursor → cold path
    const evs = server.events('s1')
    evs[4] = corruptHash(evs[4]!) // corrupt the TOP event (seq 5)
    const h = makeHarness({ server })

    await boot(h)

    // The frontier stops at the actual stored contiguous top (4) — NOT head 5.
    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(4)
    expect(await seqs(h.db, 's1')).toEqual([1, 2, 3, 4]) // seq 5 was dropped, not stored
    expect(warnSpy).toHaveBeenCalled()
    expect(h.seamCalls).toEqual([{ streamId: 's1', seqs: [1, 2, 3, 4] }])

    // The skipped seq is reachable, not a permanent hole: heal the server, then a
    // reconnect's forward catch-up (after=4) reobtains seq 5.
    evs[4] = await buildWireEvent({ streamId: 's1', seq: 5 })
    h.ws.last().serverClose()
    h.clock.advance(1_500)
    h.ws.last().open()
    await until(() => h.engine.status().state === 'live')

    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(5)
    expect(await seqs(h.db, 's1')).toEqual([1, 2, 3, 4, 5])
    expect(h.http.countGets('after=4')).toBeGreaterThanOrEqual(1)
  })

  it('runs green with the default no-op projection seam', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 3)
    const http = new FakeHttpClient(server)
    const ws = makeFakeWsFactory()
    const engine = new SyncEngine({
      http,
      wsFactory: ws.wsFactory,
      db: new MemoryDb(),
      getToken: () => 'tok',
      // no applyToProjection → default noopApplyToProjection
      emitStatus: () => undefined,
      publishStream: () => undefined,
      wsUrl: 'ws://test/v1/ws',
    })
    engine.start()
    ws.last().open()
    await until(() => engine.status().state === 'live')
    expect(engine.status().state).toBe('live')
  })
})

// ---------------------------------------------------------------------------
// WS live delivery contract (§9)
// ---------------------------------------------------------------------------

describe('delivery contract', () => {
  async function bootTo5(): Promise<Harness> {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 5) // cold → cursor jumps to 5, events 1..5
    const h = makeHarness({ server })
    await boot(h)
    return h
  }

  it('applies a contiguous frame directly, with no catch-up pull', async () => {
    const h = await bootTo5()
    const before = h.http.countGets('/v1/events')

    const e6 = await buildWireEvent({ streamId: 's1', seq: 6 })
    h.ws.last().emitEvent(e6)
    await untilAsync(async () => (await h.db.getCursor('s1'))?.last_contiguous_seq === 6)

    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(6)
    expect(await seqs(h.db, 's1')).toContain(6)
    expect(h.http.countGets('/v1/events')).toBe(before) // no pull
  })

  it('a gap frame triggers a targeted pull, never a blind apply', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 5)
    const h = makeHarness({ server })
    await boot(h)

    // Server advances to 8; a frame for seq 8 arrives (missing 6,7).
    await server.extend('s1', 3) // append 6,7,8
    const e8 = server.events('s1').find((e) => e.server?.server_sequence === 8)!
    h.ws.last().emitEvent(e8)

    await untilAsync(async () => (await h.db.getCursor('s1'))?.last_contiguous_seq === 8)
    expect(await seqs(h.db, 's1')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]) // gap closed in order
    expect(h.http.countGets('after=5')).toBe(1) // the targeted pull
  })

  it('ignores a duplicate / old frame (seq <= cursor)', async () => {
    const h = await bootTo5()
    const before = h.http.countGets('/v1/events')

    const e3 = await buildWireEvent({ streamId: 's1', seq: 3 })
    h.ws.last().emitEvent(e3)
    await flush()

    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(5) // unchanged
    expect(h.http.countGets('/v1/events')).toBe(before) // no pull
  })

  it('coalesces two gap frames for one stream into a single in-flight pull', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 5)
    const h = makeHarness({ server })
    await boot(h)
    await server.extend('s1', 5) // append 6..10

    const e8 = server.events('s1').find((e) => e.server?.server_sequence === 8)!
    const e9 = server.events('s1').find((e) => e.server?.server_sequence === 9)!
    h.ws.last().emitEvent(e8)
    h.ws.last().emitEvent(e9)

    await untilAsync(async () => (await h.db.getCursor('s1'))?.last_contiguous_seq === 10)
    expect(h.http.countGets('after=5')).toBe(1) // exactly one pull, not two
  })

  it('an unknown-stream frame does a newest-page pull + /v1/sync refresh (new channel mid-session)', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 3)
    const h = makeHarness({ server })
    await boot(h) // s1 known, cursor 3

    // A channel 's2' is created server-side after bootstrap; a frame for it arrives.
    server.addStream({ stream_id: 's2', name: 'random' })
    await server.seed('s2', 4) // head 4
    const e = server.events('s2').find((x) => x.server?.server_sequence === 4)!
    h.ws.last().emitEvent(e)

    await untilAsync(async () => (await h.db.getCursor('s2'))?.last_contiguous_seq === 4)

    // Newest-page pull (before=head+1), NOT a walk-from-1 (after=0).
    expect(h.http.countGets('stream_id=s2&before=5')).toBe(1)
    expect(h.http.countGets('stream_id=s2&after=0')).toBe(0)
    // /v1/sync was refreshed → s2's metadata landed in `streams` immediately.
    expect((await h.db.getStream('s2'))?.name).toBe('random')
    expect(await seqs(h.db, 's2')).toEqual([1, 2, 3, 4])
  })

  it('retries a failed live gap pull with backoff, then converges', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 5)
    const h = makeHarness({ server })
    await boot(h) // cursor 5
    await server.extend('s1', 5) // 6..10

    // The first gap-pull attempt fails (transient 503).
    server.eventsError = { status: 503, code: 'unavailable', title: 'Unavailable' }
    const e8 = server.events('s1').find((x) => x.server?.server_sequence === 8)!
    h.ws.last().emitEvent(e8)
    await flush()
    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(5) // wedged, retry pending
    expect(h.engine.status().state).toBe('live') // socket NOT torn down for one bad page

    // Heal the server and advance the backoff clock → the retry drains the gap.
    server.eventsError = undefined
    h.clock.advance(2_000)
    await untilAsync(async () => (await h.db.getCursor('s1'))?.last_contiguous_seq === 10)
    expect(h.http.countGets('stream_id=s1&after=5')).toBeGreaterThanOrEqual(2) // retried
  })

  it('replies pong to a server ping', async () => {
    const h = await bootTo5()
    h.ws.last().serverPing()
    expect(h.ws.last().sent).toContainEqual({ t: 'pong' })
  })

  it('ignores event frames received before reaching live (still syncing)', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 5)
    const h = makeHarness({ server })
    server.pauseEvents() // hold bootstrap in `syncing`
    h.engine.start()
    h.ws.last().open()
    await flush(10)
    expect(h.engine.status().state).toBe('syncing')

    const e6 = await buildWireEvent({ streamId: 's1', seq: 6 })
    h.ws.last().emitEvent(e6) // dropped while syncing
    await flush()

    server.resumeEvents()
    await until(() => h.engine.status().state === 'live')
    // seq 6 was never applied off the syncing-phase frame (cursor from bootstrap = 5).
    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// State machine + reconnect (§6)
// ---------------------------------------------------------------------------

describe('state machine', () => {
  it('transitions idle → connecting → syncing → live', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 2)
    const h = makeHarness({ server })

    h.engine.start()
    expect(h.engine.status().state).toBe('connecting')
    h.ws.last().open()
    await until(() => h.engine.status().state === 'live')

    const states = h.statuses.map((s) => s.state)
    expect(states).toContain('connecting')
    expect(states).toContain('syncing')
    expect(states).toContain('live')
  })

  it('onClose → degraded, then a backoff timer reconnects', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 2)
    const h = makeHarness({ server })
    await boot(h)
    const firstSocket = h.ws.last()

    firstSocket.serverClose(1006)
    expect(h.engine.status().state).toBe('degraded')
    expect(firstSocket.closed).toBe(true)

    const socketsBefore = h.ws.sockets.length
    h.clock.advance(1_500) // fire the ≤1s backoff
    expect(h.ws.sockets.length).toBe(socketsBefore + 1) // reconnected → new socket
    h.ws.last().open()
    await until(() => h.engine.status().state === 'live')
  })

  it('reconnect self-heals the disconnect window via cursor diff (invariant 3)', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 5)
    const h = makeHarness({ server })
    await boot(h)
    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(5)

    // Socket drops; events 6..10 land server-side while we are down.
    h.ws.last().serverClose()
    await server.extend('s1', 5)

    h.clock.advance(1_500) // reconnect
    h.ws.last().open()
    await until(() => h.engine.status().state === 'live')

    // No special replay logic — the cursor diff pulled exactly the missed tail.
    expect(await seqs(h.db, 's1')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect((await h.db.getCursor('s1'))?.last_contiguous_seq).toBe(10)
  })

  it('heartbeat watchdog closes + degrades on inbound silence', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 2)
    const h = makeHarness({ server })
    await boot(h)
    const socket = h.ws.last()

    // Advance just past the 40s window (but not far enough to fire the ≥40.5s
    // reconnect backoff) so we observe the degraded state, not a re-connect.
    h.clock.advance(40_001)
    expect(socket.closed).toBe(true)
    expect(h.engine.status().state).toBe('degraded')
  })

  it('a server frame resets the watchdog (no premature close)', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 2)
    const h = makeHarness({ server })
    await boot(h)
    const socket = h.ws.last()

    h.clock.advance(30_000)
    socket.serverPing() // inbound frame resets the watchdog
    h.clock.advance(30_000) // 30s since the ping < 40s window → still alive
    expect(socket.closed).toBe(false)
    expect(h.engine.status().state).toBe('live')
  })

  it('goes degraded on offline and reconnects on online', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 2)
    const h = makeHarness({ server })
    await boot(h)

    h.onlineRef.value = false
    h.engine.notifyOffline()
    expect(h.engine.status().state).toBe('degraded')
    expect(h.engine.status().online).toBe(false)

    const socketsBefore = h.ws.sockets.length
    h.onlineRef.value = true
    h.engine.notifyOnline()
    expect(h.ws.sockets.length).toBe(socketsBefore + 1) // immediate reconnect
    h.ws.last().open()
    await until(() => h.engine.status().state === 'live')
  })

  it('stop() closes the socket, cancels timers, and returns to idle', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 2)
    const h = makeHarness({ server })
    await boot(h)
    const socket = h.ws.last()

    h.engine.stop()
    expect(socket.closed).toBe(true)
    expect(h.engine.status().state).toBe('idle')
    expect(h.clock.pending).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Backward backfill (§10)
// ---------------------------------------------------------------------------

describe('backfill', () => {
  it('extends the window backward, lowering oldest_loaded and leaving the frontier', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 600) // cold window = 101..600
    const h = makeHarness({ server })
    await boot(h)
    expect((await h.db.getCursor('s1'))?.oldest_loaded_seq).toBe(101)

    const result = await h.engine.backfill('s1')

    expect(result).toEqual({ events: 100, has_more: false, oldest_loaded_seq: 1 })
    const cursor = await h.db.getCursor('s1')
    expect(cursor?.oldest_loaded_seq).toBe(1) // extended backward
    expect(cursor?.last_contiguous_seq).toBe(600) // frontier untouched
    expect((await seqs(h.db, 's1'))[0]).toBe(1)
    // seam saw the backfilled run.
    expect(h.seamCalls.some((c) => c.seqs[0] === 1)).toBe(true)
  })

  it('is a no-op once fully backfilled to seq 1', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's1' })
    await server.seed('s1', 5)
    const h = makeHarness({ server })
    await boot(h)

    const result = await h.engine.backfill('s1')
    expect(result.events).toBe(0)
    expect(result.has_more).toBe(false)
  })
})
