// tests/unit/shell/AppShell.spec.ts — ENG-136 "Ranin" PR-C. AppShell is the promotion
// of the old `views/ShellView.vue` assembly into a CSS-grid layout component; behavior
// and every test-id are identical (only the wrapping element changed). This proves the
// grid COMPOSITION: the rail/sidebar/main/drawer landmarks render, a real conversation
// mounts channel-header + MessageList + MessageComposer, the Inbox section mounts the
// REAL InboxView (ENG-136 — no longer a placeholder), a scaffold section flips main to
// an EmptyState, the thread drawer mounts when a thread is open and unmounts
// synchronously on close, and the sync indicator is unique. The heavy leaves
// (MessageList/MessageComposer/ThreadPane) are stubbed — their own testids are covered by
// their specs; here we only assert AppShell wires each region into the right track.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import AppShell from '../../../src/components/shell/AppShell.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useThreadStore } from '../../../src/stores/thread'
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

  it('opens the SEARCH overlay from the top-bar search; Cmd+K still opens the palette', async () => {
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

    // ENG-127: the top-bar search opens the message-search overlay (NOT the
    // quick-switcher palette — a distinct message-FTS surface).
    expect(wrapper.find('[data-testid="search-overlay"]').exists()).toBe(false)
    await wrapper.get('[data-testid="topbar-search"]').trigger('click')
    expect(wrapper.find('[data-testid="search-overlay"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="search-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(false)

    // Esc dismisses the overlay.
    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="search-overlay"]').exists()).toBe(false)

    // The Cmd+K quick-switcher palette is UNCHANGED.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(true)
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

  it('renders the REAL InboxView for the Inbox section (not a placeholder)', async () => {
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
    expect(main.text()).not.toContain('coming soon')

    // A real derived activity row is listed for the seeded stream.
    const row = main.get('[data-testid="inbox-item"]')
    expect(row.attributes('data-stream-id')).toBe('s_a')

    // Clicking the row returns to that stream's conversation timeline.
    await row.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-view"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-list"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="channel-header"]').text()).toBe('# alpha')
  })

  it('flips the main panel to an EmptyState for a scaffold section', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)

    await wrapper.get('[data-testid="nav-apps"]').trigger('click')

    // The conversation leaves are gone; the scaffold EmptyState is shown in main.
    expect(wrapper.find('[data-testid="message-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-input"]').exists()).toBe(false)
    const main = wrapper.get('main[role="main"]')
    expect(main.text()).toContain('Apps')
    expect(main.text()).toContain('coming soon')
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

  it('hosts exactly one sync indicator (unique selector for the golden path)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)
    expect(wrapper.findAll('[data-testid="sync-indicator"]')).toHaveLength(1)
  })
})
