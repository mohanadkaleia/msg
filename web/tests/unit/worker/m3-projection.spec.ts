// tests/unit/worker/m3-projection.spec.ts — ENG-100 M3 client projection unit
// tests: the reactions set, edit LWW (text+format), delete tombstone+redact
// (terminal), and delete-aware thread recompute. Direct on MemoryDb + the real
// DexieDb (fake-indexeddb) so the shipping IndexedDB path is exercised too. These
// assert the SEMANTICS mirror the server `apply.py`; the property gates (inv5/6)
// assert rebuild ≡ incremental and pending-settling.

import { describe, expect, it } from 'vitest'

import { MemoryDb, openDb } from '../../../src/worker/db'
import { applyEventsToProjection } from '../../../src/worker/projection'
import type { MsgDb } from '../../../src/worker/types'

import { fakeIdbOptions } from './helpers'
import {
  messageCreatedEvent,
  messageDeletedEvent,
  messageEditedEvent,
  reactionAddedEvent,
  reactionRemovedEvent,
} from './projfixtures'

const S = 's_m3'

/** Apply a per-stream list of events (single batch) through the real seam. */
async function apply(
  db: MsgDb,
  events: Parameters<typeof applyEventsToProjection>[2],
): Promise<void> {
  await db.putEvents([...events])
  await applyEventsToProjection(db, S, events)
}

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('M3 reactions projection [$name]', ({ make }) => {
  it('is a set: add is idempotent, remove deletes, count derives from membership', async () => {
    const db = await make()
    await apply(db, [
      messageCreatedEvent({ streamId: S, seq: 1, messageId: 'm_1', text: 'hi' }),
      reactionAddedEvent({
        streamId: S,
        seq: 2,
        messageId: 'm_1',
        emoji: '👍',
        authorUserId: 'u_a',
      }),
      reactionAddedEvent({
        streamId: S,
        seq: 3,
        messageId: 'm_1',
        emoji: '👍',
        authorUserId: 'u_b',
      }),
      // Duplicate (same user+emoji, different event) is a no-op — set semantics.
      reactionAddedEvent({
        streamId: S,
        seq: 4,
        messageId: 'm_1',
        emoji: '👍',
        authorUserId: 'u_a',
      }),
      reactionAddedEvent({
        streamId: S,
        seq: 5,
        messageId: 'm_1',
        emoji: '🎉',
        authorUserId: 'u_a',
      }),
    ])
    const reactions = await db.getReactionsForMessage('m_1')
    // 👍 by {u_a, u_b} + 🎉 by {u_a} = 3 memberships (the dup collapsed).
    expect(reactions).toHaveLength(3)
    const thumbs = reactions
      .filter((r) => r.emoji === '👍')
      .map((r) => r.author_user_id)
      .sort()
    expect(thumbs).toEqual(['u_a', 'u_b'])

    // Remove u_a's 👍; removing an absent one is a no-op.
    await apply(db, [
      reactionRemovedEvent({
        streamId: S,
        seq: 6,
        messageId: 'm_1',
        emoji: '👍',
        authorUserId: 'u_a',
      }),
      reactionRemovedEvent({
        streamId: S,
        seq: 7,
        messageId: 'm_1',
        emoji: '💥',
        authorUserId: 'u_z',
      }),
    ])
    const after = await db.getReactionsForMessage('m_1')
    expect(after.filter((r) => r.emoji === '👍').map((r) => r.author_user_id)).toEqual(['u_b'])
    expect(after).toHaveLength(2)
    await db.close()
  })

  it('treats emoji as opaque exact-byte bytes (control chars distinct)', async () => {
    const db = await make()
    await apply(db, [
      messageCreatedEvent({ streamId: S, seq: 1, messageId: 'm_1', text: 'hi' }),
      reactionAddedEvent({
        streamId: S,
        seq: 2,
        messageId: 'm_1',
        emoji: 'x',
        authorUserId: 'u_a',
      }),
      reactionAddedEvent({
        streamId: S,
        seq: 3,
        messageId: 'm_1',
        emoji: 'x',
        authorUserId: 'u_a',
      }),
    ])
    // 'x' and 'x' are DISTINCT keys — two memberships, not a collision.
    expect(await db.getReactionsForMessage('m_1')).toHaveLength(2)
    await db.close()
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('M3 edits (LWW + format) [$name]', ({ make }) => {
  it('applies the highest-server_sequence edit; text AND format move; older is skipped', async () => {
    const db = await make()
    await apply(db, [
      messageCreatedEvent({
        streamId: S,
        seq: 1,
        messageId: 'm_1',
        text: 'v0',
        format: 'markdown',
      }),
      messageEditedEvent({ streamId: S, seq: 5, messageId: 'm_1', text: 'v5', format: 'plain' }),
    ])
    let row = await db.getMessage('m_1')
    expect(row?.text).toBe('v5')
    expect(row?.format).toBe('plain') // the client stores format (unlike the server)
    expect(row?.edited_seq).toBe(5)

    // An OLDER edit (seq 3 < 5) is skipped — LWW converges to the highest seq.
    await apply(db, [messageEditedEvent({ streamId: S, seq: 3, messageId: 'm_1', text: 'v3' })])
    row = await db.getMessage('m_1')
    expect(row?.text).toBe('v5')
    expect(row?.edited_seq).toBe(5)

    // A NEWER edit wins.
    await apply(db, [messageEditedEvent({ streamId: S, seq: 9, messageId: 'm_1', text: 'v9' })])
    expect((await db.getMessage('m_1'))?.text).toBe('v9')
    expect((await db.getMessage('m_1'))?.edited_seq).toBe(9)
    await db.close()
  })

  it('an edit of a missing message is a no-op (never materializes a row)', async () => {
    const db = await make()
    await apply(db, [messageEditedEvent({ streamId: S, seq: 1, messageId: 'm_ghost', text: 'x' })])
    expect(await db.getMessage('m_ghost')).toBeUndefined()
    await db.close()
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('M3 deletes (tombstone + redact, terminal) [$name]', ({ make }) => {
  it('sets deleted + REDACTS text to empty; content is never stored', async () => {
    const db = await make()
    await apply(db, [
      messageCreatedEvent({ streamId: S, seq: 1, messageId: 'm_1', text: 'secret content' }),
      messageDeletedEvent({ streamId: S, seq: 2, messageId: 'm_1' }),
    ])
    const row = await db.getMessage('m_1')
    expect(row?.deleted).toBe(true)
    expect(row?.text).toBe('') // redacted — the projection cannot serve the content
    await db.close()
  })

  it('delete is terminal: a later edit (any order) never un-deletes or un-redacts', async () => {
    const db = await make()
    // edit arrives AFTER delete (higher seq) — must still be guarded off.
    await apply(db, [
      messageCreatedEvent({ streamId: S, seq: 1, messageId: 'm_1', text: 'orig' }),
      messageDeletedEvent({ streamId: S, seq: 2, messageId: 'm_1' }),
      messageEditedEvent({ streamId: S, seq: 3, messageId: 'm_1', text: 'resurrected' }),
    ])
    const row = await db.getMessage('m_1')
    expect(row?.deleted).toBe(true)
    expect(row?.text).toBe('')
    await db.close()
  })
})

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('M3 threads (delete-aware recompute) [$name]', ({ make }) => {
  it('reply_count / last_reply_seq / participants track the non-deleted reply set', async () => {
    const db = await make()
    await apply(db, [
      messageCreatedEvent({ streamId: S, seq: 1, messageId: 'm_root', text: 'root' }),
      messageCreatedEvent({
        streamId: S,
        seq: 2,
        messageId: 'm_r1',
        text: 'reply 1',
        threadRootId: 'm_root',
        authorUserId: 'u_a',
      }),
      messageCreatedEvent({
        streamId: S,
        seq: 3,
        messageId: 'm_r2',
        text: 'reply 2',
        threadRootId: 'm_root',
        authorUserId: 'u_b',
      }),
    ])
    let root = await db.getMessage('m_root')
    expect(root?.reply_count).toBe(2)
    expect(root?.last_reply_seq).toBe(3)
    let parts = (await db.getAllThreadParticipants())
      .filter((p) => p.root_message_id === 'm_root')
      .map((p) => p.user_id)
      .sort()
    expect(parts).toEqual(['u_a', 'u_b'])

    // Delete a reply — recompute drops it from the count + participants.
    await apply(db, [messageDeletedEvent({ streamId: S, seq: 4, messageId: 'm_r2' })])
    root = await db.getMessage('m_root')
    expect(root?.reply_count).toBe(1)
    expect(root?.last_reply_seq).toBe(2) // m_r1 (seq 2) is now the last non-deleted
    parts = (await db.getAllThreadParticipants())
      .filter((p) => p.root_message_id === 'm_root')
      .map((p) => p.user_id)
    expect(parts).toEqual(['u_a'])

    // Delete the last reply — count 0, last_reply_seq cleared, no participants.
    await apply(db, [messageDeletedEvent({ streamId: S, seq: 5, messageId: 'm_r1' })])
    root = await db.getMessage('m_root')
    expect(root?.reply_count).toBe(0)
    expect(root?.last_reply_seq).toBeUndefined()
    expect(
      (await db.getAllThreadParticipants()).filter((p) => p.root_message_id === 'm_root'),
    ).toEqual([])
    await db.close()
  })

  it('deleting a ROOT leaves its reply counters intact (only reply deletes recompute)', async () => {
    const db = await make()
    await apply(db, [
      messageCreatedEvent({ streamId: S, seq: 1, messageId: 'm_root', text: 'root' }),
      messageCreatedEvent({
        streamId: S,
        seq: 2,
        messageId: 'm_r1',
        text: 'r',
        threadRootId: 'm_root',
        authorUserId: 'u_a',
      }),
      messageDeletedEvent({ streamId: S, seq: 3, messageId: 'm_root' }),
    ])
    const root = await db.getMessage('m_root')
    expect(root?.deleted).toBe(true)
    expect(root?.text).toBe('')
    expect(root?.reply_count).toBe(1) // survives the root's own tombstone
    await db.close()
  })
})
