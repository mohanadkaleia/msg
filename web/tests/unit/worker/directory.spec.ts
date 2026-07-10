import { describe, expect, it } from 'vitest'

import { MemoryDb } from '../../../src/worker/db'
import { displayNameOf, listDirectory } from '../../../src/worker/projection'
import type { DirectoryUser, StreamRow } from '../../../src/worker/types'

import { metaUserEvent } from './projfixtures'

const stream = (over: Partial<StreamRow> & { stream_id: string }): StreamRow => ({
  kind: 'channel',
  head_seq: 0,
  member: true,
  ...over,
})

describe('worker/projection — listDirectory (ENG-101 mention source)', () => {
  it('folds workspace-meta user events into a member list and lists channels', async () => {
    const db = new MemoryDb()
    await db.putStreams([
      stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' }),
      stream({ stream_id: 's_general', name: 'general' }),
      stream({ stream_id: 's_random', name: 'random' }),
      stream({ stream_id: 's_dm', kind: 'dm', name: 'dana' }),
    ])
    await db.putEvents([
      metaUserEvent('s_meta', 1, 'user.joined', { user_id: 'u_dana', display_name: 'Dana' }),
      metaUserEvent('s_meta', 2, 'user.joined', { user_id: 'u_sam', display_name: 'Sam' }),
      metaUserEvent('s_meta', 3, 'user.joined', { user_id: 'u_gone', display_name: 'Gone' }),
      metaUserEvent('s_meta', 4, 'user.left', { user_id: 'u_gone' }),
      metaUserEvent('s_meta', 5, 'user.profile_updated', {
        user_id: 'u_sam',
        display_name: 'Samuel',
      }),
    ])

    const dir = await listDirectory(db)

    // Left users are dropped; renames apply; sorted by display name.
    expect(dir.users).toEqual([
      { user_id: 'u_dana', display_name: 'Dana' },
      { user_id: 'u_sam', display_name: 'Samuel' },
    ])
    // Channels exclude DMs + the meta stream, sorted by name.
    expect(dir.channels).toEqual([
      { stream_id: 's_general', name: 'general' },
      { stream_id: 's_random', name: 'random' },
    ])
  })

  it('excludes non-member channels and returns empty lists with no meta stream', async () => {
    const db = new MemoryDb()
    await db.putStreams([
      stream({ stream_id: 's_pub', name: 'public', member: true }),
      stream({ stream_id: 's_hidden', name: 'hidden', member: false }),
    ])

    const dir = await listDirectory(db)
    expect(dir.users).toEqual([])
    expect(dir.channels).toEqual([{ stream_id: 's_pub', name: 'public' }])
  })

  // SECURITY (PR #91 review) — defense-in-depth fold guard: a user may only rename
  // THEMSELVES, so a `user.profile_updated` whose author != subject is ignored.
  it('ignores a forged profile_updated rename (author != subject), keeps a self-rename', async () => {
    const db = new MemoryDb()
    await db.putStreams([stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' })])
    await db.putEvents([
      metaUserEvent('s_meta', 1, 'user.joined', { user_id: 'u_dana', display_name: 'Dana' }),
      metaUserEvent('s_meta', 2, 'user.joined', { user_id: 'u_sam', display_name: 'Sam' }),
      // FORGED: u_sam tries to rename u_dana to "PWNED" — author (u_sam) != subject
      // (u_dana). Must be ignored: Dana keeps her name.
      metaUserEvent(
        's_meta',
        3,
        'user.profile_updated',
        { user_id: 'u_dana', display_name: 'PWNED' },
        'u_sam',
      ),
      // LEGIT: u_sam renames themselves — author == subject, so it applies.
      metaUserEvent('s_meta', 4, 'user.profile_updated', {
        user_id: 'u_sam',
        display_name: 'Samuel',
      }),
    ])

    const dir = await listDirectory(db)

    expect(dir.users).toEqual([
      { user_id: 'u_dana', display_name: 'Dana' },
      { user_id: 'u_sam', display_name: 'Samuel' },
    ])
  })

  // --- ENG-164: the richer per-user record (title/description/status) --------

  it('folds title/description/status into the record (LWW by server_sequence)', async () => {
    const db = new MemoryDb()
    await db.putStreams([stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' })])
    await db.putEvents([
      metaUserEvent('s_meta', 1, 'user.joined', { user_id: 'u_sam', display_name: 'Sam' }),
      // First update: sets everything (the server emits the RESULTING state).
      metaUserEvent('s_meta', 2, 'user.profile_updated', {
        user_id: 'u_sam',
        display_name: 'Sam',
        title: 'Engineer',
        description: 'Builds things',
        status_emoji: '🌴',
        status_text: 'Vacation',
        status_expires_at: '2026-07-09T12:00:00.000Z',
      }),
      // Second update WINS field-by-field: new title, status cleared via nulls,
      // description ABSENT → left untouched (a pre-ENG-164-style partial payload).
      metaUserEvent('s_meta', 3, 'user.profile_updated', {
        user_id: 'u_sam',
        display_name: 'Samuel',
        title: 'Staff Engineer',
        status_emoji: null,
        status_text: null,
        status_expires_at: null,
      }),
    ])

    const dir = await listDirectory(db)
    expect(dir.users).toEqual([
      {
        user_id: 'u_sam',
        display_name: 'Samuel',
        title: 'Staff Engineer',
        description: 'Builds things', // absent from event 3 → untouched
        // status fields cleared by the explicit nulls — keys removed entirely
      },
    ])
  })

  it('keeps a raw (possibly expired) status_expires_at — the fold never reads the clock', async () => {
    // Determinism (rebuild ≡ incremental): an EXPIRED status stays in the record;
    // suppression happens at render time (lib/status.ts activeStatus).
    const db = new MemoryDb()
    await db.putStreams([stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' })])
    await db.putEvents([
      metaUserEvent('s_meta', 1, 'user.joined', { user_id: 'u_dana', display_name: 'Dana' }),
      metaUserEvent('s_meta', 2, 'user.profile_updated', {
        user_id: 'u_dana',
        display_name: 'Dana',
        status_emoji: '🍜',
        status_text: 'Lunch',
        status_expires_at: '2000-01-01T00:00:00.000Z', // long past
      }),
    ])

    const dir = await listDirectory(db)
    expect(dir.users[0]).toMatchObject({
      status_emoji: '🍜',
      status_text: 'Lunch',
      status_expires_at: '2000-01-01T00:00:00.000Z',
    })
  })

  it('ignores a forged cross-user profile field update (author != subject)', async () => {
    const db = new MemoryDb()
    await db.putStreams([stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' })])
    await db.putEvents([
      metaUserEvent('s_meta', 1, 'user.joined', { user_id: 'u_dana', display_name: 'Dana' }),
      metaUserEvent('s_meta', 2, 'user.joined', { user_id: 'u_sam', display_name: 'Sam' }),
      // FORGED: u_sam tries to give u_dana a title + status.
      metaUserEvent(
        's_meta',
        3,
        'user.profile_updated',
        { user_id: 'u_dana', title: 'Fake CEO', status_text: 'hacked' },
        'u_sam',
      ),
    ])

    const dir = await listDirectory(db)
    expect(dir.users.find((u) => u.user_id === 'u_dana')).toEqual({
      user_id: 'u_dana',
      display_name: 'Dana',
    })
  })

  it('displayNameOf resolves from the record map with a raw-id fallback', () => {
    const directory = new Map<string, DirectoryUser>([
      ['u_dana', { user_id: 'u_dana', display_name: 'Dana', title: 'Agent' }],
    ])
    expect(displayNameOf(directory, 'u_dana')).toBe('Dana')
    expect(displayNameOf(directory, 'u_unknown')).toBe('u_unknown')
  })
})
