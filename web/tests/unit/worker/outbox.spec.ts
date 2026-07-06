// tests/unit/worker/outbox.spec.ts — the ENG-81 outbox suite. Optimistic send,
// the drain loop, ack settling, the ack-vs-WS-frame dedup race (BOTH orders),
// offline compose → reconnect drain, reject/retry/delete, idempotent double
// drain, eviction-preserves-outbox, backoff reuse + coalescing, and token
// non-leakage. MemoryDb + a fake authed HTTP + (for the race) a fake WS — no
// browser, no real network.

import { describe, expect, it } from 'vitest'

import { WorkerCore } from '../../../src/worker/core'
import { MemoryDb } from '../../../src/worker/db'
import { Outbox } from '../../../src/worker/outbox'
import {
  META_DEVICE_ID,
  META_MY_USER_ID,
  META_PROJECTION_VERSION,
  META_ROLE,
  META_SESSION_EXPIRES_AT,
  META_SESSION_TOKEN,
  META_WORKSPACE_ID,
  PROJECTION_VERSION,
  type AuthStatus,
  type FromWorker,
  type MsgDb,
  type SendResult,
} from '../../../src/worker/types'

import {
  collectingSink,
  FakeClock,
  FakeHttpClient,
  FakeSyncServer,
  flush,
  makeFakeWsFactory,
  untilAsync,
} from './helpers'

const AUTH: AuthStatus = { authenticated: true, my_user_id: 'u_me', workspace_id: 'w_me' }

/** A directly-constructed Outbox over MemoryDb + a fake authed batch server. */
function makeOutbox(
  opts: {
    canDrain?: () => boolean
    setTimeout?: FakeClock['setTimeout']
    random?: () => number
    authStatus?: () => AuthStatus
  } = {},
): {
  db: MemoryDb
  server: FakeSyncServer
  http: FakeHttpClient
  outbox: Outbox
  published: string[]
} {
  const db = new MemoryDb()
  void db.metaPut(META_DEVICE_ID, 'd_me')
  const server = new FakeSyncServer()
  const http = new FakeHttpClient(server)
  const published: string[] = []
  const outbox = new Outbox({
    db,
    http,
    authStatus: opts.authStatus ?? ((): AuthStatus => AUTH),
    publishStream: (s) => published.push(s),
    ...(opts.canDrain ? { canDrain: opts.canDrain } : {}),
    ...(opts.setTimeout ? { setTimeout: opts.setTimeout } : {}),
    ...(opts.random ? { random: opts.random } : {}),
  })
  return { db, server, http, outbox, published }
}

const batchPosts = (http: FakeHttpClient): { path: string; body: unknown }[] =>
  http.postCalls.filter((p) => p.path.startsWith('/v1/events/batch'))

// ===========================================================================
// 1. send → pending → ack settling
// ===========================================================================

describe('outbox.send → pending → ack settling', () => {
  it('renders a pending row instantly, then settles it to the server sequence', async () => {
    const { db, server, outbox } = makeOutbox()
    server.pauseBatch() // hold the drain so the pending state is observable

    const res = await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'hello' })

    // Pending: one row, state 'pending', created_seq === created_at sentinel, no event yet.
    const before = await db.getAllMessages()
    expect(before).toHaveLength(1)
    expect(before[0]?.state).toBe('pending')
    expect(before[0]?.created_seq).toBe(res.created_seq)
    expect(before[0]?.message_id).toBe(res.message_id)
    expect(await db.count('outbox')).toBe(1)
    expect(await db.count('events')).toBe(0)

    // Let the drain settle against the server (assigns seq 1).
    server.resumeBatch()
    await untilAsync(async () => (await db.count('outbox')) === 0)

    const after = await db.getAllMessages()
    expect(after).toHaveLength(1)
    expect(after[0]?.state).toBeUndefined() // settled → marker dropped
    expect(after[0]?.created_seq).toBe(1) // real server sequence
    expect(after[0]?.message_id).toBe(res.message_id)
    expect(await db.count('outbox')).toBe(0)
    expect(await db.count('events')).toBe(1)
  })

  it('throws not_authenticated when there is no session', async () => {
    const { outbox } = makeOutbox({
      authStatus: (): AuthStatus => ({ authenticated: false }),
    })
    await expect(outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'x' })).rejects.toThrow(
      /authenticated/,
    )
  })
})

// ===========================================================================
// 2. pending is readable immediately with no network (offline)
// ===========================================================================

describe('pending is readable immediately with no network', () => {
  it('inserts the pending row and posts nothing while offline', async () => {
    const { db, http, outbox } = makeOutbox({ canDrain: () => false }) // offline: not live

    const res = await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'offline' })
    await flush()

    expect(await db.getMessage(res.message_id)).toMatchObject({ state: 'pending' })
    expect(await db.count('outbox')).toBe(1)
    expect(batchPosts(http)).toHaveLength(0) // sits queued — no POST while offline
  })
})

// ===========================================================================
// 3. offline compose → reconnect drain (direct: the drain gate)
// ===========================================================================

describe('offline compose → reconnect drain', () => {
  it('holds queued while offline, then flushes when the gate opens', async () => {
    let live = false
    const { db, http, outbox } = makeOutbox({ canDrain: () => live })

    const res = await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'later' })
    await flush()
    expect(batchPosts(http)).toHaveLength(0)
    expect(await db.getMessage(res.message_id)).toMatchObject({ state: 'pending' })

    // Connectivity resumes → the rising-edge kick drains.
    live = true
    outbox.drain()
    await untilAsync(async () => (await db.count('outbox')) === 0)

    expect(batchPosts(http)).toHaveLength(1)
    expect(await db.getMessage(res.message_id)).toMatchObject({ created_seq: 1 })
    expect((await db.getMessage(res.message_id))?.state).toBeUndefined()
  })
})

// ===========================================================================
// 4. reject → failed + retry / delete, no wedge
// ===========================================================================

describe('reject → failed, queue not wedged, retry + delete', () => {
  it('parks the rejected event as failed while the rest of the batch settles', async () => {
    const { db, server, outbox } = makeOutbox()
    server.pauseBatch()

    const a = await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'A (reject)' })
    server.rejectEvent(a.event_id, 'permission_denied')
    const b = await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'B (accept)' })

    server.resumeBatch()
    await untilAsync(async () => (await db.getOutbox(a.event_id))?.state === 'rejected')
    await untilAsync(async () => (await db.getOutbox(b.event_id)) === undefined)

    // A: failed projection row + rejected outbox row (parked, code surfaced).
    const aMsg = await db.getMessage(a.message_id)
    expect(aMsg?.state).toBe('failed')
    expect(aMsg?.error_code).toBe('permission_denied')
    expect((await db.getOutbox(a.event_id))?.state).toBe('rejected')
    // B: settled despite A poisoning the batch — the queue is not wedged.
    expect((await db.getMessage(b.message_id))?.state).toBeUndefined()
    expect(await db.getOutbox(b.event_id)).toBeUndefined()

    // retry(A): re-queue, now the server accepts → A settles.
    server.allowEvent(a.event_id)
    await outbox.retry(a.event_id)
    await untilAsync(async () => (await db.getOutbox(a.event_id)) === undefined)
    const aSettled = await db.getMessage(a.message_id)
    expect(aSettled?.state).toBeUndefined()
    expect(aSettled?.created_seq).toBeGreaterThan(0)
  })

  it('delete removes both the failed projection row and its outbox row', async () => {
    const { db, server, outbox } = makeOutbox()
    server.pauseBatch()
    const c = await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'C (reject)' })
    server.rejectEvent(c.event_id, 'payload_too_large')
    server.resumeBatch()
    await untilAsync(async () => (await db.getMessage(c.message_id))?.state === 'failed')

    await outbox.delete(c.event_id)

    expect(await db.getMessage(c.message_id)).toBeUndefined()
    expect(await db.getOutbox(c.event_id)).toBeUndefined()
  })

  it('retry is a no-op on an unknown / non-rejected id', async () => {
    const { outbox } = makeOutbox()
    await expect(outbox.retry('e_nope')).resolves.toEqual({ ok: true })
  })
})

// ===========================================================================
// 5. idempotent double-drain / crash-mid-send
// ===========================================================================

describe('idempotent double-drain (crash-mid-send)', () => {
  it('a re-run of an in-flight (sending) row yields exactly one settled event', async () => {
    let live = false
    const { db, server, outbox } = makeOutbox({ canDrain: () => live })

    const res = await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'crashy' })
    // Simulate a crash mid-send: the row was marked `sending` but never acked.
    const row = await db.getOutbox(res.event_id)
    if (!row) throw new Error('missing outbox row')
    await db.putOutbox([{ ...row, state: 'sending' }])

    live = true
    outbox.drain()
    outbox.drain() // re-enter / double-drain the same event
    await untilAsync(async () => (await db.count('outbox')) === 0)

    const msgs = await db.getAllMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.state).toBeUndefined()
    expect(await db.count('events')).toBe(1)
    expect(await db.count('outbox')).toBe(0)
    // The server (UNIQUE event_id) consumed exactly one sequence.
    expect(server.head('s_1')).toBe(1)
  })
})

// ===========================================================================
// 6. eviction never touches outbox
// ===========================================================================

describe('eviction never touches the outbox', () => {
  it('evictStream + clearDerivedTables leave outbox rows intact', async () => {
    const { db, outbox } = makeOutbox({ canDrain: () => false })
    await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'a' })
    await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'b' })
    expect(await db.count('outbox')).toBe(2)

    const core = new WorkerCore(db, () => {
      /* no sink output */
    })
    await core.evictStream('s_1')
    await db.clearDerivedTables() // the logout lean-wipe

    expect(await db.count('outbox')).toBe(2) // untouched by both
    const rows = await db.listOutbox()
    expect(rows.every((r) => r.state === 'queued')).toBe(true)
  })
})

// ===========================================================================
// 7. backoff reuse + coalescing
// ===========================================================================

describe('drain backoff reuse + coalescing', () => {
  it('schedules retries on the shared backoff curve, growing toward the cap', async () => {
    const clock = new FakeClock()
    const { server, http, outbox } = makeOutbox({
      canDrain: () => true,
      setTimeout: clock.setTimeout,
      random: () => 0.5, // deterministic jitter: delay = base/2 + 0.5·base/2 = 0.75·base
    })
    server.batchError = { status: 0, code: 'network', title: 'Network error' }

    await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'x' })
    await flush()
    expect(batchPosts(http)).toHaveLength(1) // first attempt failed
    expect(clock.pending).toBe(1) // a retry is scheduled

    // attempt 0: base 1000 → delay 750. Not fired a tick early.
    clock.advance(749)
    await flush()
    expect(batchPosts(http)).toHaveLength(1)
    clock.advance(1)
    await flush()
    expect(batchPosts(http)).toHaveLength(2) // retry fired at exactly 750

    // attempt 1: base 2000 → delay 1500 (grows toward the 30s cap).
    clock.advance(1499)
    await flush()
    expect(batchPosts(http)).toHaveLength(2)
    clock.advance(1)
    await flush()
    expect(batchPosts(http)).toHaveLength(3)
  })

  it('coalesces concurrent sends into a single in-flight batch POST', async () => {
    const { db, server, http, outbox } = makeOutbox()
    server.pauseBatch()

    await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'a' })
    await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'b' })
    await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'c' })

    expect(http.maxInFlight).toBeLessThanOrEqual(1) // one drain in flight at a time

    server.resumeBatch()
    await untilAsync(async () => (await db.count('outbox')) === 0)
    expect(await db.count('events')).toBe(3) // all three settled
    expect(http.maxInFlight).toBeLessThanOrEqual(1) // never two batch POSTs at once
  })
})

// ===========================================================================
// 8. token never leaks
// ===========================================================================

describe('token never leaks through the outbox', () => {
  it('the send result + drain body carry only author fields, no token', async () => {
    const { http, outbox } = makeOutbox()

    const res = await outbox.send({ m: 'outbox.send', stream_id: 's_1', text: 'safe' })
    await flush()

    expect(Object.keys(res).sort()).toEqual(['created_seq', 'event_id', 'message_id'])
    const post = batchPosts(http)[0]
    const events = (post?.body as { events: Record<string, unknown>[] }).events
    for (const ev of events) {
      expect(Object.keys(ev).sort()).toEqual(['body', 'event_hash'])
    }
    expect(JSON.stringify(http.postCalls).toLowerCase()).not.toContain('token')
    expect(JSON.stringify(res).toLowerCase()).not.toContain('token')
  })
})

// ===========================================================================
// 9. ack-vs-WS-frame dedup race — BOTH arrival orders → one row
//    (integration through WorkerCore: the real default projection seam + the
//     real sync engine apply path, both keyed on message_id.)
// ===========================================================================

async function seedSession(db: MsgDb): Promise<void> {
  await db.metaPut(META_PROJECTION_VERSION, PROJECTION_VERSION)
  await db.metaPut(META_SESSION_TOKEN, 'tok_secret')
  await db.metaPut(META_MY_USER_ID, 'u_me')
  await db.metaPut(META_WORKSPACE_ID, 'w_me')
  await db.metaPut(META_ROLE, 'member')
  await db.metaPut(META_SESSION_EXPIRES_AT, '2099-01-01T00:00:00Z')
  await db.metaPut(META_DEVICE_ID, 'd_me')
}

let rpcId = 0
async function rpc(
  core: WorkerCore,
  frames: Array<{ clientId: string; msg: FromWorker }>,
  method: 'query' | 'mutate',
  params: unknown,
): Promise<unknown> {
  const id = `rpc${++rpcId}`
  await core.handle('c1', {
    t: 'req',
    id,
    clientId: 'c1',
    req: { method, params } as never,
  })
  const found = [...frames].reverse().find((f) => f.msg.t === 'res' && f.msg.id === id)?.msg
  if (!found || found.t !== 'res') throw new Error(`no res frame for ${id}`)
  if (!found.ok) throw new Error(`rpc error: ${JSON.stringify(found.error)}`)
  return found.result
}

async function makeLiveCore(server: FakeSyncServer): Promise<{
  db: MemoryDb
  core: WorkerCore
  frames: Array<{ clientId: string; msg: FromWorker }>
  last: () => ReturnType<ReturnType<typeof makeFakeWsFactory>['last']>
}> {
  const db = new MemoryDb()
  await seedSession(db)
  const http = new FakeHttpClient(server)
  const { wsFactory, last } = makeFakeWsFactory()
  const { sink, frames } = collectingSink()
  const core = new WorkerCore(db, sink, { http, wsFactory })
  await core.init()
  last().open()
  await flush()
  return { db, core, frames, last }
}

describe('ack-vs-WS-frame dedup race — exactly one row in either order', () => {
  it('(a) WS frame first, then ack → one settled row', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's_race', head_seq: 0 })
    const { db, core, frames, last } = await makeLiveCore(server)

    // Send, but hold the client's batch POST so we control ordering.
    server.pauseBatch()
    const res = (await rpc(core, frames, 'mutate', {
      m: 'outbox.send',
      stream_id: 's_race',
      text: 'race A',
    })) as SendResult

    // Server processes the event (assigns seq 1) and pushes the WS frame FIRST.
    const row = await db.getOutbox(res.event_id)
    if (!row) throw new Error('missing outbox row')
    server.processBatch([{ body: row.body as never, event_hash: row.event_hash }])
    const wire = server.wireFor(res.event_id)
    if (!wire) throw new Error('missing wire event')
    last().emitEvent(wire)
    await flush()

    // The client's batch POST completes second (idempotent original accept).
    server.resumeBatch()
    await untilAsync(async () => (await db.count('outbox')) === 0)

    const rows = await db.getAllMessages()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.created_seq).toBe(1)
    expect(rows[0]?.state).toBeUndefined()
    expect(await db.count('events')).toBe(1)
    expect(await db.count('outbox')).toBe(0)
    await db.close()
  })

  it('(b) ack first, then WS frame → identical one-row end state', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's_race', head_seq: 0 })
    const { db, core, frames, last } = await makeLiveCore(server)

    const res = (await rpc(core, frames, 'mutate', {
      m: 'outbox.send',
      stream_id: 's_race',
      text: 'race B',
    })) as SendResult
    // The auto-drain settles the ack first.
    await untilAsync(async () => (await db.count('outbox')) === 0)

    // The WS frame for the same event arrives second.
    const wire = server.wireFor(res.event_id)
    if (!wire) throw new Error('missing wire event')
    last().emitEvent(wire)
    await flush()

    const rows = await db.getAllMessages()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.created_seq).toBe(1)
    expect(rows[0]?.state).toBeUndefined()
    expect(await db.count('events')).toBe(1)
    expect(await db.count('outbox')).toBe(0)
    await db.close()
  })
})

// ===========================================================================
// 10. the rising edge into `live` auto-sends a queued (offline) message (§4)
// ===========================================================================

describe('WorkerCore drains the outbox on the rising edge into live', () => {
  it('a message composed before live sits queued, then sends itself at live', async () => {
    const server = new FakeSyncServer()
    server.addStream({ stream_id: 's_edge', head_seq: 0 })
    const db = new MemoryDb()
    await seedSession(db)
    const http = new FakeHttpClient(server)
    const { wsFactory, last } = makeFakeWsFactory()
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(db, sink, { http, wsFactory })
    await core.init() // sync is `connecting`, NOT live → drain gated

    const res = (await rpc(core, frames, 'mutate', {
      m: 'outbox.send',
      stream_id: 's_edge',
      text: 'composed offline',
    })) as SendResult
    await flush()
    expect(batchPosts(http)).toHaveLength(0) // queued: not live yet
    expect((await db.getMessage(res.message_id))?.state).toBe('pending')

    // Reach `live` → the rising-edge kick flushes the queue.
    last().open()
    await untilAsync(async () => (await db.count('outbox')) === 0)

    expect(batchPosts(http).length).toBeGreaterThanOrEqual(1)
    expect((await db.getMessage(res.message_id))?.state).toBeUndefined()
    expect((await db.getMessage(res.message_id))?.created_seq).toBe(1)
    await db.close()
  })
})
