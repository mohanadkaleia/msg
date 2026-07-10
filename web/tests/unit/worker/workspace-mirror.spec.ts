// tests/unit/worker/workspace-mirror.spec.ts — M6-3 (ENG-167) unit coverage of
// the WorkspaceMirror + the SyncEngine's full-mirror mode, over in-memory seam
// fakes (no fs). The disciplines under test are msgctl's, precisely:
// registration-before-write, the `server_received_at[:7]` month split,
// log-derived resume (never a double-append), and gapless-append fail-closed.
// The fs-backed end-to-end proof (`msgctl verify` exit 0) lives in the M6
// exit gate, tests/integration/m6-exit-gate.spec.ts (test_m6_exit_gate).

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { newStreamId } from '../../../src/core'
import { MemoryDb } from '../../../src/worker/db'
import { eventNdjsonLine } from '../../../src/worker/mirror/serialize'
import type { EventLog, ManifestStore, WorkspaceManifest } from '../../../src/worker/mirror/seams'
import {
  META_STREAM_NAME,
  WorkspaceMirror,
  type WorkspaceMirrorIdentity,
} from '../../../src/worker/mirror/workspace-mirror'
import { SyncEngine } from '../../../src/worker/sync'
import type { EventRow, SyncStreamMeta, WireEvent } from '../../../src/worker/types'

import {
  buildWireEvent,
  FakeClock,
  FakeHttpClient,
  FakeSyncServer,
  makeFakeWsFactory,
  until,
} from './helpers'

// ---------------------------------------------------------------------------
// In-memory seam fakes
// ---------------------------------------------------------------------------

class MemoryEventLog implements EventLog {
  /** streamId → month → lines (each newline-terminated, as appended). */
  readonly data = new Map<string, Map<string, string[]>>()
  readonly appendCalls: { streamId: string; month: string; lines: string[] }[] = []

  append(streamId: string, month: string, lines: readonly string[]): Promise<void> {
    this.appendCalls.push({ streamId, month, lines: [...lines] })
    const months = this.data.get(streamId) ?? new Map<string, string[]>()
    this.data.set(streamId, months)
    const existing = months.get(month) ?? []
    months.set(month, [...existing, ...lines])
    return Promise.resolve()
  }

  listMonths(streamId: string): Promise<string[]> {
    return Promise.resolve([...(this.data.get(streamId)?.keys() ?? [])].sort())
  }

  readAll(streamId: string): Promise<string[]> {
    const months = this.data.get(streamId)
    if (!months) return Promise.resolve([])
    const lines: string[] = []
    for (const month of [...months.keys()].sort()) {
      for (const line of months.get(month) ?? []) lines.push(line.replace(/\n$/, ''))
    }
    return Promise.resolve(lines)
  }

  listStreams(): Promise<string[]> {
    return Promise.resolve([...this.data.keys()].sort())
  }
}

class MemoryManifestStore implements ManifestStore {
  manifest: WorkspaceManifest | null = null
  writes = 0

  read(): Promise<WorkspaceManifest | null> {
    return Promise.resolve(this.manifest ? structuredClone(this.manifest) : null)
  }

  write(manifest: WorkspaceManifest): Promise<void> {
    this.manifest = structuredClone(manifest)
    this.writes++
    return Promise.resolve()
  }
}

const identity: WorkspaceMirrorIdentity = {
  workspaceId: 'w_01JGXW5C8RXY9TESTWORKSPC1',
  workspaceName: 'acme',
  myUserId: 'u_01JGXW5C8RXY9TESTAUTHOR01',
  deviceId: 'd_01JGXW5C8RXY9TESTDEVICE01',
}

function makeMirror(): {
  mirror: WorkspaceMirror
  log: MemoryEventLog
  store: MemoryManifestStore
} {
  const log = new MemoryEventLog()
  const store = new MemoryManifestStore()
  const mirror = new WorkspaceMirror(log, store, identity, () => '2026-07-04T00:00:00.000Z')
  return { mirror, log, store }
}

function meta(streamId: string, over: Partial<SyncStreamMeta> = {}): SyncStreamMeta {
  return {
    stream_id: streamId,
    kind: 'channel',
    name: 'general',
    visibility: 'public',
    head_seq: 0,
    member: true,
    ...over,
  }
}

function toRow(streamId: string, ev: WireEvent): EventRow {
  return {
    stream_id: streamId,
    server_sequence: ev.server?.server_sequence ?? 0,
    event_id: String(ev.body.event_id),
    type: ev.body.type,
    envelope: ev,
  }
}

async function rows(streamId: string, seqs: number[], month = '2026-01'): Promise<EventRow[]> {
  const out: EventRow[] = []
  for (const seq of seqs) {
    const ev = await buildWireEvent({
      streamId,
      seq,
      receivedAt: `${month}-05T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    })
    out.push(toRow(streamId, ev))
  }
  return out
}

let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  warnSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// WorkspaceMirror
// ---------------------------------------------------------------------------

describe('WorkspaceMirror.registerStreams (registration-before-write)', () => {
  it('writes the msgctl workspace.json shape, with the reserved + fallback names', async () => {
    const { mirror, store } = makeMirror()
    const sMeta = newStreamId()
    const sNamed = newStreamId()
    const sNull = newStreamId()
    await mirror.registerStreams([
      meta(sMeta, { kind: 'workspace-meta', name: null }),
      meta(sNamed, { name: 'general' }),
      meta(sNull, { name: null }), // private/DM → falls back to the stream id
    ])
    const m = store.manifest
    expect(m).not.toBeNull()
    expect(m?.format_version).toBe(1)
    expect(m?.workspace_id).toBe(identity.workspaceId)
    // msgctl `Workspace.open` requires these exact local_author keys.
    expect(m?.local_author).toEqual({
      user_id: identity.myUserId,
      device_id: identity.deviceId,
    })
    expect(m?.streams[sMeta]?.name).toBe(META_STREAM_NAME)
    expect(m?.streams[sNamed]?.name).toBe('general')
    expect(m?.streams[sNull]?.name).toBe(sNull)
    expect(m?.streams[sNamed]?.created_at).toBe('2026-07-04T00:00:00.000Z')
  })

  it('is idempotent — re-registering known streams does not rewrite the manifest', async () => {
    const { mirror, store } = makeMirror()
    const sid = newStreamId()
    await mirror.registerStreams([meta(sid)])
    const writes = store.writes
    await mirror.registerStreams([meta(sid)])
    expect(store.writes).toBe(writes)
  })

  it('rejects a non-ULID stream_id before any path use (trust boundary)', async () => {
    const { mirror, store } = makeMirror()
    await expect(mirror.registerStreams([meta('../../etc/passwd')])).rejects.toThrow(/typed ULID/)
    expect(store.manifest).toBeNull() // aborted before registering anything
  })
})

describe('WorkspaceMirror.appendApplied', () => {
  it('refuses to write an unregistered stream (fail-closed)', async () => {
    const { mirror, log } = makeMirror()
    const sid = newStreamId()
    await expect(mirror.appendApplied(sid, await rows(sid, [1]))).rejects.toThrow(
      /registration-before-write/,
    )
    expect(log.data.size).toBe(0)
  })

  it('splits month files by server_received_at[:7] and writes canonical lines', async () => {
    const { mirror, log } = makeMirror()
    const sid = newStreamId()
    await mirror.registerStreams([meta(sid)])
    const run = [...(await rows(sid, [1, 2], '2026-01')), ...(await rows(sid, [3], '2026-02'))]
    // Fix contiguity across the two builders (seq 3 continues 1,2).
    await mirror.appendApplied(sid, run)
    expect(await log.listMonths(sid)).toEqual(['2026-01', '2026-02'])
    expect(log.data.get(sid)?.get('2026-01')).toHaveLength(2)
    expect(log.data.get(sid)?.get('2026-02')).toHaveLength(1)
    const all = await log.readAll(sid)
    expect(all).toEqual(run.map((r) => eventNdjsonLine(r.envelope!).replace(/\n$/, '')))
  })

  it('never double-appends: sequences at or below the durable head are dropped', async () => {
    const { mirror, log } = makeMirror()
    const sid = newStreamId()
    await mirror.registerStreams([meta(sid)])
    const first = await rows(sid, [1, 2, 3])
    await mirror.appendApplied(sid, first)
    // A crash-window re-pull re-delivers 1..3 plus the new 4..5.
    const replay = [...first, ...(await rows(sid, [4, 5]))]
    await mirror.appendApplied(sid, replay)
    const seqs = (await log.readAll(sid)).map(
      (l) => (JSON.parse(l) as { server: { server_sequence: number } }).server.server_sequence,
    )
    expect(seqs).toEqual([1, 2, 3, 4, 5]) // no duplicates, gapless
  })

  it('derives the resume head from the log itself across a restart (fresh mirror)', async () => {
    const { mirror, log, store } = makeMirror()
    const sid = newStreamId()
    await mirror.registerStreams([meta(sid)])
    await mirror.appendApplied(sid, await rows(sid, [1, 2]))
    // "Restart": a brand-new mirror over the SAME log + manifest (cold caches).
    const mirror2 = new WorkspaceMirror(log, store, identity)
    expect(await mirror2.headSeq(sid)).toBe(2)
    await mirror2.appendApplied(sid, await rows(sid, [1, 2, 3]))
    expect((await log.readAll(sid)).length).toBe(3)
  })

  it('refuses a non-contiguous append (a gap must never reach the disk)', async () => {
    const { mirror } = makeMirror()
    const sid = newStreamId()
    await mirror.registerStreams([meta(sid)])
    await mirror.appendApplied(sid, await rows(sid, [1]))
    await expect(mirror.appendApplied(sid, await rows(sid, [3]))).rejects.toThrow(/non-contiguous/)
  })

  it('refuses a malformed month before it becomes a path component', async () => {
    const { mirror } = makeMirror()
    const sid = newStreamId()
    await mirror.registerStreams([meta(sid)])
    const [row] = await rows(sid, [1])
    row!.envelope!.server!.server_received_at = '../evil'
    await expect(mirror.appendApplied(sid, [row!])).rejects.toThrow(/YYYY-MM/)
  })
})

// ---------------------------------------------------------------------------
// SyncEngine full-mirror mode
// ---------------------------------------------------------------------------

interface FullMirrorHarness {
  engine: SyncEngine
  db: MemoryDb
  http: FakeHttpClient
  ws: ReturnType<typeof makeFakeWsFactory>
  log: MemoryEventLog
  store: MemoryManifestStore
}

function makeFullMirrorHarness(server: FakeSyncServer): FullMirrorHarness {
  const db = new MemoryDb()
  const http = new FakeHttpClient(server)
  const ws = makeFakeWsFactory()
  const clock = new FakeClock()
  const { mirror, log, store } = makeMirror()
  const engine = new SyncEngine({
    http,
    wsFactory: ws.wsFactory,
    db,
    getToken: () => 'tok',
    emitStatus: () => undefined,
    publishStream: () => undefined,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    isOnline: () => true,
    wsUrl: 'ws://test/v1/ws',
    fullMirror: true,
    mirror,
  })
  return { engine, db, http, ws, log, store }
}

describe('SyncEngine full-mirror mode (M6-3)', () => {
  it('cold-starts with a FORWARD pull from seq 1 — never the newest-window path', async () => {
    const server = new FakeSyncServer()
    const sid = newStreamId()
    server.addStream({ stream_id: sid, name: 'general' })
    await server.seed(sid, 7)
    const h = makeFullMirrorHarness(server)
    h.engine.start()
    h.ws.last().open()
    await until(() => h.engine.status().state === 'live')

    // The whole log is local (a windowed client would have used `before=`).
    expect(await h.db.listEventSequences(sid)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(h.http.countGets(/before=/)).toBe(0)
    expect(h.http.countGets(/after=0/)).toBeGreaterThan(0)
    // …and the on-disk mirror holds the same seven envelopes, in order,
    // registered before written.
    expect(h.store.manifest?.streams[sid]).toBeDefined()
    const lines = await h.log.readAll(sid)
    expect(lines).toHaveLength(7)
    const events = await h.db.getEventsForStream(sid)
    expect(lines).toEqual(events.map((e) => eventNdjsonLine(e.envelope!).replace(/\n$/, '')))
    const cursor = await h.db.getCursor(sid)
    expect(cursor?.last_contiguous_seq).toBe(7)
    expect(cursor?.oldest_loaded_seq).toBe(1)
    h.engine.stop()
  })

  it('default (web) mode is unchanged: cold start still takes the newest window', async () => {
    const server = new FakeSyncServer()
    const sid = newStreamId()
    server.addStream({ stream_id: sid, name: 'general' })
    await server.seed(sid, 5)
    const db = new MemoryDb()
    const http = new FakeHttpClient(server)
    const ws = makeFakeWsFactory()
    const clock = new FakeClock()
    const engine = new SyncEngine({
      http,
      wsFactory: ws.wsFactory,
      db,
      getToken: () => 'tok',
      emitStatus: () => undefined,
      publishStream: () => undefined,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      isOnline: () => true,
      wsUrl: 'ws://test/v1/ws',
      // no fullMirror, no mirror — the web configuration
    })
    engine.start()
    ws.last().open()
    await until(() => engine.status().state === 'live')
    expect(http.countGets(/before=/)).toBeGreaterThan(0) // newest-window pull
    engine.stop()
  })

  it('appends the NDJSON bytes BEFORE persisting the cursor (durable-log-first)', async () => {
    const server = new FakeSyncServer()
    const sid = newStreamId()
    server.addStream({ stream_id: sid, name: 'general' })
    await server.seed(sid, 3)
    const h = makeFullMirrorHarness(server)
    const order: string[] = []
    const origAppend = h.log.append.bind(h.log)
    h.log.append = (s, m, l) => {
      order.push('append')
      return origAppend(s, m, l)
    }
    const origPutCursors = h.db.putCursors.bind(h.db)
    h.db.putCursors = (rowsArg) => {
      order.push('cursor')
      return origPutCursors(rowsArg)
    }
    h.engine.start()
    h.ws.last().open()
    await until(() => h.engine.status().state === 'live')
    expect(order.indexOf('append')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('append')).toBeLessThan(order.indexOf('cursor'))
    h.engine.stop()
  })

  it('converges after a crash between the log fsync and the cursor persist', async () => {
    const server = new FakeSyncServer()
    const sid = newStreamId()
    server.addStream({ stream_id: sid, name: 'general' })
    await server.seed(sid, 6)
    const h = makeFullMirrorHarness(server)
    h.engine.start()
    h.ws.last().open()
    await until(() => h.engine.status().state === 'live')
    h.engine.stop()

    // Simulate the crash window: the log has 1..6 durable, but the cursor only
    // reached 4 (append-then-cursor means a crash leaves exactly this state).
    await h.db.putCursors([{ stream_id: sid, last_contiguous_seq: 4, oldest_loaded_seq: 1 }])
    await server.extend(sid, 2) // 7..8 arrive while "down"

    // "Restart" with a fresh mirror over the same stores (cold head cache).
    const mirror2 = new WorkspaceMirror(h.log, h.store, identity)
    const clock = new FakeClock()
    const ws2 = makeFakeWsFactory()
    const engine2 = new SyncEngine({
      http: h.http,
      wsFactory: ws2.wsFactory,
      db: h.db,
      getToken: () => 'tok',
      emitStatus: () => undefined,
      publishStream: () => undefined,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      isOnline: () => true,
      wsUrl: 'ws://test/v1/ws',
      fullMirror: true,
      mirror: mirror2,
    })
    engine2.start()
    ws2.last().open()
    await until(() => engine2.status().state === 'live')

    const seqs = (await h.log.readAll(sid)).map(
      (l) => (JSON.parse(l) as { server: { server_sequence: number } }).server.server_sequence,
    )
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]) // no double-append, no gap
    expect((await h.db.getCursor(sid))?.last_contiguous_seq).toBe(8)
    engine2.stop()
  })
})

// ---------------------------------------------------------------------------
// M6-4 (ENG-168) — Low-2: appendApplied is serialized PER STREAM inside the
// mirror itself. The engine's callers already serialize (withStreamLock / the
// sequential catch-up loop), but that guarantee lived in the CALLER; these
// tests pin the mirror-owned guard so a future pull-path refactor that fires
// two concurrent appends can never double-write the log.
// ---------------------------------------------------------------------------

describe('WorkspaceMirror.appendApplied — per-stream serialization (M6-4, Low-2)', () => {
  it('two CONCURRENT appends of the same run land exactly once (no double-append)', async () => {
    const { mirror, log } = makeMirror()
    const sid = newStreamId()
    await mirror.registerStreams([meta(sid)])
    const run = await rows(sid, [1, 2, 3])

    // Without the internal queue, both calls read head=0 concurrently, both
    // dedupe nothing, and both append 1..3 → six lines. The queue makes the
    // second call observe head=3 and drop the whole (already-durable) run.
    await Promise.all([mirror.appendApplied(sid, run), mirror.appendApplied(sid, run)])

    const seqs = (await log.readAll(sid)).map(
      (l) => (JSON.parse(l) as { server: { server_sequence: number } }).server.server_sequence,
    )
    expect(seqs).toEqual([1, 2, 3])
    expect(log.appendCalls).toHaveLength(1) // the second append wrote nothing
  })

  it('concurrent CONTIGUOUS runs both land, in order (queue, not mutual exclusion-drop)', async () => {
    const { mirror, log } = makeMirror()
    const sid = newStreamId()
    await mirror.registerStreams([meta(sid)])
    const first = await rows(sid, [1, 2])
    const second = await rows(sid, [3, 4])

    await Promise.all([mirror.appendApplied(sid, first), mirror.appendApplied(sid, second)])

    const seqs = (await log.readAll(sid)).map(
      (l) => (JSON.parse(l) as { server: { server_sequence: number } }).server.server_sequence,
    )
    expect(seqs).toEqual([1, 2, 3, 4])
  })

  it('a REJECTED append (gap) does not wedge the stream queue', async () => {
    const { mirror, log } = makeMirror()
    const sid = newStreamId()
    await mirror.registerStreams([meta(sid)])
    await mirror.appendApplied(sid, await rows(sid, [1]))

    await expect(mirror.appendApplied(sid, await rows(sid, [3]))).rejects.toThrow(/non-contiguous/)

    // The queue survived the rejection — the next contiguous append lands.
    await mirror.appendApplied(sid, await rows(sid, [2]))
    expect(await log.readAll(sid)).toHaveLength(2)
  })

  it('streams do not serialize against EACH OTHER (per-stream, not global)', async () => {
    const { mirror, log } = makeMirror()
    const sidA = newStreamId()
    const sidB = newStreamId()
    await mirror.registerStreams([meta(sidA), meta(sidB)])

    await Promise.all([
      mirror.appendApplied(sidA, await rows(sidA, [1])),
      mirror.appendApplied(sidB, await rows(sidB, [1])),
    ])

    expect(await log.readAll(sidA)).toHaveLength(1)
    expect(await log.readAll(sidB)).toHaveLength(1)
  })
})
