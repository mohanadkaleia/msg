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
import {
  applyEventsToProjection,
  applyMessageCreatedV1,
  dumpMessages,
  HANDLERS,
} from '../../../src/worker/projection'
import type { EventRow, MsgDb } from '../../../src/worker/types'

import { fakeIdbOptions } from './helpers'
import { messageCreatedEvent, metaEvent, unknownTypeEvent } from './projfixtures'

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
])('checkProjectionVersion drives a real replay [$name]', ({ make }) => {
  it('rebuilds messages from cached events on a stale projection_version', async () => {
    const db = await make()
    const { byStream, v1Count } = syntheticPlan()
    await buildIncremental(db, byStream)
    await db.putOutbox([
      { event_id: 'o1', created_at: 1, body: { text: 'pending' }, state: 'queued' },
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
