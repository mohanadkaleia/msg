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
import { useSyncStore } from '../../../src/stores/sync'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'
import type { PresenceStatus } from '../../../src/worker'

// This env's window.localStorage is a bare object with no methods; NavGroup
// (ENG-152 group restyle) persists collapse state through it, so install a
// working in-memory Storage per test (same pattern as useTheme.spec).
function installLocalStorage(): void {
  const store = new Map<string, string>()
  const mock: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  }
  Object.defineProperty(window, 'localStorage', {
    value: mock,
    configurable: true,
    writable: true,
  })
}

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
    installLocalStorage()
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

    // Header wordmark is the BRAND, not the workspace name — demoted to a small
    // muted mark (ENG-152) so the workspace pill is the primary identity.
    expect(wrapper.text()).toContain('Ranin')
    expect(wrapper.find('span.text-muted.uppercase').text()).toBe('Ranin')
    // The workspace selector pill preserves the open-switcher affordance and
    // carries the "Local workspace" sub-label (ENG-152 hierarchy). Clicking it
    // opens the switcher's OWN workspace menu — NOT a palette event (ENG-152
    // nav cleanup: the old openSwitcher wiring opened the command palette).
    const pill = wrapper.get('[data-testid="open-switcher"]')
    expect(pill.text()).toContain('msg')
    expect(pill.text()).toContain('Local workspace')
    await pill.trigger('click')
    expect(wrapper.find('[data-testid="workspace-menu"]').exists()).toBe(true)
    expect(wrapper.emitted('openSwitcher')).toBeUndefined()
  })

  it('groups the nav under labeled Messages / Workspace headers (ENG-152 PR-c)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    const messages = wrapper.get('[data-testid="nav-group-messages"]')
    const workspaceGroup = wrapper.get('[data-testid="nav-group-workspace"]')
    expect(messages.text()).toBe('Messages')
    expect(workspaceGroup.text()).toBe('Workspace')

    // Document order: Messages (Inbox, DMs, Channels) precedes Workspace
    // (Files, Apps, Search) — same items + routes, just organized.
    const html = wrapper.html()
    const at = (needle: string) => html.indexOf(needle)
    expect(at('nav-group-messages')).toBeLessThan(at('nav-inbox'))
    expect(at('nav-inbox')).toBeLessThan(at('nav-group-workspace'))
    expect(at('sidebar-channel')).toBeLessThan(at('nav-group-workspace'))
    expect(at('nav-group-workspace')).toBeLessThan(at('nav-files'))
    expect(at('nav-group-workspace')).toBeLessThan(at('nav-apps'))
    expect(at('nav-group-workspace')).toBeLessThan(at('nav-search'))
  })

  it('indents each group under a thin border-subtle connector rule (group restyle)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    // One indented item block per group (Messages + Workspace), each carrying
    // the single vertical connector line in the subtle border token.
    const blocks = wrapper.findAll('[data-testid="nav-group-items"]')
    expect(blocks).toHaveLength(2)
    for (const block of blocks) {
      expect(block.classes()).toContain('border-l')
      expect(block.classes()).toContain('border-subtle')
      expect(block.classes()).toContain('pl-2')
    }
    // The items live INSIDE the indented blocks.
    expect(blocks[0]!.find('[data-testid="nav-inbox"]').exists()).toBe(true)
    expect(blocks[0]!.find('[data-testid="sidebar-channel"]').exists()).toBe(true)
    expect(blocks[1]!.find('[data-testid="nav-files"]').exists()).toBe(true)
    expect(blocks[1]!.find('[data-testid="nav-search"]').exists()).toBe(true)
  })

  it('collapses a group from its header, tracking aria-expanded, and persists (group restyle)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    const header = wrapper.get('[data-testid="nav-group-messages"]')
    const block = wrapper.findAll('[data-testid="nav-group-items"]')[0]!.element as HTMLElement

    // Default EXPANDED (the E2E flows click sidebar rows without toggling).
    expect(header.attributes('aria-expanded')).toBe('true')
    expect(block.style.display).not.toBe('none')

    // Collapse: aria flips, the item block hides (v-show), state persists.
    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('false')
    expect(block.style.display).toBe('none')
    expect(window.localStorage.getItem('msg:nav-group:messages')).toBe('collapsed')
    // The OTHER group is untouched.
    expect(wrapper.get('[data-testid="nav-group-workspace"]').attributes('aria-expanded')).toBe(
      'true',
    )

    // Expand again: visible + persisted back.
    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('true')
    expect(block.style.display).not.toBe('none')
    expect(window.localStorage.getItem('msg:nav-group:messages')).toBe('expanded')
  })

  it('restores a persisted collapsed group on mount (group restyle)', async () => {
    window.localStorage.setItem('msg:nav-group:workspace', 'collapsed')
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    expect(wrapper.get('[data-testid="nav-group-workspace"]').attributes('aria-expanded')).toBe(
      'false',
    )
    // Messages (no stored state) stays expanded.
    expect(wrapper.get('[data-testid="nav-group-messages"]').attributes('aria-expanded')).toBe(
      'true',
    )
  })

  it('shows the "+ New" button and wires its menu to the REAL create flows', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    fake.setDirectory([{ user_id: 'u_dana', display_name: 'Dana' }], [])
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    // "New channel" → the EXISTING CreateChannelDialog.
    await wrapper.get('[data-testid="new-button"]').trigger('click')
    await wrapper.get('[data-testid="new-menu-channel"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="create-channel"]')).toBeTruthy()
    document
      .querySelector<HTMLButtonElement>('[data-testid="create-channel"] [aria-label="Close"]')
      ?.click()

    // "New message" → the EXISTING NewDmDialog.
    await wrapper.get('[data-testid="new-button"]').trigger('click')
    await wrapper.get('[data-testid="new-menu-dm"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="new-dm"]')).toBeTruthy()
  })

  it('shows an accent unread pill on unread rows and keeps the danger mention badge', async () => {
    fake.addStream({ stream_id: 's_quiet', name: 'quiet', kind: 'channel', unread: 0 })
    fake.addStream({ stream_id: 's_busy', name: 'busy', kind: 'channel', unread: 4 })
    fake.addStream({
      stream_id: 's_ping',
      name: 'ping',
      kind: 'channel',
      unread: 2,
      mention: true,
    })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    const row = (id: string) =>
      wrapper
        .findAll('[data-testid="sidebar-channel"]')
        .find((r) => r.attributes('data-stream-id') === id)!

    // Read: no pill at all.
    expect(row('s_quiet').find('[data-testid="unread-badge"]').exists()).toBe(false)
    // Unread (no mention): the accent-subtle count pill.
    const pill = row('s_busy').get('[data-testid="unread-badge"]')
    expect(pill.text()).toBe('4')
    expect(pill.classes()).toContain('bg-accent-subtle')
    expect(pill.classes()).toContain('text-accent')
    // Mention: the danger badge wins (no double-badging).
    expect(row('s_ping').find('[data-testid="mention-badge"]').exists()).toBe(true)
    expect(row('s_ping').find('[data-testid="unread-badge"]').exists()).toBe(false)
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

  it('opens the unified search from the Search row (openSearch — ENG-152 nav cleanup)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    await wrapper.get('[data-testid="nav-search"]').trigger('click')
    // The Search row routes to the ONE search modal — never the palette event.
    expect(wrapper.emitted('openSearch')).toHaveLength(1)
    expect(wrapper.emitted('openSwitcher')).toBeUndefined()
  })

  it('renders the footer user card', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    expect(wrapper.find('[data-testid="user-card"]').exists()).toBe(true)
  })

  it('shows the ACTIVE custom status on the footer card; hides an expired one (ENG-164)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    // The signed-in user's directory record carries an unexpired status.
    fake.setMyUserId('u_me').setDirectory(
      [
        {
          user_id: 'u_me',
          display_name: 'Dana',
          status_emoji: '🌴',
          status_text: 'On vacation',
          status_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
      ],
      [],
    )
    setWorkerClient(fake.client)
    useAuthStore().myUserId = 'u_me'
    const wrapper = await mountSidebar()

    const status = wrapper.get('[data-testid="user-card-status"]')
    expect(status.text()).toContain('🌴')
    expect(status.text()).toContain('On vacation')

    // An EXPIRED status is treated as absent at render time (lazy expiry).
    fake.setDirectory(
      [
        {
          user_id: 'u_me',
          display_name: 'Dana',
          status_emoji: '🍜',
          status_text: 'Lunch',
          status_expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
      [],
    )
    await useWorkspaceStore().refresh()
    await flushPromises()
    expect(wrapper.find('[data-testid="user-card-status"]').exists()).toBe(false)
  })

  it('shows a sync-derived local-first note in the footer (ENG-152)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()
    const sync = useSyncStore()

    sync.status = { state: 'live', online: true }
    await flushPromises()
    expect(wrapper.get('[data-testid="local-first-note"]').text()).toBe('Synced · Local')

    sync.status = { state: 'syncing', online: true }
    await flushPromises()
    expect(wrapper.get('[data-testid="local-first-note"]').text()).toBe('Syncing… · Local')

    sync.status = { state: 'degraded', online: false }
    await flushPromises()
    expect(wrapper.get('[data-testid="local-first-note"]').text()).toBe('Offline · Local')
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
