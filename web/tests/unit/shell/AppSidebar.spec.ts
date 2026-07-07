// tests/unit/shell/AppSidebar.spec.ts — ENG-104 channel & member management + DM
// creation from the sidebar. Mounts AppSidebar over a FakeWorker and asserts each
// flow authors the RIGHT mutation (never a direct HTTP call): create-channel,
// browse+join a public channel, and start a DM. The token boundary is proven by
// `fake.fetch` staying untouched (the no-http-in-ui guard covers the source too).
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import AppSidebar from '../../../src/components/shell/AppSidebar.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'

async function mountSidebar(): Promise<ReturnType<typeof mount>> {
  const store = useWorkspaceStore()
  await store.load()
  const wrapper = mount(AppSidebar, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('AppSidebar — ENG-104 channel/DM management', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
  })

  afterEach(() => {
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  it('create-channel authors channel.create and switches to the new channel', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    await wrapper.get('[data-testid="open-create-channel"]').trigger('click')
    await flushPromises()
    // The dialog is a fixed overlay outside the component root — query the document.
    const dialog = document.querySelector('[data-testid="create-channel"]')!
    expect(dialog).toBeTruthy()

    const nameInput = dialog.querySelector<HTMLInputElement>('[data-testid="create-channel-name"]')!
    nameInput.value = 'random'
    nameInput.dispatchEvent(new Event('input'))
    const priv = dialog.querySelector<HTMLInputElement>('[data-testid="create-channel-private"]')!
    priv.dispatchEvent(new Event('change'))
    await flushPromises()

    dialog.querySelector<HTMLButtonElement>('[data-testid="create-channel-submit"]')!.click()
    await flushPromises()

    // The RIGHT event was authored — never a direct HTTP call.
    expect(fake.metaSpy).toHaveBeenCalledTimes(1)
    expect(fake.metaSpy.mock.calls[0]![0]).toMatchObject({
      m: 'channel.create',
      name: 'random',
      visibility: 'private',
    })
    expect(fake.fetch).not.toHaveBeenCalled()

    // Instant switch: the store selected the freshly-created stream.
    const store = useWorkspaceStore()
    expect(store.selectedStreamId).not.toBe('s_general')
    expect(store.channels.some((c) => c.stream_id === store.selectedStreamId)).toBe(true)
  })

  it('channel-browser lists un-joined public channels and joins on click', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel', member: true })
    fake.addStream({
      stream_id: 's_open',
      name: 'random',
      kind: 'channel',
      visibility: 'public',
      member: false,
    })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    // The un-joined public channel is NOT in the sidebar list yet.
    const store = useWorkspaceStore()
    expect(store.channels.some((c) => c.stream_id === 's_open')).toBe(false)
    expect(store.browsableChannels.map((c) => c.stream_id)).toEqual(['s_open'])

    await wrapper.get('[data-testid="open-channel-browser"]').trigger('click')
    await flushPromises()
    const browser = document.querySelector('[data-testid="channel-browser"]')!
    const joinBtn = browser.querySelector<HTMLButtonElement>('[data-testid="join-channel"]')!
    expect(joinBtn.getAttribute('data-stream-id')).toBe('s_open')
    joinBtn.click()
    await flushPromises()

    // Joining a public channel is a local open + switch (§3.6 — no membership event).
    expect(fake.metaSpy).not.toHaveBeenCalled()
    expect(fake.fetch).not.toHaveBeenCalled()
    expect(store.selectedStreamId).toBe('s_open')
    expect(store.channels.some((c) => c.stream_id === 's_open')).toBe(true)
  })

  it('new-dm authors dm.create for the picked member and switches to it', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    fake.setDirectory(
      [
        { user_id: 'u_dana', display_name: 'Dana' },
        { user_id: 'u_sam', display_name: 'Sam' },
      ],
      [],
    )
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    await wrapper.get('[data-testid="open-new-dm"]').trigger('click')
    await flushPromises()
    const dialog = document.querySelector('[data-testid="new-dm"]')!
    const dana = [
      ...dialog.querySelectorAll<HTMLButtonElement>('[data-testid="new-dm-user"]'),
    ].find((b) => b.getAttribute('data-user-id') === 'u_dana')!
    dana.click()
    await flushPromises()

    expect(fake.metaSpy).toHaveBeenCalledTimes(1)
    expect(fake.metaSpy.mock.calls[0]![0]).toMatchObject({ m: 'dm.create', user_ids: ['u_dana'] })
    expect(fake.fetch).not.toHaveBeenCalled()

    const store = useWorkspaceStore()
    expect(store.dms.some((d) => d.stream_id === store.selectedStreamId)).toBe(true)
  })

  it('channel settings authors rename and archive for the selected channel', async () => {
    fake.addStream({ stream_id: 's_proj', name: 'proj', kind: 'channel', visibility: 'private' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    await wrapper.get('[data-testid="open-channel-settings"]').trigger('click')
    await flushPromises()
    const dialog = document.querySelector('[data-testid="channel-settings"]')!

    const nameInput = dialog.querySelector<HTMLInputElement>(
      '[data-testid="channel-rename-input"]',
    )!
    nameInput.value = 'proj2'
    nameInput.dispatchEvent(new Event('input'))
    await flushPromises()
    dialog.querySelector<HTMLButtonElement>('[data-testid="channel-rename-submit"]')!.click()
    await flushPromises()

    expect(fake.metaSpy.mock.calls.at(-1)![0]).toMatchObject({
      m: 'channel.rename',
      stream_id: 's_proj',
      name: 'proj2',
    })

    dialog.querySelector<HTMLButtonElement>('[data-testid="channel-archive"]')!.click()
    await flushPromises()
    expect(fake.metaSpy.mock.calls.at(-1)![0]).toMatchObject({
      m: 'channel.archive',
      stream_id: 's_proj',
    })
    expect(fake.fetch).not.toHaveBeenCalled()
  })
})
