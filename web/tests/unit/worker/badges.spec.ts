import { describe, expect, it } from 'vitest'

import { computeAllBadges, computeStreamBadge } from '../../../src/worker/badges'
import { MemoryDb, openDb } from '../../../src/worker/db'
import { applyEventsToProjection } from '../../../src/worker/projection'
import { ReadStateManager } from '../../../src/worker/readstate'
import type { MsgDb } from '../../../src/worker/types'

import { FakeHttpClient, FakeSyncServer, fakeIdbOptions } from './helpers'
import { messageCreatedEvent } from './projfixtures'

async function seedStream(
  db: MsgDb,
  streamId: string,
  headSeq: number,
  lastReadSeq: number | undefined,
): Promise<void> {
  await db.putStreams([{ stream_id: streamId, kind: 'channel', head_seq: headSeq, member: true }])
  if (lastReadSeq !== undefined) {
    await db.putReadState([{ stream_id: streamId, last_read_seq: lastReadSeq }])
  }
}

describe.each([
  { name: 'MemoryDb', make: (): Promise<MsgDb> => Promise.resolve(new MemoryDb()) },
  { name: 'DexieDb', make: (): Promise<MsgDb> => openDb(fakeIdbOptions()) },
])('badges [$name]', ({ make }) => {
  it('unread = head_seq − last_read_seq', async () => {
    const db = await make()
    await seedStream(db, 's1', 10, 4)
    const badge = await computeStreamBadge(db, 's1', 'u_me')
    expect(badge.unread).toBe(6)
    await db.close()
  })

  it('unread floors at 0 (last_read ahead of head)', async () => {
    const db = await make()
    await seedStream(db, 's1', 3, 9)
    const badge = await computeStreamBadge(db, 's1', 'u_me')
    expect(badge.unread).toBe(0)
    await db.close()
  })

  it('unread defaults last_read_seq to 0 when read_state is absent', async () => {
    const db = await make()
    await seedStream(db, 's1', 5, undefined)
    const badge = await computeStreamBadge(db, 's1', 'u_me')
    expect(badge.unread).toBe(5)
    await db.close()
  })

  it('mention is true only when a message with seq > last_read mentions me', async () => {
    const db = await make()
    await seedStream(db, 's1', 3, 1)
    await applyEventsToProjection(db, 's1', [
      // seq 1 mentions me but is already read (seq == last_read, not > )
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm_1', mentions: ['u_me'] }),
      // seq 2 mentions someone else
      messageCreatedEvent({ streamId: 's1', seq: 2, messageId: 'm_2', mentions: ['u_other'] }),
      // seq 3 (> last_read) mentions me → red
      messageCreatedEvent({ streamId: 's1', seq: 3, messageId: 'm_3', mentions: ['u_me'] }),
    ])
    const badge = await computeStreamBadge(db, 's1', 'u_me')
    expect(badge.mention).toBe(true)
    await db.close()
  })

  it('mention is false when the only mention of me is at/below last_read', async () => {
    const db = await make()
    await seedStream(db, 's1', 3, 2)
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm_1', mentions: ['u_me'] }),
      messageCreatedEvent({ streamId: 's1', seq: 2, messageId: 'm_2', mentions: ['u_me'] }),
      messageCreatedEvent({ streamId: 's1', seq: 3, messageId: 'm_3', mentions: ['u_other'] }),
    ])
    const badge = await computeStreamBadge(db, 's1', 'u_me')
    expect(badge.mention).toBe(false)
    await db.close()
  })

  it('is user-relative: the SAME projection yields different mention badges per user', async () => {
    const db = await make()
    await seedStream(db, 's1', 2, 0)
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({ streamId: 's1', seq: 1, messageId: 'm_1', mentions: ['u_alice'] }),
      messageCreatedEvent({ streamId: 's1', seq: 2, messageId: 'm_2', mentions: ['u_bob'] }),
    ])
    expect((await computeStreamBadge(db, 's1', 'u_alice')).mention).toBe(true)
    expect((await computeStreamBadge(db, 's1', 'u_carol')).mention).toBe(false)
    await db.close()
  })

  it('computeAllBadges covers every stream', async () => {
    const db = await make()
    await seedStream(db, 's1', 5, 2)
    await seedStream(db, 's2', 1, 1)
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({ streamId: 's1', seq: 3, messageId: 'm_3', mentions: ['u_me'] }),
    ])
    const badges = await computeAllBadges(db, 'u_me')
    const byId = Object.fromEntries(badges.map((b) => [b.stream_id, b]))
    expect(byId.s1).toEqual({ stream_id: 's1', unread: 3, mention: true })
    expect(byId.s2).toEqual({ stream_id: 's2', unread: 0, mention: false })
    await db.close()
  })

  it('unread + mention clear after a read-state mark, and a {kind:stream} push fires', async () => {
    const db = await make()
    await seedStream(db, 's1', 5, 0)
    await applyEventsToProjection(db, 's1', [
      messageCreatedEvent({ streamId: 's1', seq: 5, messageId: 'm_5', mentions: ['u_me'] }),
    ])
    expect(await computeStreamBadge(db, 's1', 'u_me')).toEqual({
      stream_id: 's1',
      unread: 5,
      mention: true,
    })

    const pushes: string[] = []
    const mgr = new ReadStateManager({
      db,
      http: new FakeHttpClient(new FakeSyncServer()),
      publishStream: (s) => pushes.push(s),
    })
    await mgr.mark('s1', 5)

    // The badge now reads clear off the updated read_state…
    expect(await computeStreamBadge(db, 's1', 'u_me')).toEqual({
      stream_id: 's1',
      unread: 0,
      mention: false,
    })
    // …and the sidebar was told to re-derive it.
    expect(pushes).toContain('s1')
    await db.close()
  })

  it('unread clears after an inbound read-state echo (another device marked it read)', async () => {
    const db = await make()
    await seedStream(db, 's1', 8, 0)
    const pushes: string[] = []
    const mgr = new ReadStateManager({
      db,
      http: new FakeHttpClient(new FakeSyncServer()),
      publishStream: (s) => pushes.push(s),
    })
    await mgr.applyEcho({ stream_id: 's1', last_read_seq: 8 })
    expect((await computeStreamBadge(db, 's1', 'u_me')).unread).toBe(0)
    expect(pushes).toContain('s1')
    await db.close()
  })
})
