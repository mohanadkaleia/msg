// PERMANENT GATE (client Dexie side of §12 invariant 6) — ENG-83 extends this
// into the property suite; never delete. Proves, for the client `messages`
// projection: drop+replay (rebuild) == incremental, byte-equal `dumpMessages`;
// idempotence; the D9 skip; and that the byte-equality has TEETH (a one-row
// corruption on the rebuild pass only makes the dumps differ).

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  checkProjectionVersion,
  MemoryDb,
  openDb,
  rebuildProjections,
} from '../../../src/worker/db'
import { buildPendingMessageRow } from '../../../src/worker/outbox'
import {
  applyEventsToProjection,
  applyMessageCreatedV1,
  dumpMessages,
  HANDLERS,
} from '../../../src/worker/projection'
import type { EventRow, MsgDb, OutboxRow } from '../../../src/worker/types'

import { fakeIdbOptions } from './helpers'
import { messageCreatedEvent, metaEvent, unknownTypeEvent } from './projfixtures'

/** A well-formed `message.created` outbox row (the shape the send path mints). */
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

afterEach(() => {
  vi.restoreAllMocks()
  // Restore the real handler in case a teeth test left a patch in place.
  HANDLERS['message.created@1'] = applyMessageCreatedV1
})

/**
 * A fixed, deterministic multi-stream plan: message.created v1 (incl. unicode +
 * optional thread_root_id/mentions) interleaved with an injected widget.exploded
 * v7 and a message.created v2 (both must skip, D9). Grouped by stream so the
 * incremental path can apply per-stream batches (the ENG-79 seam shape).
 */
function syntheticPlan(): { byStream: Map<string, EventRow[]>; v1Count: number; total: number } {
  const streamA: EventRow[] = [
    messageCreatedEvent({ streamId: 's_a', seq: 1, messageId: 'm_a1', text: 'hello' }),
    unknownTypeEvent('s_a', 2), // D9 skip
    messageCreatedEvent({
      streamId: 's_a',
      seq: 3,
      messageId: 'm_a3',
      text: 'unicode 日本語 🎉 ☕',
      format: 'plain',
      mentions: ['u_x', 'u_y'],
    }),
    messageCreatedEvent({ streamId: 's_a', seq: 4, messageId: 'm_a4', typeVersion: 2 }), // D9 skip
  ]
  const streamB: EventRow[] = [
    messageCreatedEvent({
      streamId: 's_b',
      seq: 1,
      messageId: 'm_b1',
      text: 'reply',
      threadRootId: 'm_a1',
    }),
    metaEvent('s_b', 2), // D9 skip
    messageCreatedEvent({ streamId: 's_b', seq: 3, messageId: 'm_b2', text: '' }),
  ]
  const byStream = new Map<string, EventRow[]>([
    ['s_a', streamA],
    ['s_b', streamB],
  ])
  return { byStream, v1Count: 4, total: streamA.length + streamB.length }
}

/** Write all events into the source `events` cache + apply incrementally per stream. */
async function buildIncremental(db: MsgDb, byStream: Map<string, EventRow[]>): Promise<void> {
  for (const [streamId, events] of byStream) {
    await db.putEvents(events)
    await applyEventsToProjection(db, streamId, events)
  }
}

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('rebuild ≡ incremental [$name]', ({ make }) => {
  it('drop+replay produces a byte-identical dump (the gate)', async () => {
    const db = await make()
    const { byStream } = syntheticPlan()
    await buildIncremental(db, byStream)
    const dumpIncremental = await dumpMessages(db)

    await db.clearDerivedTables()
    await rebuildProjections(db)
    const dumpRebuilt = await dumpMessages(db)

    expect(dumpRebuilt).toBe(dumpIncremental)
    await db.close()
  })

  it('projects exactly the message.created v1 events (D9), events untouched', async () => {
    const db = await make()
    const { byStream, v1Count, total } = syntheticPlan()
    await buildIncremental(db, byStream)

    expect(await db.count('messages')).toBe(v1Count)
    expect(await db.count('events')).toBe(total) // apply never deletes source events
    expect(await db.getMessage('m_a4')).toBeUndefined() // v2 skipped
    await db.close()
  })

  it('is idempotent: re-applying all events leaves the dump unchanged', async () => {
    const db = await make()
    const { byStream } = syntheticPlan()
    await buildIncremental(db, byStream)
    const before = await dumpMessages(db)

    for (const [streamId, events] of byStream) {
      await applyEventsToProjection(db, streamId, events)
    }
    const after = await dumpMessages(db)

    expect(after).toBe(before)
    await db.close()
  })

  it('TEETH: a one-row corruption on the rebuild pass only makes the dumps differ', async () => {
    const db = await make()
    const { byStream } = syntheticPlan()
    await buildIncremental(db, byStream)
    const dumpIncremental = await dumpMessages(db)

    // Positive control: a clean rebuild still matches (proves the != below has meaning).
    await db.clearDerivedTables()
    await rebuildProjections(db)
    expect(await dumpMessages(db)).toBe(dumpIncremental)

    // Corrupt exactly one row's text — on the REBUILD side only.
    HANDLERS['message.created@1'] = (event, body) => {
      const row = applyMessageCreatedV1(event, body)
      if (row && row.message_id === 'm_a1') return { ...row, text: row.text + 'X' }
      return row
    }
    await db.clearDerivedTables()
    await rebuildProjections(db)
    const dumpCorrupt = await dumpMessages(db)

    expect(dumpCorrupt).not.toBe(dumpIncremental)
    await db.close()
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('rebuild reproduces settled + pending/failed state (ENG-81 §8) [$name]', ({ make }) => {
  it('re-derives pending + failed rows from outbox → byte-identical dump', async () => {
    const db = await make()

    // Settled rows (from cached events).
    const settled = [
      messageCreatedEvent({ streamId: 's_a', seq: 1, messageId: 'm_a1', text: 'hello' }),
      messageCreatedEvent({ streamId: 's_a', seq: 2, messageId: 'm_a2', text: 'world' }),
    ]
    await db.putEvents(settled)
    await applyEventsToProjection(db, 's_a', settled)

    // A pending send (queued) + a failed send (rejected) — the incremental state.
    const pending = outboxRow({
      eventId: 'e_pend',
      messageId: 'm_pend',
      streamId: 's_a',
      createdAt: 1_750_000_000_000,
      text: 'still sending',
      state: 'queued',
    })
    const failed = outboxRow({
      eventId: 'e_fail',
      messageId: 'm_fail',
      streamId: 's_b',
      createdAt: 1_750_000_000_001,
      text: 'was rejected',
      state: 'rejected',
      errorCode: 'permission_denied',
    })
    await db.putOutbox([pending, failed])
    await db.putMessages([buildPendingMessageRow(pending)!, buildPendingMessageRow(failed)!])

    // TEETH: a settled event_id still lingering in `outbox` (crash between
    // putEvents + deleteOutbox) must re-derive to the SETTLED row (skip guard),
    // never a duplicate pending row.
    const settledEventId = settled[0]!.event_id
    await db.putOutbox([
      outboxRow({
        eventId: settledEventId,
        messageId: 'm_a1',
        streamId: 's_a',
        createdAt: 999,
        text: 'stale',
        state: 'sending',
      }),
    ])

    const dumpIncremental = await dumpMessages(db)

    // Rebuild: replay events (settled) + re-derive outbox (pending/failed, skip settled).
    await db.clearDerivedTables()
    await rebuildProjections(db)
    const dumpRebuilt = await dumpMessages(db)

    expect(dumpRebuilt).toBe(dumpIncremental)
    // The lingering settled event kept its settled row (seq 1), not a stale pending overwrite.
    const a1 = await db.getMessage('m_a1')
    expect(a1?.created_seq).toBe(1)
    expect(a1?.state).toBeUndefined()
    // Pending/failed rows survived the rebuild.
    expect((await db.getMessage('m_pend'))?.state).toBe('pending')
    expect((await db.getMessage('m_fail'))?.state).toBe('failed')
    expect((await db.getMessage('m_fail'))?.error_code).toBe('permission_denied')
    await db.close()
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('checkProjectionVersion drives a real replay [$name]', ({ make }) => {
  it('rebuilds messages from cached events on a stale projection_version', async () => {
    const db = await make()
    const { byStream, v1Count } = syntheticPlan()
    await buildIncremental(db, byStream)
    await db.putOutbox([
      {
        event_id: 'o1',
        created_at: 1,
        body: { text: 'pending' }, // no valid payload.message_id → rebuild derives no row
        event_hash: 'sha256:o1',
        message_id: 'm_o1',
        stream_id: 's_a',
        state: 'queued',
      },
    ])
    await db.metaPut('projection_version', 0) // stale ⇒ mismatch

    const { rebuilt } = await checkProjectionVersion(db)

    expect(rebuilt).toBe(true)
    // messages were dropped AND replayed from events (not merely cleared).
    expect(await db.count('messages')).toBe(v1Count)
    // source tables preserved.
    expect(await db.count('events')).toBe(byStream.get('s_a')!.length + byStream.get('s_b')!.length)
    expect(await db.count('outbox')).toBe(1)
    await db.close()
  })
})
