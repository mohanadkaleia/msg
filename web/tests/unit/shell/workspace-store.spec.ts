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
})
