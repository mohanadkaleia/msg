// tests/unit/worker/workspace-info.spec.ts — the ENG-152 workspace identity
// fold (`workspace.info`): name + description from the cached workspace-meta
// events. `workspace.created` names the workspace; each `workspace.updated`
// applies EXACTLY the fields present in its payload (LWW by ascending
// server_sequence) — presence-significant, so a cleared description ('')
// never aliases an untouched one.

import { describe, expect, it } from 'vitest'

import { MemoryDb } from '../../../src/worker/db'
import { getWorkspaceInfo } from '../../../src/worker/projection'
import type { StreamRow } from '../../../src/worker/types'

import { metaWorkspaceEvent } from './projfixtures'

const stream = (over: Partial<StreamRow> & { stream_id: string }): StreamRow => ({
  kind: 'channel',
  head_seq: 0,
  member: true,
  ...over,
})

describe('worker/projection — getWorkspaceInfo (ENG-152 identity fold)', () => {
  it('reads the name from the genesis workspace.created', async () => {
    const db = new MemoryDb()
    await db.putStreams([stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' })])
    await db.putEvents([metaWorkspaceEvent('s_meta', 1, 'workspace.created', { name: 'Acme' })])

    expect(await getWorkspaceInfo(db)).toEqual({ name: 'Acme', description: null })
  })

  it('applies workspace.updated fields LWW, by ascending sequence', async () => {
    const db = new MemoryDb()
    await db.putStreams([stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' })])
    await db.putEvents([
      metaWorkspaceEvent('s_meta', 1, 'workspace.created', { name: 'Acme' }),
      metaWorkspaceEvent('s_meta', 2, 'workspace.updated', { name: 'Acme Inc' }),
      metaWorkspaceEvent('s_meta', 3, 'workspace.updated', {
        name: 'Acme Corp',
        description: 'Widgets',
      }),
    ])

    expect(await getWorkspaceInfo(db)).toEqual({ name: 'Acme Corp', description: 'Widgets' })
  })

  it('a rename-only update leaves the description; an empty-string clears it', async () => {
    const db = new MemoryDb()
    await db.putStreams([stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' })])
    await db.putEvents([
      metaWorkspaceEvent('s_meta', 1, 'workspace.created', { name: 'Acme' }),
      metaWorkspaceEvent('s_meta', 2, 'workspace.updated', { description: 'Keep me' }),
      // Rename only — description ABSENT from the payload, so it survives.
      metaWorkspaceEvent('s_meta', 3, 'workspace.updated', { name: 'Renamed' }),
    ])
    expect(await getWorkspaceInfo(db)).toEqual({ name: 'Renamed', description: 'Keep me' })

    // The explicit clear ('') applies — distinguishable from "untouched".
    await db.putEvents([metaWorkspaceEvent('s_meta', 4, 'workspace.updated', { description: '' })])
    expect(await getWorkspaceInfo(db)).toEqual({ name: 'Renamed', description: '' })
  })

  it('is null/null before the genesis event has synced (the shell falls back)', async () => {
    const db = new MemoryDb()
    await db.putStreams([
      stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' }),
      stream({ stream_id: 's_general', name: 'general' }),
    ])

    expect(await getWorkspaceInfo(db)).toEqual({ name: null, description: null })
  })

  it('ignores non-workspace meta events and non-meta streams', async () => {
    const db = new MemoryDb()
    await db.putStreams([
      stream({ stream_id: 's_meta', kind: 'workspace-meta', name: 'meta' }),
      stream({ stream_id: 's_general', name: 'general' }),
    ])
    await db.putEvents([
      metaWorkspaceEvent('s_meta', 1, 'workspace.created', { name: 'Acme' }),
      // A channel-homed event of the same SHAPE must not leak into the fold.
      metaWorkspaceEvent('s_general', 1, 'workspace.updated', { name: 'Not me' }),
    ])

    expect(await getWorkspaceInfo(db)).toEqual({ name: 'Acme', description: null })
  })
})
