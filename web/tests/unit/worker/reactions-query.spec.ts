import { describe, expect, it } from 'vitest'

import { MemoryDb } from '../../../src/worker/db'
import { listReactions } from '../../../src/worker/projection'
import type { ReactionRow, StreamRow } from '../../../src/worker/types'

import { metaUserEvent } from './projfixtures'

const stream = (over: Partial<StreamRow> & { stream_id: string }): StreamRow => ({
  kind: 'channel',
  head_seq: 0,
  member: true,
  ...over,
})

/** A present (observable) reaction row for `(message, author, emoji)`. */
const react = (
  message_id: string,
  author_user_id: string,
  emoji: string,
  present = true,
): ReactionRow => ({ message_id, author_user_id, emoji, last_event_seq: 1, present })

describe('worker/projection — listReactions (ENG-102 reaction chips)', () => {
  it('aggregates present reactions by emoji with resolved names + mine flag', async () => {
    const db = new MemoryDb()
    await db.putStreams([stream({ stream_id: 's_meta', kind: 'workspace-meta' })])
    await db.putEvents([
      metaUserEvent('s_meta', 1, 'user.joined', { user_id: 'u_ann', display_name: 'Ann' }),
      metaUserEvent('s_meta', 2, 'user.joined', { user_id: 'u_bo', display_name: 'Bo' }),
    ])
    await db.putReactions([
      react('m1', 'u_ann', '👍'),
      react('m1', 'u_bo', '👍'),
      react('m1', 'u_me', '🎉'),
      react('m1', 'u_zzz', '👍', false), // tombstone — must be excluded
    ])

    const res = await listReactions(db, ['m1'], 'u_me')
    expect(res.messages).toHaveLength(1)
    const chips = res.messages[0]!.reactions
    // Sorted by emoji bytes (🎉 U+1F389 < 👍 U+1F44D); tombstone excluded; names
    // folded from the directory (user_id fallback when absent).
    expect(chips).toEqual([
      {
        emoji: '🎉',
        count: 1,
        user_ids: ['u_me'],
        display_names: ['u_me'], // no directory entry → user_id fallback
        mine: true,
      },
      {
        emoji: '👍',
        count: 2,
        user_ids: ['u_ann', 'u_bo'],
        display_names: ['Ann', 'Bo'],
        mine: false,
      },
    ])
  })

  it('returns an empty chip list for a message with no reactions', async () => {
    const db = new MemoryDb()
    const res = await listReactions(db, ['m_none'], 'u_me')
    expect(res.messages).toEqual([{ message_id: 'm_none', reactions: [] }])
  })

  it('never flags mine for an anonymous (empty) viewer id', async () => {
    const db = new MemoryDb()
    await db.putReactions([react('m1', 'u_ann', '👍')])
    const res = await listReactions(db, ['m1'], '')
    expect(res.messages[0]!.reactions[0]!.mine).toBe(false)
  })
})
