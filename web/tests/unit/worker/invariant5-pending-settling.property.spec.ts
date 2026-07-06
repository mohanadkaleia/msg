// PERMANENT GATE — §12 invariant 5 (pending settling), PROPERTY-BASED.
//
// This is the property elevation of the ENG-81 outbox unit tests. fast-check
// generates randomized send histories across multiple streams (accept, reject,
// and the ack-vs-WS-frame race in BOTH arrival orders) and drives the REAL
// `WorkerCore` — the actual outbox drain, settle, reject, and projection seam —
// against the hermetic `FakeSyncServer` (real per-stream sequencing + `event_id`
// UNIQUE idempotency) with an injected fake WS. NOTHING about the message
// lifecycle is re-modelled here: the test only *generates histories* and
// *asserts the invariant on the resulting DB state*.
//
// Invariant 5 (TDD §12): every optimistically-sent message the server accepts
// ends in exactly ONE projection row, in correct server order
// (created_seq === server_sequence), with no lost and no duplicated renders;
// rejected sends end `failed` without corrupting other rows; the ack-vs-WS race
// always converges to one row (both orders).
//
// TEETH: set MSG_MUTATE=inv5-drop-ack to wrap the db so settled rows never
// persist (models a "lost acked render" regression) — the invariant then fails.
// Unset (CI default) the suite is green. See the design note for the exact
// command + observed failure.

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { WorkerCore } from '../../../src/worker/core'
import { MemoryDb, openDb } from '../../../src/worker/db'
import {
  META_DEVICE_ID,
  META_MY_USER_ID,
  META_PROJECTION_VERSION,
  META_ROLE,
  META_SESSION_EXPIRES_AT,
  META_SESSION_TOKEN,
  META_WORKSPACE_ID,
  PROJECTION_VERSION,
  type EventBody,
  type FromWorker,
  type MessageRow,
  type MsgDb,
  type SendResult,
} from '../../../src/worker/types'

import {
  collectingSink,
  fakeIdbOptions,
  FakeHttpClient,
  FakeSyncServer,
  flush,
  makeFakeWsFactory,
  untilAsync,
} from './helpers'

// ---------------------------------------------------------------------------
// TEETH — an env-gated mutant db (see the design note). Under
// MSG_MUTATE=inv5-drop-ack, a settled row (state absent + a real server
// created_seq, i.e. NOT the ms-epoch pending sentinel) silently fails to
// persist — modelling a client that loses acked messages. The real engine runs
// unchanged on top of this buggy persistence layer; invariant 5 catches it.
// ---------------------------------------------------------------------------

const MUTATION = process.env.MSG_MUTATE

/** A pending sentinel `created_seq` is a wall-clock ms epoch (> ~1e12). */
const PENDING_SENTINEL_FLOOR = 1_000_000_000_000

function maybeMutate(db: MsgDb): MsgDb {
  if (MUTATION !== 'inv5-drop-ack') return db
  const realPut = db.putMessages.bind(db)
  db.putMessages = (rows: readonly MessageRow[]): Promise<void> => {
    // Drop settled rows (no lifecycle marker + a real, non-sentinel sequence).
    const kept = rows.filter(
      (r) => r.state !== undefined || r.created_seq >= PENDING_SENTINEL_FLOOR,
    )
    return realPut(kept)
  }
  return db
}

// ---------------------------------------------------------------------------
// Real-engine harness: seed an authed session, boot a WorkerCore over the
// injected fake HTTP + fake WS, and drive it through the RPC surface.
// ---------------------------------------------------------------------------

async function seedSession(db: MsgDb): Promise<void> {
  await db.metaPut(META_PROJECTION_VERSION, PROJECTION_VERSION)
  await db.metaPut(META_SESSION_TOKEN, 'tok_secret')
  await db.metaPut(META_MY_USER_ID, 'u_me')
  await db.metaPut(META_WORKSPACE_ID, 'w_me')
  await db.metaPut(META_ROLE, 'member')
  await db.metaPut(META_SESSION_EXPIRES_AT, '2099-01-01T00:00:00Z')
  await db.metaPut(META_DEVICE_ID, 'd_me')
}

interface LiveCore {
  db: MsgDb
  core: WorkerCore
  frames: Array<{ clientId: string; msg: FromWorker }>
  server: FakeSyncServer
  wsOpen: () => void
  emit: (wire: EventBody | undefined) => void
}

let rpcId = 0

async function makeLiveCore(makeDb: () => Promise<MsgDb>, streams: string[]): Promise<LiveCore> {
  const db = maybeMutate(await makeDb())
  await seedSession(db)
  const server = new FakeSyncServer()
  // No `head_seq`: passing 0 would pin a permanent headOverride, so server.head()
  // would never reflect appended events. Omitting it lets head track the log.
  for (const s of streams) server.addStream({ stream_id: s })
  const http = new FakeHttpClient(server)
  const { wsFactory, last } = makeFakeWsFactory()
  const { sink, frames } = collectingSink()
  const core = new WorkerCore(db, sink, { http, wsFactory })
  await core.init()
  last().open()
  await flush()
  return {
    db,
    core,
    frames,
    server,
    wsOpen: () => last().open(),
    emit: (wire) => {
      if (wire) last().emitEvent({ body: wire, event_hash: `sha256:${String(wire.event_id)}` })
    },
  }
}

async function sendRpc(live: LiveCore, streamId: string, text: string): Promise<SendResult> {
  const id = `rpc${++rpcId}`
  await live.core.handle('c1', {
    t: 'req',
    id,
    clientId: 'c1',
    req: { method: 'mutate', params: { m: 'outbox.send', stream_id: streamId, text } } as never,
  })
  const found = [...live.frames].reverse().find((f) => f.msg.t === 'res' && f.msg.id === id)?.msg
  if (!found || found.t !== 'res' || !found.ok) throw new Error(`send rpc failed for ${id}`)
  return found.result as SendResult
}

// ---------------------------------------------------------------------------
// The generated command: one send, with a drawn outcome + race order.
// ---------------------------------------------------------------------------

interface SendCmd {
  stream: number
  /** true → the server rejects this send (→ parked `failed`). */
  reject: boolean
  /** For accepted sends: WS-frame arrival relative to the batch ack. */
  race: 'none' | 'ws-first' | 'ws-after'
}

const NUM_STREAMS = 3

function cmdArb(): fc.Arbitrary<SendCmd[]> {
  const one: fc.Arbitrary<SendCmd> = fc.record({
    stream: fc.integer({ min: 0, max: NUM_STREAMS - 1 }),
    reject: fc.boolean(),
    race: fc.constantFrom('none', 'ws-first', 'ws-after'),
  })
  return fc.array(one, { minLength: 1, maxLength: 7 })
}

/** What we expect the terminal projection to hold for one executed send. */
interface Expected {
  messageId: string
  stream: string
  state: 'settled' | 'failed'
  seq?: number // server_sequence for settled sends
}

/**
 * Execute one send command against the REAL engine to its terminal state, and
 * return the ground-truth expectation. `nextSeq` tracks the per-stream server
 * sequence a fresh accept will be assigned (rejects consume none).
 */
async function runCmd(
  live: LiveCore,
  cmd: SendCmd,
  streamIds: string[],
  nextSeq: number[],
): Promise<Expected> {
  const streamId = streamIds[cmd.stream]!
  const text = `m-${rpcId + 1}`

  if (cmd.reject) {
    live.server.pauseBatch()
    const res = await sendRpc(live, streamId, text)
    live.server.rejectEvent(res.event_id, 'permission_denied')
    live.server.resumeBatch()
    await untilAsync(async () => (await live.db.getOutbox(res.event_id))?.state === 'rejected')
    return { messageId: res.message_id, stream: streamId, state: 'failed' }
  }

  const seq = nextSeq[cmd.stream]!
  nextSeq[cmd.stream] = seq + 1

  if (cmd.race === 'ws-first') {
    // Server processes the event (assigns `seq`) and pushes the WS frame BEFORE
    // the client's batch POST completes — the harder ordering.
    live.server.pauseBatch()
    const res = await sendRpc(live, streamId, text)
    const row = await live.db.getOutbox(res.event_id)
    if (!row) throw new Error('missing outbox row for ws-first')
    live.server.processBatch([{ body: row.body as never, event_hash: row.event_hash }])
    live.emit(live.server.wireFor(res.event_id)?.body)
    await flush()
    live.server.resumeBatch()
    await untilAsync(async () => (await live.db.getOutbox(res.event_id)) === undefined)
    return { messageId: res.message_id, stream: streamId, state: 'settled', seq }
  }

  // 'none' and 'ws-after' both settle via the auto-drain first.
  const res = await sendRpc(live, streamId, text)
  await untilAsync(async () => (await live.db.getOutbox(res.event_id)) === undefined)
  if (cmd.race === 'ws-after') {
    // The duplicate WS frame for the SAME event arrives after settling — the
    // idempotent-upsert dedup must keep it at one row.
    live.emit(live.server.wireFor(res.event_id)?.body)
    await flush()
  }
  return { messageId: res.message_id, stream: streamId, state: 'settled', seq }
}

/** Assert invariant 5 on the terminal DB state for the whole executed history. */
async function assertInvariant5(live: LiveCore, expected: Expected[]): Promise<void> {
  const all = await live.db.getAllMessages()

  // No lost / no duplicated renders: exactly one row per intended send, and no
  // spurious extra rows (e.g. a misfiled row under a server-claimed stream).
  expect(all.length).toBe(expected.length)
  const byId = new Map(all.map((r) => [r.message_id, r]))
  expect(byId.size).toBe(expected.length) // all message_ids distinct

  for (const exp of expected) {
    const row = byId.get(exp.messageId)
    expect(row, `missing projection row for ${exp.messageId}`).toBeDefined()
    if (!row) continue
    expect(row.stream_id).toBe(exp.stream) // never misfiled to another stream
    if (exp.state === 'failed') {
      expect(row.state).toBe('failed')
      expect(row.error_code).toBe('permission_denied')
    } else {
      // Settled: no lifecycle marker, created_seq == the server_sequence.
      expect(row.state).toBeUndefined()
      expect(row.created_seq).toBe(exp.seq)
    }
  }

  // Correct SERVER ORDER per stream: settled rows are gapless 1..n by created_seq
  // and match the server head; the ordering by created_seq equals accept order.
  for (const streamId of new Set(expected.map((e) => e.stream))) {
    const settled = expected
      .filter((e) => e.stream === streamId && e.state === 'settled')
      .sort((a, b) => a.seq! - b.seq!)
    const seqs = settled.map((e) => e.seq!)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)) // gapless from 1
    expect(live.server.head(streamId)).toBe(seqs.length)
    // Events cache holds exactly the settled events for this stream.
    const events = await live.db.getEventsForStream(streamId)
    expect(events.map((e) => e.server_sequence)).toEqual(seqs)
  }

  // Outbox fully drained except parked (rejected) rows — no send stuck mid-flight.
  const outbox = await live.db.listOutbox()
  expect(outbox.every((r) => r.state === 'rejected')).toBe(true)
  expect(outbox.length).toBe(expected.filter((e) => e.state === 'failed').length)
}

// ===========================================================================
// Property 1 — a randomized send history over the REAL WorkerCore satisfies
// invariant 5 for EVERY generated case (MemoryDb, many cases).
// ===========================================================================

describe('§12 invariant 5 — pending settling [property, real WorkerCore]', () => {
  it('every accepted send → exactly one settled row in server order; rejects park cleanly', async () => {
    await fc.assert(
      fc.asyncProperty(cmdArb(), async (cmds) => {
        const streamIds = Array.from({ length: NUM_STREAMS }, (_, i) => `s_${i}`)
        const live = await makeLiveCore(() => Promise.resolve(new MemoryDb()), streamIds)
        const nextSeq = new Array<number>(NUM_STREAMS).fill(1)
        const expected: Expected[] = []
        for (const cmd of cmds) {
          expected.push(await runCmd(live, cmd, streamIds, nextSeq))
        }
        await assertInvariant5(live, expected)
        await live.db.close()
      }),
      { numRuns: 40 },
    )
  })

  // ------------------------------------------------------------------------
  // Property 2 — coalesced burst: many sends enqueued while the batch is paused
  // then released together (genuine in-flight interleaving in ONE batch).
  // ------------------------------------------------------------------------
  it('a coalesced burst of concurrent sends settles to gapless per-stream order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: NUM_STREAMS - 1 }), { minLength: 2, maxLength: 8 }),
        async (streamPicks) => {
          const streamIds = Array.from({ length: NUM_STREAMS }, (_, i) => `s_${i}`)
          const live = await makeLiveCore(() => Promise.resolve(new MemoryDb()), streamIds)

          live.server.pauseBatch() // hold the drain so all sends coalesce
          const results: Array<{ res: SendResult; stream: number }> = []
          for (const pick of streamPicks) {
            results.push({ res: await sendRpc(live, streamIds[pick]!, `b-${rpcId}`), stream: pick })
          }
          // All pending, nothing settled yet.
          expect(await live.db.count('events')).toBe(0)

          live.server.resumeBatch()
          await untilAsync(async () => (await live.db.count('outbox')) === 0)

          // Exactly one settled row per send; per-stream gapless by created_seq.
          const all = await live.db.getAllMessages()
          expect(all.length).toBe(streamPicks.length)
          for (let s = 0; s < NUM_STREAMS; s++) {
            const inStream = all
              .filter((r) => r.stream_id === streamIds[s])
              .sort((a, b) => a.created_seq - b.created_seq)
            const expectedCount = streamPicks.filter((p) => p === s).length
            expect(inStream.length).toBe(expectedCount)
            expect(inStream.map((r) => r.created_seq)).toEqual(
              Array.from({ length: expectedCount }, (_, i) => i + 1),
            )
            expect(inStream.every((r) => r.state === undefined)).toBe(true)
          }
          await live.db.close()
        },
      ),
      { numRuns: 30 },
    )
  })

  // ------------------------------------------------------------------------
  // Property 3 — the SHIPPING db: one drawn history through the real DexieDb
  // (fake-indexeddb) so the persisted settle path is gated, not only MemoryDb.
  // ------------------------------------------------------------------------
  it('settles correctly against the real DexieDb (shipping persistence path)', async () => {
    await fc.assert(
      fc.asyncProperty(cmdArb(), async (cmds) => {
        const streamIds = Array.from({ length: NUM_STREAMS }, (_, i) => `s_${i}`)
        const live = await makeLiveCore(() => openDb(fakeIdbOptions()), streamIds)
        const nextSeq = new Array<number>(NUM_STREAMS).fill(1)
        const expected: Expected[] = []
        for (const cmd of cmds) {
          expected.push(await runCmd(live, cmd, streamIds, nextSeq))
        }
        await assertInvariant5(live, expected)
        await live.db.close()
      }),
      { numRuns: 5 },
    )
  })
})
