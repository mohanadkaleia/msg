// tests/unit/shell/AppShell.spec.ts — ENG-136 "Ranin" PR-C. AppShell is the promotion
// of the old `views/ShellView.vue` assembly into a CSS-grid layout component; behavior
// and every test-id are identical (only the wrapping element changed). This proves the
// grid COMPOSITION: the rail/sidebar/main/drawer landmarks render, a real conversation
// mounts channel-header + MessageList + MessageComposer, the Inbox section mounts the
// REAL InboxView (ENG-136 — no longer a placeholder), the Apps section flips main to the
// REAL AppsView (ENG-176 — owner/admin only), the thread drawer mounts when a thread is open and unmounts
// synchronously on close, and the sync indicator is unique. The heavy leaves
// (MessageList/MessageComposer/ThreadPane) are stubbed — their own testids are covered by
// their specs; here we only assert AppShell wires each region into the right track.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import AppShell from '../../../src/components/shell/AppShell.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useAuthStore } from '../../../src/stores/auth'
import { useThreadStore } from '../../../src/stores/thread'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'

const Blank = { template: '<div />' }

// Stub the heavy conversation/thread leaves but keep their region test-ids so we can
// assert AppShell placed them. RightDrawer stays REAL (its "Thread" landmark is part of
// the grid contract); only its ThreadPane child is stubbed.
const stubs = {
  MessageList: { template: '<div data-testid="message-list" />' },
  MessageComposer: { template: '<div data-testid="composer-input" />' },
  ThreadPane: { template: '<div data-testid="thread-pane" />' },
  CommandPalette: { template: '<div data-testid="command-palette-stub" />' },
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Blank },
      { path: '/login', component: Blank },
    ],
  })
}

async function mountShell(fake: FakeWorker, router: Router): Promise<ReturnType<typeof mount>> {
  setWorkerClient(fake.client)
  const wrapper = mount(AppShell, {
    attachTo: document.body,
    global: { plugins: [router], stubs },
  })
  await flushPromises()
  return wrapper
}

describe('AppShell (ENG-136 PR-C)', () => {
  let fake: FakeWorker
  let router: Router

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    router = makeRouter()
  })

  afterEach(() => {
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  it('lays out the rail / sidebar / top-bar / main landmarks', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)

    // Root is a flex application region (rail+sidebar beside the top-bar/main region).
    const root = wrapper.get('[role="application"]')
    expect(root.classes()).toContain('flex')

    // Rail — Workspaces navigation landmark.
    const rail = wrapper.get('nav[aria-label="Workspaces"]')
    expect(rail.attributes('role')).toBe('navigation')

    // Sidebar — the (now labeled) navigation landmark.
    const sidebar = wrapper.get('aside[role="navigation"]')
    expect(sidebar.attributes('aria-label')).toBe('Channels and direct messages')

    // TopBar — a centered search that opens the message-search overlay (ENG-127).
    expect(wrapper.find('[data-testid="topbar-search"]').exists()).toBe(true)

    // Main region.
    expect(wrapper.find('main[role="main"]').exists()).toBe(true)

    // Drawer is absent until a thread opens.
    expect(wrapper.find('[role="complementary"][aria-label="Thread"]').exists()).toBe(false)
  })

  it('routes every search entry to the ONE overlay; Cmd+K toggles the palette (ENG-152)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    // Unstub CommandPalette so we can observe it opening.
    setWorkerClient(fake.client)
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: {
          MessageList: stubs.MessageList,
          MessageComposer: stubs.MessageComposer,
          ThreadPane: stubs.ThreadPane,
        },
      },
    })
    await flushPromises()

    // The top-bar search opens the unified search modal (NOT the palette).
    expect(wrapper.find('[data-testid="search-overlay"]').exists()).toBe(false)
    await wrapper.get('[data-testid="topbar-search"]').trigger('click')
    expect(wrapper.find('[data-testid="search-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="search-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(false)

    // Esc dismisses the overlay.
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="search-overlay"]').exists()).toBe(false)

    // The sidebar's Search row opens the SAME overlay (no second search UI).
    await wrapper.get('[data-testid="nav-search"]').trigger('click')
    expect(wrapper.find('[data-testid="search-overlay"]').exists()).toBe(true)
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'Escape' })

    // Cmd+K → the command palette; a second Cmd+K closes it (toggle).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(false)

    // Cmd+/ → the unified search modal (search's own shortcut).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="search-overlay"]').exists()).toBe(true)
  })

  it('the workspace pill opens the workspace menu — NOT the command palette (ENG-152)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: {
          MessageList: stubs.MessageList,
          MessageComposer: stubs.MessageComposer,
          ThreadPane: stubs.ThreadPane,
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="open-switcher"]').trigger('click')
    await wrapper.vm.$nextTick()
    // The crossed wiring (pill → palette) must not come back.
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-menu"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-menu-current"]').exists()).toBe(true)
  })

  it('the top bar carries no bell and no compose button (ENG-152 nav cleanup)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel', unread: 2 })
    const wrapper = await mountShell(fake, router)

    expect(wrapper.find('button[aria-label="Notifications"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="topbar-bell-dot"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="New message"]').exists()).toBe(false)
    // New-message indication lives on the Inbox nav badge instead.
    expect(wrapper.get('[data-testid="inbox-unread"]').text()).toBe('2')
  })

  it('palette "Create channel" command opens the EXISTING create-channel dialog (ENG-136)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    setWorkerClient(fake.client)
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: {
          MessageList: stubs.MessageList,
          MessageComposer: stubs.MessageComposer,
          ThreadPane: stubs.ThreadPane,
        },
      },
    })
    await flushPromises()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(true)
    // The Commands group lists the action with its per-id testid.
    expect(wrapper.find('[data-testid="create-channel"]').exists()).toBe(false)
    await wrapper.get('[data-testid="palette-command-create-channel"]').trigger('click')
    await flushPromises()

    // Palette closed; the SAME dialog the Inbox compose menu's "New channel" opens.
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="create-channel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="create-channel-name"]').exists()).toBe(true)
  })

  it('palette "Browse channels" command lists un-joined publics and joins on click (ENG-177)', async () => {
    // ENG-177: the sidebar ⌕ button is gone; browsing now originates in the palette.
    fake.addStream({ stream_id: 's_general', name: 'general', kind: 'channel', member: true })
    fake.addStream({
      stream_id: 's_open',
      name: 'random',
      kind: 'channel',
      visibility: 'public',
      member: false,
    })
    setWorkerClient(fake.client)
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: {
          MessageList: stubs.MessageList,
          MessageComposer: stubs.MessageComposer,
          ThreadPane: stubs.ThreadPane,
        },
      },
    })
    await flushPromises()

    const store = useWorkspaceStore()
    // The un-joined public channel is NOT in the sidebar list yet.
    expect(store.channels.some((c) => c.stream_id === 's_open')).toBe(false)
    expect(store.browsableChannels.map((c) => c.stream_id)).toEqual(['s_open'])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="palette-command-browse-channels"]').trigger('click')
    await flushPromises()

    const browser = document.querySelector('[data-testid="channel-browser"]')!
    const joinBtn = browser.querySelector<HTMLButtonElement>('[data-testid="join-channel"]')!
    expect(joinBtn.getAttribute('data-stream-id')).toBe('s_open')
    joinBtn.click()
    await flushPromises()

    // Joining a public channel is a local open + switch (§3.6 — no membership event).
    expect(fake.metaSpy).not.toHaveBeenCalled()
    expect(store.selectedStreamId).toBe('s_open')
    expect(store.channels.some((c) => c.stream_id === 's_open')).toBe(true)
  })

  it('search jump closes the overlay and selects the hit stream (ENG-127)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.addStream({ stream_id: 's_b', name: 'beta', kind: 'channel' })
    const target = fake.addMessage('s_b', { created_seq: 1, text: 'jump target' })
    fake.queueSearch({
      hits: [
        {
          message_id: target.message_id,
          stream_id: 's_b',
          author_user_id: 'u_other',
          text: 'jump target',
          created_seq: 1,
          rank: 1,
          thread_root_id: null,
        },
      ],
      next_cursor: null,
    })
    const wrapper = await mountShell(fake, router)
    expect(wrapper.get('[data-testid="channel-header"]').text()).toBe('# alpha')

    await wrapper.get('[data-testid="topbar-search"]').trigger('click')
    await wrapper.get('[data-testid="search-input"]').setValue('jump')
    await new Promise((resolve) => setTimeout(resolve, 300)) // debounce
    await flushPromises()

    await wrapper.get('[data-testid="search-jump"]').trigger('click')
    await flushPromises()

    // Overlay closed + the hit's stream selected (best-effort scroll is covered
    // by MessageList.spec — the list is stubbed here).
    expect(wrapper.find('[data-testid="search-overlay"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="channel-header"]').text()).toBe('# beta')
  })

  it('renders channel-header + MessageList + MessageComposer for a real conversation', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)

    // Default-selected the first channel → conversation view in main.
    const main = wrapper.get('main[role="main"]')
    expect(main.find('[data-testid="channel-header"]').exists()).toBe(true)
    expect(main.find('[data-testid="message-list"]').exists()).toBe(true)
    expect(main.find('[data-testid="composer-input"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="channel-header"]').text()).toBe('# alpha')
  })

  it('renders the REAL two-pane InboxView for the Inbox section (not a placeholder)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel', unread: 1 })
    fake.addMessage('s_a', { created_seq: 1, text: 'hello inbox' })
    const wrapper = await mountShell(fake, router)

    await wrapper.get('[data-testid="nav-inbox"]').trigger('click')
    await flushPromises()

    // The conversation leaves (and its channel-header) are gone; InboxView owns main.
    expect(wrapper.find('[data-testid="message-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="channel-header"]').exists()).toBe(false)
    const main = wrapper.get('main[role="main"]')
    expect(main.find('[data-testid="inbox-view"]').exists()).toBe(true)
    expect(main.find('[data-testid="inbox-tab-all"]').exists()).toBe(true)
    // The two-pane split (ENG-152): the preview pane sits beside the feed list,
    // empty-state until a row is selected.
    expect(main.find('[data-testid="inbox-preview"]').exists()).toBe(true)
    expect(main.find('[data-testid="inbox-preview-empty"]').exists()).toBe(true)
    expect(main.text()).not.toContain('coming soon')

    // A real derived activity row is listed for the seeded stream.
    const row = main.get('[data-testid="inbox-item"]')
    expect(row.attributes('data-stream-id')).toBe('s_a')

    // Clicking the row SELECTS it for preview — the shell STAYS on the Inbox.
    await row.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="inbox-preview-empty"]').exists()).toBe(false)
    const open = wrapper.get('[data-testid="inbox-preview-open"]')

    // The preview's "Open" does the full jump to that stream's conversation.
    await open.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-view"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-list"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="channel-header"]').text()).toBe('# alpha')
  })

  it('flips the main panel to the REAL Apps surface (ENG-176 — owner/admin only)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    // The Apps nav item is owner/admin-gated; land as an owner so it renders.
    const auth = useAuthStore()
    auth.role = 'owner'
    auth.myUserId = 'u_owner'
    const wrapper = await mountShell(fake, router)

    await wrapper.get('[data-testid="nav-apps"]').trigger('click')
    await flushPromises()

    // The conversation leaves are gone; the REAL AppsView (bots panel) is shown
    // — no scaffold, no "coming soon".
    expect(wrapper.find('[data-testid="message-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-input"]').exists()).toBe(false)
    const main = wrapper.get('main[role="main"]')
    expect(main.find('[data-testid="apps-view"]').exists()).toBe(true)
    expect(main.find('[data-testid="apps-bots"]').exists()).toBe(true)
    expect(main.text()).not.toContain('coming soon')
  })

  it('opens the thread drawer when a thread is open and unmounts it synchronously on close', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const root = fake.addMessage('s_a', { created_seq: 1, text: 'root' })
    const wrapper = await mountShell(fake, router)

    const thread = useThreadStore()
    await thread.openThread(root.message_id, 's_a')
    await flushPromises()

    // Drawer appears as a second column in the main/drawer grid, hosting the thread pane.
    const drawer = wrapper.get('[role="complementary"][aria-label="Thread"]')
    expect(drawer.find('[data-testid="thread-pane"]').exists()).toBe(true)
    expect(wrapper.find('.grid-cols-\\[1fr_24rem\\]').exists()).toBe(true)

    // Closing removes the pane immediately (no leave transition), as before.
    thread.close()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="complementary"][aria-label="Thread"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="thread-pane"]').exists()).toBe(false)
  })

  it('toggles the Details drawer from the channel-header details button', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)

    expect(wrapper.find('[role="complementary"][aria-label="Details"]').exists()).toBe(false)
    await wrapper.get('[data-testid="channel-header-details"]').trigger('click')
    await flushPromises()

    // Details drawer opens in its own (16rem) grid track with the reference rows.
    const drawer = wrapper.get('[role="complementary"][aria-label="Details"]')
    expect(drawer.find('[data-testid="channel-details"]').exists()).toBe(true)
    expect(drawer.text()).toContain('Notifications')
    expect(wrapper.find('.grid-cols-\\[1fr_16rem\\]').exists()).toBe(true)

    // The ✕ closes it and the grid column collapses.
    await drawer.get('[data-testid="details-close"]').trigger('click')
    expect(wrapper.find('[role="complementary"][aria-label="Details"]').exists()).toBe(false)
    expect(wrapper.find('.grid-cols-\\[1fr_16rem\\]').exists()).toBe(false)
  })

  it('details displaces an open thread (mutual exclusion) and vice versa', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const root = fake.addMessage('s_a', { created_seq: 1, text: 'root' })
    const wrapper = await mountShell(fake, router)

    const thread = useThreadStore()
    await thread.openThread(root.message_id, 's_a')
    await flushPromises()
    expect(wrapper.find('[role="complementary"][aria-label="Thread"]').exists()).toBe(true)

    // Details button → thread closes, details opens (never both columns).
    await wrapper.get('[data-testid="channel-header-details"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="complementary"][aria-label="Thread"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="thread-pane"]').exists()).toBe(false)
    expect(wrapper.find('[role="complementary"][aria-label="Details"]').exists()).toBe(true)

    // Re-opening a thread displaces the details drawer.
    await thread.openThread(root.message_id, 's_a')
    await flushPromises()
    expect(wrapper.find('[role="complementary"][aria-label="Details"]').exists()).toBe(false)
    expect(wrapper.find('[role="complementary"][aria-label="Thread"]').exists()).toBe(true)
    expect(wrapper.find('.grid-cols-\\[1fr_24rem\\]').exists()).toBe(true)
  })

  it('opens the EXISTING channel-settings dialog from the details Members row', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)

    await wrapper.get('[data-testid="channel-header-details"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="channel-settings"]').exists()).toBe(false)

    await wrapper.get('[data-testid="channel-members"]').trigger('click')
    await flushPromises()
    const dialog = wrapper.get('[data-testid="channel-settings"]')
    expect(dialog.text()).toContain('alpha')
  })

  it('collapse control hides the sidebar; the TopBar affordance expands it (ENG-174)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)

    // The control is REAL now — no "(coming soon)" copy anywhere on it.
    const control = wrapper.get('[data-testid="collapse-sidebar"]')
    expect(control.attributes('aria-label')).toBe('Collapse sidebar')
    expect(control.attributes('title')).not.toContain('coming soon')

    // Default: sidebar visible, no expand affordance in the top bar.
    const sidebar = wrapper.get('aside[role="navigation"]').element as HTMLElement
    expect(sidebar.style.display).not.toBe('none')
    expect(wrapper.find('[data-testid="expand-sidebar"]').exists()).toBe(false)

    // Click → the sidebar column hides (v-show — rows stay mounted) and the
    // rail + main column remain; the top bar now offers the expand affordance.
    await control.trigger('click')
    expect(sidebar.style.display).toBe('none')
    expect(wrapper.find('nav[aria-label="Workspaces"]').exists()).toBe(true)
    expect(wrapper.find('main[role="main"]').exists()).toBe(true)

    // Expand from the top bar: the sidebar returns, the affordance goes away.
    await wrapper.get('[data-testid="expand-sidebar"]').trigger('click')
    expect(sidebar.style.display).not.toBe('none')
    expect(wrapper.find('[data-testid="expand-sidebar"]').exists()).toBe(false)
  })

  it('Cmd+\\ toggles the sidebar from anywhere (ENG-174)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)
    const sidebar = wrapper.get('aside[role="navigation"]').element as HTMLElement

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true }))
    await wrapper.vm.$nextTick()
    expect(sidebar.style.display).toBe('none')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true }))
    await wrapper.vm.$nextTick()
    expect(sidebar.style.display).not.toBe('none')
  })

  it('hosts exactly one sync indicator (unique selector for the golden path)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)
    expect(wrapper.findAll('[data-testid="sync-indicator"]')).toHaveLength(1)
  })
})
