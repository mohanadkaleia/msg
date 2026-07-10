import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'

describe('workspace store', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    setWorkerClient(fake.client)
  })

  afterEach(() => {
    setWorkerClient(undefined)
  })

  it('splits channels/DMs, hides workspace-meta, and defaults selection', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    fake.addStream({ stream_id: 's_dm', name: 'dana', kind: 'dm' })
    fake.addStream({ stream_id: 's_meta', name: 'meta', kind: 'workspace-meta' })
    const store = useWorkspaceStore()

    await store.load()

    expect(store.channels.map((s) => s.stream_id)).toEqual(['s_general'])
    expect(store.dms.map((s) => s.stream_id)).toEqual(['s_dm'])
    expect(store.selectedStreamId).toBe('s_general') // first channel
  })

  it('re-queries badges when a stream publishes (live sidebar refresh)', async () => {
    fake.addStream({ stream_id: 's1', name: 'general', unread: 0, mention: false })
    const store = useWorkspaceStore()
    await store.load()
    expect(store.channels[0]!.unread).toBe(0)

    fake.setBadge('s1', { unread: 3, mention: true })
    await flushPromises()

    expect(store.channels[0]!.unread).toBe(3)
    expect(store.channels[0]!.mention).toBe(true)
  })

  it('loads the @mention/#channel directory via a ZERO-network projection read', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    fake.setDirectory(
      [
        { user_id: 'u_dana', display_name: 'Dana' },
        { user_id: 'u_sam', display_name: 'Sam' },
      ],
      [{ stream_id: 's_general', name: 'general' }],
    )
    const store = useWorkspaceStore()

    await store.load()

    // Autocomplete candidates are users then channels, mapped from the projection.
    expect(store.mentionItems).toEqual([
      { id: 'u_dana', label: 'Dana', kind: 'user' },
      { id: 'u_sam', label: 'Sam', kind: 'user' },
      { id: 's_general', label: 'general', kind: 'channel' },
    ])
    // The autocomplete source is a projection query — the HTTP escape hatch is untouched.
    expect(fake.fetch).not.toHaveBeenCalled()
    expect(fake.querySpy).toHaveBeenCalledWith({ q: 'directory.list' })
  })

  it('loads the workspace identity fold and applies a save echo (ENG-152)', async () => {
    fake.setWorkspaceInfo({ name: 'Acme', description: 'Widgets' })
    const store = useWorkspaceStore()

    await store.load()

    // A ZERO-network projection read, refreshed with the sidebar.
    expect(store.workspaceInfo).toEqual({ name: 'Acme', description: 'Widgets', icon_sha256: null })
    expect(fake.querySpy).toHaveBeenCalledWith({ q: 'workspace.info' })
    expect(fake.fetch).not.toHaveBeenCalled()

    // The admin panel's PATCH echo applies immediately (optimistic rename).
    store.applyWorkspaceUpdate({ name: 'Acme Corp', description: '', icon_sha256: null })
    expect(store.workspaceInfo).toEqual({ name: 'Acme Corp', description: '', icon_sha256: null })

    // A sync-driven refresh re-reads the fold (the meta event is the truth).
    fake.setWorkspaceInfo({ name: 'Acme Corp', description: '' })
    await store.refresh()
    expect(store.workspaceInfo).toEqual({ name: 'Acme Corp', description: '', icon_sha256: null })
  })
})
