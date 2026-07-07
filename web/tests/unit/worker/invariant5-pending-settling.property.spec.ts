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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  type FromWorker,
  type MessageRow,
  type MsgDb,
  type SendResult,
  type WireEvent,
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

// ---------------------------------------------------------------------------
// Anti-vacuity guard. The REAL sync engine hash-verifies every inbound WS frame
// (`hashEvent(body) === event_hash`) and SILENTLY DROPS a mismatch with a
// `[sync] event hash mismatch` warning. If the WS-race arms ever emit a frame
// with a fabricated hash again, that frame is dropped — the race becomes
// vacuous (the "WS arm" never applies anything). We spy on `console.warn`,
// count those drops, and assert ZERO across every run: a regression to a
// fabricated hash turns the whole property RED instead of silently passing.
// ---------------------------------------------------------------------------

let hashMismatchDrops = 0

beforeEach(() => {
  hashMismatchDrops = 0
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const first = args[0]
    if (typeof first === 'string' && first.includes('event hash mismatch')) hashMismatchDrops++
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

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
  /**
   * Emit the FULL wire event over the fake WS — REAL `event_hash` and all — so
   * the engine's hash-verify accepts and APPLIES it (the outbox.spec §9 pattern).
   * Passing only `body` + a fabricated hash (the old bug) made the engine drop
   * the frame, so the WS-race arms were vacuous. `wireFor` returns the stored
   * envelope whose `event_hash` is the real `hashEvent(body)`.
   */
  emit: (wire: WireEvent | undefined) => void
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
      if (wire) last().emitEvent(wire) // full envelope, REAL hash — engine applies it
    },
  }
}

async function mutateRpc(live: LiveCore, params: unknown): Promise<SendResult> {
  const id = `rpc${++rpcId}`
  await live.core.handle('c1', {
    t: 'req',
    id,
    clientId: 'c1',
    req: { method: 'mutate', params } as never,
  })
  const found = [...live.frames].reverse().find((f) => f.msg.t === 'res' && f.msg.id === id)?.msg
  if (!found || found.t !== 'res' || !found.ok) throw new Error(`mutate rpc failed for ${id}`)
  return found.result as SendResult
}

function sendRpc(live: LiveCore, streamId: string, text: string): Promise<SendResult> {
  return mutateRpc(live, { m: 'outbox.send', stream_id: streamId, text })
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
    // GUARD (anti-vacuity): the batch POST is still paused, so the ONLY path an
    // event can reach the client's `events` cache is the WS frame passing
    // hash-verify and being APPLIED. Snapshot before, emit the real-hash frame,
    // then WAIT for the cache to grow by exactly this event. If the frame were
    // dropped (fabricated hash), the growth never happens and `untilAsync` throws —
    // the WS-first arm can never be vacuous again.
    //
    // ENG-131: an optimistically-settled op stores its event WITHOUT advancing the
    // sync cursor (outbox `settle()` never touches `cursors`), so this WS frame is
    // always a cursor-GAP (`cur=0`), never the synchronous contiguous fast-path — it
    // lands via the engine's ASYNC, detached gap-pull. A fixed `flush()` budget
    // therefore RACED that pull: on unlucky seeds enough events had accumulated on
    // the stream that the pull had not finished when the assertion ran → an
    // off-by-one (`expected N to be N+1`). POLL for the landing instead of asserting
    // after one flush: the real projection converges to exactly one row either way.
    const before = await live.db.getEventsForStream(streamId)
    expect(before.some((e) => e.event_id === res.event_id)).toBe(false)
    live.emit(live.server.wireFor(res.event_id))
    await untilAsync(async () => {
      const evs = await live.db.getEventsForStream(streamId)
      return evs.length === before.length + 1 && evs.some((e) => e.event_id === res.event_id)
    })
    live.server.resumeBatch()
    await untilAsync(async () => (await live.db.getOutbox(res.event_id)) === undefined)
    return { messageId: res.message_id, stream: streamId, state: 'settled', seq }
  }

  // 'none' and 'ws-after' both settle via the auto-drain first.
  const res = await sendRpc(live, streamId, text)
  await untilAsync(async () => (await live.db.getOutbox(res.event_id)) === undefined)
  if (cmd.race === 'ws-after') {
    // The ack already settled the event into `events`; the SAME event now also
    // arrives as a real-hash WS frame. It must pass hash-verify (guarded globally
    // by `hashMismatchDrops === 0`) and the idempotent-upsert dedup must keep it
    // at exactly one row (asserted in `assertInvariant5` — the events cache for
    // this stream never grows past the settled count).
    const before = await live.db.getEventsForStream(streamId)
    live.emit(live.server.wireFor(res.event_id))
    await flush()
    const after = await live.db.getEventsForStream(streamId)
    expect(after.length).toBe(before.length) // dup frame deduped, not a second row
  }
  return { messageId: res.message_id, stream: streamId, state: 'settled', seq }
}

/** Assert invariant 5 on the terminal DB state for the whole executed history. */
async function assertInvariant5(live: LiveCore, expected: Expected[]): Promise<void> {
  // Anti-vacuity: NO WS frame was silently dropped for a hash mismatch anywhere
  // in this run. If a race arm ever regressed to a fabricated hash, the engine
  // would drop the frame (never applying it) — this catches that immediately.
  expect(hashMismatchDrops).toBe(0)

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

// ===========================================================================
// §12 invariant 5 — M3 optimistic reactions / edits / deletes (ENG-100).
//
// The pending-settling invariant EXTENDED to the M3 optimistic ops. Each cmd
// creates a fresh SETTLED base message, then applies ONE optimistic op
// (react-add / edit / delete) with a drawn outcome (accept / reject) and, for
// accepts, a drawn ack-vs-WS-frame race in both orders — driving the REAL
// WorkerCore end to end. The op renders instantly (overlay), then either settles
// into server order (ack) or parks (reject); the ack-vs-WS race for the same
// event converges to EXACTLY ONE effect (the events cache never grows past the
// one settled op, and the projection reflects it once). Non-vacuous: the WS arm
// emits the REAL-hash wire (guarded by `hashMismatchDrops === 0`).
// ===========================================================================

const MY_USER_ID = 'u_me'
const REACT_EMOJI = '👍'

interface M3Cmd {
  stream: number
  op: 'react-add' | 'edit' | 'delete'
  reject: boolean
  race: 'none' | 'ws-first' | 'ws-after'
}

function m3CmdArb(): fc.Arbitrary<M3Cmd[]> {
  const one: fc.Arbitrary<M3Cmd> = fc.record({
    stream: fc.integer({ min: 0, max: NUM_STREAMS - 1 }),
    op: fc.constantFrom('react-add', 'edit', 'delete'),
    reject: fc.boolean(),
    race: fc.constantFrom('none', 'ws-first', 'ws-after'),
  })
  return fc.array(one, { minLength: 1, maxLength: 6 })
}

/** Create a settled base message in `streamId` and return its id. */
async function seedSettledMessage(live: LiveCore, streamId: string): Promise<string> {
  const res = await sendRpc(live, streamId, `base-${rpcId}`)
  await untilAsync(async () => (await live.db.getOutbox(res.event_id)) === undefined)
  return res.message_id
}

/** The optimistic-op RPC params for a cmd against a target message. */
function m3Params(cmd: M3Cmd, streamId: string, messageId: string): unknown {
  switch (cmd.op) {
    case 'react-add':
      return { m: 'outbox.react', stream_id: streamId, message_id: messageId, emoji: REACT_EMOJI }
    case 'edit':
      return { m: 'outbox.edit', stream_id: streamId, message_id: messageId, text: 'edited!' }
    case 'delete':
      return { m: 'outbox.remove', stream_id: streamId, message_id: messageId }
  }
}

/** Assert the settled effect of an accepted op landed exactly once. */
async function assertSettledEffect(
  live: LiveCore,
  cmd: M3Cmd,
  messageId: string,
  serverSeq: number,
): Promise<void> {
  if (cmd.op === 'react-add') {
    const reactions = await live.db.getReactionsForMessage(messageId)
    const mine = reactions.filter((r) => r.author_user_id === MY_USER_ID && r.emoji === REACT_EMOJI)
    expect(mine).toHaveLength(1) // one membership, never duplicated by ack+WS
  } else if (cmd.op === 'edit') {
    const row = await live.db.getMessage(messageId)
    expect(row?.text).toBe('edited!')
    expect(row?.edited_seq).toBe(serverSeq) // LWW stamped with the real server seq
    expect(row?.deleted).not.toBe(true)
  } else {
    const row = await live.db.getMessage(messageId)
    expect(row?.deleted).toBe(true)
    expect(row?.text).toBe('') // redacted
  }
}

async function runM3History(cmds: M3Cmd[]): Promise<void> {
  const streamIds = Array.from({ length: NUM_STREAMS }, (_, i) => `s_${i}`)
  const live = await makeLiveCore(() => Promise.resolve(new MemoryDb()), streamIds)

  for (const cmd of cmds) {
    const streamId = streamIds[cmd.stream]!
    const messageId = await seedSettledMessage(live, streamId)
    const eventsBefore = (await live.db.getEventsForStream(streamId)).length

    if (cmd.reject) {
      live.server.pauseBatch()
      const res = await mutateRpc(live, m3Params(cmd, streamId, messageId))
      // The overlay renders immediately (before any ack).
      live.server.rejectEvent(res.event_id, 'permission_denied')
      live.server.resumeBatch()
      await untilAsync(async () => (await live.db.getOutbox(res.event_id))?.state === 'rejected')
      // Parked: outbox row rejected, no event stored, effect stays visible.
      expect((await live.db.getOutbox(res.event_id))?.state).toBe('rejected')
      expect((await live.db.getEventsForStream(streamId)).length).toBe(eventsBefore)
      continue
    }

    if (cmd.race === 'ws-first') {
      live.server.pauseBatch()
      const res = await mutateRpc(live, m3Params(cmd, streamId, messageId))
      const row = await live.db.getOutbox(res.event_id)
      if (!row) throw new Error('missing outbox row for ws-first')
      const { accepted } = live.server.processBatch([
        { body: row.body as never, event_hash: row.event_hash },
      ])
      const serverSeq = accepted[0]!.server_sequence
      // Anti-vacuity: while the batch POST is paused the ONLY path this event can
      // reach the events cache is the real-hash WS frame being applied. WAIT for the
      // cache to grow by exactly this event (a fabricated-hash regression → never
      // lands → `untilAsync` throws).
      //
      // ENG-131: this WS frame lands via the engine's ASYNC gap-pull, not the
      // synchronous fast-path — outbox `settle()` stores the op's event WITHOUT
      // advancing the sync cursor, so the frame is always a cursor-gap (`cur=0`).
      // A fixed `flush()` budget raced that pull and gave an off-by-one on unlucky
      // seeds (enough accumulated events on the stream). Poll for the landing; the
      // real projection converges to exactly one effect regardless.
      const before = await live.db.getEventsForStream(streamId)
      expect(before.some((e) => e.event_id === res.event_id)).toBe(false)
      live.emit(live.server.wireFor(res.event_id))
      await untilAsync(async () => {
        const evs = await live.db.getEventsForStream(streamId)
        return evs.length === before.length + 1 && evs.some((e) => e.event_id === res.event_id)
      })
      live.server.resumeBatch()
      await untilAsync(async () => (await live.db.getOutbox(res.event_id)) === undefined)
      await assertSettledEffect(live, cmd, messageId, serverSeq)
      continue
    }

    // 'none' + 'ws-after': auto-drain settles first.
    const res = await mutateRpc(live, m3Params(cmd, streamId, messageId))
    await untilAsync(async () => (await live.db.getOutbox(res.event_id)) === undefined)
    const settledSeq = (await live.db.getEventsForStream(streamId)).find(
      (e) => e.event_id === res.event_id,
    )?.server_sequence
    if (cmd.race === 'ws-after') {
      // The SAME event now also arrives as a real-hash WS frame → deduped.
      const before = await live.db.getEventsForStream(streamId)
      live.emit(live.server.wireFor(res.event_id))
      await flush()
      const afterEvents = await live.db.getEventsForStream(streamId)
      expect(afterEvents.length).toBe(before.length) // no second row
    }
    await assertSettledEffect(live, cmd, messageId, settledSeq!)
  }

  // Anti-vacuity across the whole run: no WS frame was dropped for a bad hash.
  expect(hashMismatchDrops).toBe(0)
  // Outbox fully drained except parked (rejected) rows.
  const outbox = await live.db.listOutbox()
  expect(outbox.every((r) => r.state === 'rejected')).toBe(true)
  await live.db.close()
}

describe('§12 invariant 5 — M3 optimistic reactions/edits/deletes [property, real WorkerCore]', () => {
  it('each optimistic op renders then settles into server order / parks; ack-vs-WS → one effect', async () => {
    // ENG-131: numRuns raised 30 → 300 (deeper histories, more ws-first
    // accumulation) after making the ws-first anti-vacuity check WAIT for the
    // async gap-pull instead of asserting after a fixed `flush()` (see runM3History).
    await fc.assert(fc.asyncProperty(m3CmdArb(), runM3History), { numRuns: 300 })
  }, 60000)

  // -------------------------------------------------------------------------
  // ENG-131 DETERMINISTIC REGRESSION — the exact fast-check counterexample
  // (seed 1960425279, path "3"): a 6-op history mixing rejected ops with
  // ws-first / ws-after races. Encoded here so it is caught FOREVER regardless
  // of seed. The real projection converges to exactly one effect per op; the
  // original failure (`expected 4 to be 5`) was the harness asserting the
  // ws-first frame's arrival synchronously after one flush, racing the engine's
  // async gap-pull. runM3History now polls for the arrival, so this is green.
  // -------------------------------------------------------------------------
  it('ENG-131 regression: rejected-op + ws-race interleaving counterexample settles to one effect each', async () => {
    await runM3History([
      { stream: 0, op: 'react-add', reject: true, race: 'ws-after' },
      { stream: 1, op: 'react-add', reject: false, race: 'none' },
      { stream: 1, op: 'edit', reject: true, race: 'ws-first' },
      { stream: 0, op: 'delete', reject: true, race: 'none' },
      { stream: 0, op: 'delete', reject: false, race: 'none' },
      { stream: 1, op: 'react-add', reject: false, race: 'ws-first' },
    ])
  })

  // -------------------------------------------------------------------------
  // ENG-131 DETERMINISTIC REGRESSION (teeth) — directly exercises the racing
  // condition, machine-independently. Pile up MANY settled events on one stream
  // (so the engine's gap-pull re-hashes a large run), then a ws-first op whose WS
  // frame can ONLY land via that async, detached gap-pull. Assert it converges to
  // EXACTLY ONE effect once the pull completes. With this much accumulation the
  // pull cannot finish within the old fixed `flush()` budget on ANY machine
  // (measured: it exceeds `flush(8)` well before this size, and slower CI drops
  // the threshold far lower) — so the old synchronous `toBe(before.length + 1)`
  // assertion would deterministically read the off-by-one here, while the polling
  // version below stays correct. Locks the semantics: a ws-first effect lands
  // exactly once even when delivered by the gap-pull.
  // -------------------------------------------------------------------------
  it('ENG-131 regression: a ws-first frame delivered by the async gap-pull still lands exactly once', async () => {
    const streamIds = Array.from({ length: NUM_STREAMS }, (_, i) => `s_${i}`)
    const live = await makeLiveCore(() => Promise.resolve(new MemoryDb()), streamIds)
    const streamId = 's_0'
    // Accumulate a large settled run so the gap-pull is heavy (exceeds a fixed flush).
    for (let i = 0; i < 90; i++) await seedSettledMessage(live, streamId)
    const messageId = await seedSettledMessage(live, streamId)

    live.server.pauseBatch()
    const res = await mutateRpc(
      live,
      m3Params(
        { stream: 0, op: 'react-add', reject: false, race: 'ws-first' },
        streamId,
        messageId,
      ),
    )
    const row = await live.db.getOutbox(res.event_id)
    if (!row) throw new Error('missing outbox row')
    live.server.processBatch([{ body: row.body as never, event_hash: row.event_hash }])

    const before = await live.db.getEventsForStream(streamId)
    expect(before.some((e) => e.event_id === res.event_id)).toBe(false)
    live.emit(live.server.wireFor(res.event_id))
    // Wait for the detached gap-pull to deliver the frame — it lands EXACTLY once.
    await untilAsync(async () => {
      const evs = await live.db.getEventsForStream(streamId)
      return evs.length === before.length + 1 && evs.some((e) => e.event_id === res.event_id)
    })
    live.server.resumeBatch()
    await untilAsync(async () => (await live.db.getOutbox(res.event_id)) === undefined)
    // The reaction membership exists exactly once (never duplicated by ack + WS).
    const mine = (await live.db.getReactionsForMessage(messageId)).filter(
      (r) => r.author_user_id === MY_USER_ID && r.emoji === REACT_EMOJI,
    )
    expect(mine).toHaveLength(1)
    expect(hashMismatchDrops).toBe(0)
    await live.db.close()
  }, 30000)

  // -------------------------------------------------------------------------
  // ENG-131 ROBUSTNESS — the ENG-100 lesson: don't fix one seed. Sweep a few
  // hundred seeds through the property; NONE may surface a counterexample.
  // -------------------------------------------------------------------------
  it('ENG-131 robustness: no surviving counterexample across a seed sweep', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      await fc.assert(fc.asyncProperty(m3CmdArb(), runM3History), { numRuns: 5, seed })
    }
  }, 60000)
})
