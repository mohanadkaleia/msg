// PERMANENT GATE — §12 invariant 6, CLIENT (Dexie) side: rebuild ≡ incremental,
// PROPERTY-BASED. The Dexie analogue of the permanent server equivalence gate.
//
// fast-check generates randomized event histories across streams (message.created
// v1 with unicode / optional thread_root_id / mentions, interleaved with D9-skip
// events: unknown types, v>=2, meta, and malformed-known), PLUS randomized outbox
// rows (pending / failed, and the crash-orphaned "settled but still in outbox"
// case). It applies the history incrementally through the REAL
// `applyEventsToProjection` + the REAL pending derivation, snapshots the REAL
// `dumpMessages`, drops the derived tables, rebuilds through the REAL
// `rebuildProjections` (events replay + outbox re-derive) and asserts the rebuilt
// dump is BYTE-EQUAL to the incremental one — for every generated case.
//
// The property loop runs against MemoryDb for breadth; a dedicated gating
// assertion ALSO replays a drawn history through the real DexieDb (fake-indexeddb)
// so the SHIPPING IndexedDB rebuild path (compound-index ordering, bulkPut upsert,
// the real clearDerivedTables transaction) is what is gated — MemoryDb is a test
// double.
//
// TEETH: set MSG_MUTATE=inv6-rebuild-skew to corrupt one row's text on the REBUILD
// pass only (the ENG-61 HANDLER-monkeypatch pattern) — rebuild != incremental, the
// property fails. Unset (CI default) the suite is green.

import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openDb, MemoryDb, rebuildProjections } from '../../../src/worker/db'
import { buildPendingMessageRow } from '../../../src/worker/outbox'
import {
  applyEventsToProjection,
  applyMessageCreatedV1,
  dumpMessages,
  HANDLERS,
} from '../../../src/worker/projection'
import type { EventRow, MsgDb, OutboxRow } from '../../../src/worker/types'

import { fakeIdbOptions } from './helpers'
import {
  malformedMessageEvent,
  messageCreatedEvent,
  metaEvent,
  unknownTypeEvent,
} from './projfixtures'

const MUTATION = process.env.MSG_MUTATE

// The D9 skip (malformed / unknown / v>=2 events) warns by design; randomized
// histories generate many, so silence the expected noise for readable CI logs.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  HANDLERS['message.created@1'] = applyMessageCreatedV1 // restore after any teeth patch
})

// ---------------------------------------------------------------------------
// Randomized-history materialization. fast-check draws SHAPE choices; a mutable
// counter mints unique ids + per-stream ascending sequences, so every history is
// well-formed (gapless per stream, disjoint message ids) yet fully random.
// ---------------------------------------------------------------------------

const NUM_STREAMS = 3
type EventKind = 'msg' | 'unknown' | 'meta' | 'malformed'

interface EventChoice {
  stream: number
  kind: EventKind
  text: string
  format: 'markdown' | 'plain'
  mentions: string[]
  threadRoot: string | null
}

interface OutboxChoice {
  stream: number
  state: OutboxRow['state']
  text: string
  /** Reuse a settled event's ids → the crash-orphaned "settled-in-outbox" case. */
  orphan: boolean
  errorCode: string | null
}

interface History {
  byStream: Map<string, EventRow[]>
  outbox: OutboxRow[]
  pendingRows: { row: OutboxRow; orphan: boolean }[]
}

const TEXTS = fc.oneof(
  fc.string(),
  fc.constantFrom('', 'unicode 日本語 🎉 ☕', 'multi\nline\ttext', '"quotes" & <html>'),
)

const eventChoiceArb: fc.Arbitrary<EventChoice> = fc.record({
  stream: fc.integer({ min: 0, max: NUM_STREAMS - 1 }),
  kind: fc.constantFrom<EventKind>('msg', 'msg', 'msg', 'unknown', 'meta', 'malformed'),
  text: TEXTS,
  format: fc.constantFrom('markdown', 'plain'),
  mentions: fc.array(fc.constantFrom('u_x', 'u_y', 'u_z'), { maxLength: 3 }),
  threadRoot: fc.option(fc.constantFrom('m_root_1', 'm_root_2'), { nil: null }),
})

const outboxChoiceArb: fc.Arbitrary<OutboxChoice> = fc.record({
  stream: fc.integer({ min: 0, max: NUM_STREAMS - 1 }),
  state: fc.constantFrom<OutboxRow['state']>('queued', 'sending', 'rejected'),
  text: TEXTS,
  orphan: fc.boolean(),
  errorCode: fc.option(fc.constantFrom('permission_denied', 'payload_too_large'), { nil: null }),
})

const historyArb: fc.Arbitrary<{ events: EventChoice[]; outbox: OutboxChoice[] }> = fc.record({
  events: fc.array(eventChoiceArb, { maxLength: 14 }),
  outbox: fc.array(outboxChoiceArb, { maxLength: 6 }),
})

/** Build a well-formed outbox row (the shape the send path mints). */
function outboxRow(opts: {
  eventId: string
  messageId: string
  streamId: string
  createdAt: number
  text: string
  state: OutboxRow['state']
  errorCode?: string
}): OutboxRow {
  return {
    event_id: opts.eventId,
    created_at: opts.createdAt,
    body: {
      event_id: opts.eventId,
      workspace_id: 'w_test',
      stream_id: opts.streamId,
      type: 'message.created',
      type_version: 1,
      author_user_id: 'u_author',
      author_device_id: 'd_test',
      client_created_at: '2026-01-01T00:00:00.000Z',
      payload: {
        message_id: opts.messageId,
        text: opts.text,
        format: 'markdown',
        thread_root_id: null,
        file_ids: [],
        mentions: [],
      },
    },
    event_hash: `sha256:${opts.eventId}`,
    message_id: opts.messageId,
    stream_id: opts.streamId,
    state: opts.state,
    ...(opts.errorCode !== undefined ? { error_code: opts.errorCode } : {}),
  }
}

/** Materialize drawn shape choices into a well-formed, unique-id history. */
function materialize(draw: { events: EventChoice[]; outbox: OutboxChoice[] }): History {
  const streamIds = Array.from({ length: NUM_STREAMS }, (_, i) => `s_${i}`)
  const seqOf = new Array<number>(NUM_STREAMS).fill(0)
  const byStream = new Map<string, EventRow[]>(streamIds.map((s) => [s, []]))
  const settledMsgEvents: { streamId: string; messageId: string; eventId: string }[] = []
  let id = 0

  for (const ec of draw.events) {
    const streamId = streamIds[ec.stream]!
    const seq = ++seqOf[ec.stream]!
    let ev: EventRow
    if (ec.kind === 'unknown') {
      ev = unknownTypeEvent(streamId, seq)
    } else if (ec.kind === 'meta') {
      ev = metaEvent(streamId, seq)
    } else if (ec.kind === 'malformed') {
      ev = malformedMessageEvent(streamId, seq)
    } else {
      const messageId = `m_${++id}`
      ev = messageCreatedEvent({
        streamId,
        seq,
        messageId,
        text: ec.text,
        format: ec.format,
        mentions: ec.mentions,
        ...(ec.threadRoot !== null ? { threadRootId: ec.threadRoot } : {}),
      })
      settledMsgEvents.push({ streamId, messageId, eventId: ev.event_id })
    }
    byStream.get(streamId)!.push(ev)
  }

  const outbox: OutboxRow[] = []
  const pendingRows: { row: OutboxRow; orphan: boolean }[] = []
  for (const oc of draw.outbox) {
    const isOrphan = oc.orphan && settledMsgEvents.length > 0
    if (isOrphan) {
      // Reuse a settled event's ids: the incremental state has the SETTLED row
      // (from events) + a lingering outbox row; rebuild must skip the outbox row.
      const s = settledMsgEvents[id % settledMsgEvents.length]!
      const row = outboxRow({
        eventId: s.eventId,
        messageId: s.messageId,
        streamId: s.streamId,
        createdAt: 1_000 + id,
        text: 'stale-orphan',
        state: oc.state,
      })
      outbox.push(row)
      pendingRows.push({ row, orphan: true })
      id++
      continue
    }
    const messageId = `m_${++id}`
    const eventId = `o_${id}`
    const row = outboxRow({
      eventId,
      messageId,
      streamId: streamIds[oc.stream]!,
      createdAt: 1_700_000_000_000 + id,
      text: oc.text,
      state: oc.state,
      ...(oc.state === 'rejected' && oc.errorCode !== null ? { errorCode: oc.errorCode } : {}),
    })
    outbox.push(row)
    pendingRows.push({ row, orphan: false })
  }

  return { byStream, outbox, pendingRows }
}

/**
 * Reproduce the INCREMENTAL state: settled events applied per stream via the real
 * apply, plus outbox rows with their pending/failed projection rows — exactly as
 * the live send path + WS apply would leave the db. Orphaned outbox rows get NO
 * pending projection row (their event already settled), only the lingering row.
 */
async function buildIncremental(db: MsgDb, h: History): Promise<void> {
  for (const [streamId, events] of h.byStream) {
    if (events.length === 0) continue
    await db.putEvents(events)
    await applyEventsToProjection(db, streamId, events)
  }
  if (h.outbox.length > 0) await db.putOutbox(h.outbox)
  for (const { row, orphan } of h.pendingRows) {
    if (orphan) continue // already settled from events — no pending echo
    const pending = buildPendingMessageRow(row)
    if (pending) await db.putMessages([pending])
  }
}

/**
 * Rebuild through the REAL `rebuildProjections`. Under the env-gated teeth flag
 * (`MSG_MUTATE=inv6-rebuild-skew`) the `message.created@1` HANDLER is corrupted
 * for the REBUILD PASS ONLY (the ENG-61 pattern) — the incremental pass always
 * ran with the clean handler — so the SAME `rebuild === incremental` gate
 * assertion below goes red. The patch is reverted immediately so the next
 * property iteration's incremental pass is clean.
 */
async function rebuildMaybeSkewed(db: MsgDb): Promise<void> {
  if (MUTATION === 'inv6-rebuild-skew') {
    let corrupted = false
    HANDLERS['message.created@1'] = (event, body) => {
      const row = applyMessageCreatedV1(event, body)
      if (row && !corrupted) {
        corrupted = true
        return { ...row, text: row.text + 'X' }
      }
      return row
    }
  }
  try {
    await rebuildProjections(db)
  } finally {
    HANDLERS['message.created@1'] = applyMessageCreatedV1
  }
}

// ===========================================================================
// Property 1 — rebuild ≡ incremental for EVERY randomized history (MemoryDb).
// ===========================================================================

describe('§12 invariant 6 — client rebuild ≡ incremental [property]', () => {
  it('drop+replay is byte-identical to incremental for any generated history (MemoryDb)', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (draw) => {
        const db: MsgDb = new MemoryDb()
        const h = materialize(draw)
        await buildIncremental(db, h)
        const incremental = await dumpMessages(db)

        await db.clearDerivedTables()
        await rebuildMaybeSkewed(db)
        const rebuilt = await dumpMessages(db)

        expect(rebuilt).toBe(incremental) // the gate (goes red under the teeth flag)
        await db.close()
      }),
      { numRuns: 100 },
    )
  })

  // ------------------------------------------------------------------------
  // Property 2 — the SHIPPING db: replay drawn histories through the real
  // DexieDb (fake-indexeddb). This is the gating assertion for the browser path.
  // ------------------------------------------------------------------------
  it('drop+replay is byte-identical against the real DexieDb (shipping path)', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (draw) => {
        const db: MsgDb = await openDb(fakeIdbOptions())
        expect(db.persistence).toBe('persistent') // real Dexie, not the MemoryDb fallback
        const h = materialize(draw)
        await buildIncremental(db, h)
        const incremental = await dumpMessages(db)

        await db.clearDerivedTables()
        await rebuildMaybeSkewed(db)
        const rebuilt = await dumpMessages(db)

        expect(rebuilt).toBe(incremental) // the gate (goes red under the teeth flag)
        await db.close()
      }),
      { numRuns: 15 },
    )
  })

  // ------------------------------------------------------------------------
  // Property 3 — idempotence: re-applying the whole history leaves the dump
  // unchanged (the immutable-key upsert property the rebuild relies on).
  // ------------------------------------------------------------------------
  it('re-applying the full history is a no-op on the dump (idempotence)', async () => {
    await fc.assert(
      fc.asyncProperty(historyArb, async (draw) => {
        const db: MsgDb = new MemoryDb()
        const h = materialize(draw)
        await buildIncremental(db, h)
        const before = await dumpMessages(db)
        await buildIncremental(db, h) // re-apply everything
        expect(await dumpMessages(db)).toBe(before)
        await db.close()
      }),
      { numRuns: 40 },
    )
  })
})
