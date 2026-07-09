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
import { useAuthStore } from '../../../src/stores/auth'
import { usePresenceStore } from '../../../src/stores/presence'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'
import type { PresenceStatus } from '../../../src/worker'

async function mountSidebar(): Promise<ReturnType<typeof mount>> {
  const store = useWorkspaceStore()
  await store.load()
  const wrapper = mount(AppSidebar, {
    attachTo: document.body,
    // ENG-136 feed-first sidebar props (activeView drives active state; the
    // ENG-104 flows asserted here are unchanged and testid-addressed).
    props: {
      activeView: 'conversation',
      workspaceName: 'msg',
      workspaceInitials: 'MS',
      canAdmin: false,
    },
  })
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

describe('AppSidebar — ENG-136 feed-first structure', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
  })

  afterEach(() => {
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  it('shows the "Ranin" brand wordmark and the workspace selector pill', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    // Header wordmark is the BRAND, not the workspace name.
    expect(wrapper.text()).toContain('Ranin')
    // The workspace selector pill preserves the open-switcher affordance.
    const pill = wrapper.get('[data-testid="open-switcher"]')
    await pill.trigger('click')
    expect(wrapper.emitted('openSwitcher')).toHaveLength(1)
  })

  it('renders the nav rows with their preserved test-ids (and NO Feeds section)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    for (const id of ['nav-inbox', 'nav-apps', 'nav-files', 'nav-search']) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(true)
    }
    // IA (user decision): Inbox is the single triage surface — no Feeds section.
    expect(wrapper.find('[data-testid="nav-feeds"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Feeds')
    // A real channel row carries a leading hash icon (lucide-hash svg).
    const channel = wrapper.get('[data-testid="sidebar-channel"]')
    expect(channel.find('svg.lucide-hash').exists()).toBe(true)
  })

  it('shows a REAL total-unread badge on Inbox summed across channels + DMs', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel', unread: 2 })
    fake.addStream({ stream_id: 's_dm', name: 'dana', kind: 'dm', unread: 3, member: true })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    expect(wrapper.get('[data-testid="inbox-unread"]').text()).toBe('5')
  })

  it('opens the palette from the Search row (openSwitcher)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    await wrapper.get('[data-testid="nav-search"]').trigger('click')
    expect(wrapper.emitted('openSwitcher')).toHaveLength(1)
  })

  it('renders the footer user card', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    expect(wrapper.find('[data-testid="user-card"]').exists()).toBe(true)
  })

  it('labels a DM row with the OTHER participant’s name + a live presence dot (ENG-149)', async () => {
    fake.addStream({ stream_id: 's_dm', kind: 'dm', dm_user_ids: ['u_me', 'u_dana'] })
    fake.setDirectory([{ user_id: 'u_dana', display_name: 'Dana' }], [])
    setWorkerClient(fake.client)
    useAuthStore().myUserId = 'u_me'
    usePresenceStore().statuses = new Map<string, PresenceStatus>([['u_dana', 'online']])
    const wrapper = await mountSidebar()

    // The row (test-id preserved) shows the resolved display name, not the id.
    const dm = wrapper.get('[data-testid="sidebar-dm"]')
    expect(dm.text()).toContain('Dana')
    expect(dm.text()).not.toContain('s_dm')
    // The avatar initial follows the resolved name…
    expect(dm.text()).toContain('D')
    // …and the presence dot reflects the OTHER participant's live status.
    expect(dm.get('[data-testid="presence-dot"]').attributes('data-status')).toBe('online')

    // Presence flips are honored (offline → muted dot).
    usePresenceStore().statuses = new Map<string, PresenceStatus>([['u_dana', 'offline']])
    await flushPromises()
    expect(dm.get('[data-testid="presence-dot"]').attributes('data-status')).toBe('offline')
  })

  it('keeps the id label and shows no dot for a DM with unresolvable participants', async () => {
    // No dm_user_ids (genesis not cached) — the row keeps its previous fallback.
    fake.addStream({ stream_id: 's_dm_bare', kind: 'dm' })
    setWorkerClient(fake.client)
    useAuthStore().myUserId = 'u_me'
    const wrapper = await mountSidebar()

    const dm = wrapper.get('[data-testid="sidebar-dm"]')
    expect(dm.text()).toContain('s_dm_bare')
    expect(dm.find('[data-testid="presence-dot"]').exists()).toBe(false)
  })

  it('gates the Admin section on canAdmin', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)

    const store = useWorkspaceStore()
    await store.load()
    const wrapper = mount(AppSidebar, {
      attachTo: document.body,
      props: {
        activeView: 'conversation',
        workspaceName: 'msg',
        workspaceInitials: 'MS',
        canAdmin: true,
      },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="nav-admin"]').exists()).toBe(true)
  })
})
