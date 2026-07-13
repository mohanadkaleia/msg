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

async function mountSidebar(
  overrides: Record<string, unknown> = {},
): Promise<ReturnType<typeof mount>> {
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
      ...overrides,
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

    // ENG-177: the Channels header `+` is gone — the sidebar's create-channel
    // path is now the Inbox compose menu (New channel).
    await wrapper.get('[data-testid="inbox-compose"]').trigger('click')
    await wrapper.get('[data-testid="new-menu-channel"]').trigger('click')
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

  // (ENG-177) The channel BROWSER no longer opens from the sidebar — the ⌕
  // button was removed. Its "list un-joined publics + join on click" behavior is
  // now covered from the command palette in AppShell.spec.ts.

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

  it('shows the "Serin" brand wordmark and the workspace selector pill', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    // Header wordmark is the BRAND, not the workspace name — demoted to a small
    // muted mark (ENG-152) so the workspace pill is the primary identity.
    expect(wrapper.text()).toContain('Serin')
    expect(wrapper.find('span.text-muted.uppercase').text()).toBe('Serin')
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

  it('flattens the nav: top-level Inbox/DMs/Channels, no "Messages" header (restructure)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    // Apps is owner/admin-gated (ENG-176), so mount as an admin to assert its
    // position within the Workspace group alongside Files/Search.
    const wrapper = await mountSidebar({ canAdmin: true })

    // The "Messages" category header is GONE — its former children are
    // top-level nodes now.
    expect(wrapper.find('[data-testid="nav-group-messages"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Messages')

    // DMs and Channels are expandable nodes; Workspace keeps its group.
    expect(wrapper.get('[data-testid="nav-group-dms"]').text()).toBe('DMs')
    expect(wrapper.get('[data-testid="nav-group-channels"]').text()).toBe('Channels')
    expect(wrapper.get('[data-testid="nav-group-workspace"]').text()).toBe('Workspace')

    // Document order: Inbox (leaf) · DMs · Channels · Workspace (Files, Apps,
    // Search) — same items + routes, just reorganized.
    const html = wrapper.html()
    const at = (needle: string) => html.indexOf(needle)
    expect(at('nav-inbox')).toBeLessThan(at('nav-group-dms'))
    expect(at('nav-group-dms')).toBeLessThan(at('nav-group-channels'))
    expect(at('nav-group-channels')).toBeLessThan(at('sidebar-channel'))
    expect(at('sidebar-channel')).toBeLessThan(at('nav-group-workspace'))
    expect(at('nav-group-workspace')).toBeLessThan(at('nav-files'))
    expect(at('nav-group-workspace')).toBeLessThan(at('nav-apps'))
    expect(at('nav-group-workspace')).toBeLessThan(at('nav-search'))
  })

  it('indents each node’s children under a thin border-subtle connector rule', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    fake.addStream({ stream_id: 's_dm', kind: 'dm', dm_user_ids: ['u_me', 'u_dana'] })
    fake.setDirectory([{ user_id: 'u_dana', display_name: 'Dana' }], [])
    setWorkerClient(fake.client)
    useAuthStore().myUserId = 'u_me'
    const wrapper = await mountSidebar()

    // One indented child block per collapsible node (DMs + Channels +
    // Workspace), each carrying the single vertical connector line in the
    // subtle border token.
    const blocks = wrapper.findAll('[data-testid="nav-group-items"]')
    expect(blocks).toHaveLength(3)
    for (const block of blocks) {
      expect(block.classes()).toContain('border-l')
      expect(block.classes()).toContain('border-subtle')
      expect(block.classes()).toContain('pl-2')
    }
    // The children live INSIDE their node's indented block…
    expect(blocks[0]!.find('[data-testid="sidebar-dm"]').exists()).toBe(true)
    expect(blocks[1]!.find('[data-testid="sidebar-channel"]').exists()).toBe(true)
    expect(blocks[2]!.find('[data-testid="nav-files"]').exists()).toBe(true)
    expect(blocks[2]!.find('[data-testid="nav-search"]').exists()).toBe(true)
    // …while Inbox is a TOP-LEVEL leaf, inside no block.
    for (const block of blocks) {
      expect(block.find('[data-testid="nav-inbox"]').exists()).toBe(false)
    }
    expect(wrapper.find('[data-testid="nav-inbox"]').exists()).toBe(true)
  })

  it('collapses the DMs node from its header, tracking aria-expanded, and persists', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    const header = wrapper.get('[data-testid="nav-group-dms"]')
    const block = wrapper.findAll('[data-testid="nav-group-items"]')[0]!.element as HTMLElement

    // Default EXPANDED (the E2E flows click sidebar rows without toggling),
    // chevron pointing DOWN.
    expect(header.attributes('aria-expanded')).toBe('true')
    expect(header.find('svg.lucide-chevron-down-icon, svg.lucide-chevron-down').exists()).toBe(true)
    expect(block.style.display).not.toBe('none')

    // Collapse: aria flips, the chevron turns, the child block hides (v-show),
    // state persists per node.
    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('false')
    expect(header.find('svg.lucide-chevron-right-icon, svg.lucide-chevron-right').exists()).toBe(
      true,
    )
    expect(block.style.display).toBe('none')
    expect(window.localStorage.getItem('msg:nav-group:dms')).toBe('collapsed')
    // The OTHER nodes are untouched.
    expect(wrapper.get('[data-testid="nav-group-channels"]').attributes('aria-expanded')).toBe(
      'true',
    )
    expect(wrapper.get('[data-testid="nav-group-workspace"]').attributes('aria-expanded')).toBe(
      'true',
    )

    // Expand again: visible + persisted back.
    await header.trigger('click')
    expect(header.attributes('aria-expanded')).toBe('true')
    expect(block.style.display).not.toBe('none')
    expect(window.localStorage.getItem('msg:nav-group:dms')).toBe('expanded')
  })

  it('restores a persisted collapsed node on mount', async () => {
    window.localStorage.setItem('msg:nav-group:channels', 'collapsed')
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    expect(wrapper.get('[data-testid="nav-group-channels"]').attributes('aria-expanded')).toBe(
      'false',
    )
    // DMs + Workspace (no stored state) stay expanded.
    expect(wrapper.get('[data-testid="nav-group-dms"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-testid="nav-group-workspace"]').attributes('aria-expanded')).toBe(
      'true',
    )
  })

  it('the Inbox row carries a compose icon wired to the REAL create flows (no "+ New")', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    fake.setDirectory([{ user_id: 'u_dana', display_name: 'Dana' }], [])
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    // The standalone "+ New" button is GONE (user feedback) — the create menu
    // now hangs off a small compose icon NEXT TO the Inbox nav row.
    expect(wrapper.find('[data-testid="new-button"]').exists()).toBe(false)
    const compose = wrapper.get('[data-testid="inbox-compose"]')
    expect(compose.attributes('aria-label')).toBe('New message or channel')
    // A compose glyph sitting beside (NOT nested inside) the Inbox row button.
    expect(compose.find('svg.lucide-square-pen-icon, svg.lucide-square-pen').exists()).toBe(true)
    const inboxRow = wrapper.get('[data-testid="nav-inbox"]')
    expect(inboxRow.find('[data-testid="inbox-compose"]').exists()).toBe(false)
    expect(inboxRow.element.parentElement!.contains(compose.element)).toBe(true)

    // "New channel" → the EXISTING CreateChannelDialog (menu test-ids preserved).
    await compose.trigger('click')
    expect(wrapper.find('[data-testid="new-menu"]').exists()).toBe(true)
    await wrapper.get('[data-testid="new-menu-channel"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="create-channel"]')).toBeTruthy()
    document
      .querySelector<HTMLButtonElement>('[data-testid="create-channel"] [aria-label="Close"]')
      ?.click()

    // "New message" → the EXISTING NewDmDialog.
    await compose.trigger('click')
    await wrapper.get('[data-testid="new-menu-dm"]').trigger('click')
    await flushPromises()
    expect(document.querySelector('[data-testid="new-dm"]')).toBeTruthy()

    // Composing never navigates: the Inbox row click stays the ONLY selectView.
    expect(wrapper.emitted('selectView')).toBeUndefined()
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
    // Apps is owner/admin-gated (ENG-176) — mount as an admin so its row renders
    // alongside the always-present Inbox/Files/Search rows.
    const wrapper = await mountSidebar({ canAdmin: true })

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

  it('gates the Apps nav item on canAdmin (ENG-176 — the plugin surface is owner/admin only)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)

    // Member/guest: no Apps entry point (the whole plugin surface is server-side
    // owner/admin-gated, so the entry point never appears).
    const member = await mountSidebar() // canAdmin: false
    expect(member.find('[data-testid="nav-apps"]').exists()).toBe(false)

    // Owner/admin: the Apps row is present and routes via selectView('apps').
    const admin = await mountSidebar({ canAdmin: true })
    expect(admin.find('[data-testid="nav-apps"]').exists()).toBe(true)
    await admin.get('[data-testid="nav-apps"]').trigger('click')
    expect(admin.emitted('selectView')).toEqual([['apps']])
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

  it('the collapse control is functional — emits toggleCollapse, no "coming soon" (ENG-174)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar()

    const control = wrapper.get('[data-testid="collapse-sidebar"]')
    expect(control.attributes('aria-label')).toBe('Collapse sidebar')
    expect(control.attributes('title')).not.toContain('coming soon')
    expect(wrapper.text()).not.toContain('coming soon')

    await control.trigger('click')
    expect(wrapper.emitted('toggleCollapse')).toHaveLength(1)
  })

  it('hides the sidebar column when collapsed (v-show — rows stay mounted)', async () => {
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
        canAdmin: false,
        collapsed: true,
      },
    })
    await flushPromises()

    const aside = wrapper.get('aside[role="navigation"]').element as HTMLElement
    expect(aside.style.display).toBe('none')
    // v-show, not v-if: the stream rows are still in the DOM (no re-mount cost).
    expect(wrapper.find('[data-testid="sidebar-channel"]').exists()).toBe(true)

    // Expanding restores the column without re-mounting.
    await wrapper.setProps({ collapsed: false })
    expect(aside.style.display).not.toBe('none')
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

  it('labels a DM row with the OTHER participant’s name and NO presence dot (restructure)', async () => {
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
    // …but the presence dot is GONE from DM rows (sidebar restructure feedback)
    // even while the counterpart's live presence is known.
    expect(dm.find('[data-testid="presence-dot"]').exists()).toBe(false)
  })

  it('keeps the id label for a DM with unresolvable participants (no dot either)', async () => {
    // No dm_user_ids (genesis not cached) — the row keeps its previous fallback.
    fake.addStream({ stream_id: 's_dm_bare', kind: 'dm' })
    setWorkerClient(fake.client)
    useAuthStore().myUserId = 'u_me'
    const wrapper = await mountSidebar()

    const dm = wrapper.get('[data-testid="sidebar-dm"]')
    expect(dm.text()).toContain('s_dm_bare')
    expect(dm.find('[data-testid="presence-dot"]').exists()).toBe(false)
  })

  it('gates BOTH split Admin items on canAdmin', async () => {
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
    expect(wrapper.find('[data-testid="nav-admin-workspace"]').exists()).toBe(true)
  })

  it('hides BOTH split Admin items for a non-privileged user', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = await mountSidebar() // canAdmin: false

    expect(wrapper.find('[data-testid="nav-admin"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="nav-admin-workspace"]').exists()).toBe(false)
  })

  it('splits the Admin nav: each item deep-targets its AdminView tab (openAdmin)', async () => {
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel' })
    setWorkerClient(fake.client)

    const store = useWorkspaceStore()
    await store.load()
    const wrapper = mount(AppSidebar, {
      attachTo: document.body,
      props: {
        activeView: 'admin',
        workspaceName: 'msg',
        workspaceInitials: 'MS',
        canAdmin: true,
        adminTab: 'members',
      },
    })
    await flushPromises()

    const members = wrapper.get('[data-testid="nav-admin"]')
    const settings = wrapper.get('[data-testid="nav-admin-workspace"]')
    expect(members.text()).toBe('Members & invites')
    expect(settings.text()).toBe('Workspace')

    // Each item routes through the shell's deep-target seam — NOT the plain
    // selectView('admin') the former single item used.
    await members.trigger('click')
    await settings.trigger('click')
    expect(wrapper.emitted('openAdmin')).toEqual([['members'], ['workspace']])
    expect(wrapper.emitted('selectView')).toBeUndefined()

    // Active state follows the SHOWING AdminView tab: members/invites light up
    // "Members & invites"; the workspace tab lights up "Workspace".
    expect(members.classes()).toContain('bg-accent-subtle')
    expect(settings.classes()).not.toContain('bg-accent-subtle')
    await wrapper.setProps({ adminTab: 'invites' })
    expect(members.classes()).toContain('bg-accent-subtle')
    expect(settings.classes()).not.toContain('bg-accent-subtle')
    await wrapper.setProps({ adminTab: 'workspace' })
    expect(members.classes()).not.toContain('bg-accent-subtle')
    expect(settings.classes()).toContain('bg-accent-subtle')
  })
})
