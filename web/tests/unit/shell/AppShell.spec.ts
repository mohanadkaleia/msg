// tests/unit/shell/AppShell.spec.ts — ENG-136 "Ranin" PR-C. AppShell is the promotion
// of the old `views/ShellView.vue` assembly into a CSS-grid layout component; behavior
// and every test-id are identical (only the wrapping element changed). This proves the
// grid COMPOSITION: the rail/sidebar/main/drawer landmarks render, a real conversation
// mounts channel-header + MessageList + MessageComposer, a scaffold section flips main to
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

  it('lays out the rail / sidebar / main landmarks on a CSS grid', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)

    // Root is a CSS grid application region.
    const root = wrapper.get('[role="application"]')
    expect(root.classes()).toContain('grid')

    // Rail — Workspaces navigation landmark.
    const rail = wrapper.get('nav[aria-label="Workspaces"]')
    expect(rail.attributes('role')).toBe('navigation')

    // Sidebar — the (now labeled) navigation landmark.
    const sidebar = wrapper.get('aside[role="navigation"]')
    expect(sidebar.attributes('aria-label')).toBe('Channels and direct messages')

    // Main region.
    expect(wrapper.find('main[role="main"]').exists()).toBe(true)

    // Drawer is absent until a thread opens.
    expect(wrapper.find('[role="complementary"][aria-label="Thread"]').exists()).toBe(false)
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

  it('flips the main panel to an EmptyState for a scaffold section', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)

    await wrapper.get('[data-testid="nav-feeds"]').trigger('click')

    // The conversation leaves are gone; the scaffold EmptyState is shown in main.
    expect(wrapper.find('[data-testid="message-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="composer-input"]').exists()).toBe(false)
    const main = wrapper.get('main[role="main"]')
    expect(main.text()).toContain('Feeds')
    expect(main.text()).toContain('coming soon')
  })

  it('opens the thread drawer when a thread is open and unmounts it synchronously on close', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const root = fake.addMessage('s_a', { created_seq: 1, text: 'root' })
    const wrapper = await mountShell(fake, router)

    const thread = useThreadStore()
    await thread.openThread(root.message_id, 's_a')
    await flushPromises()

    // Drawer appears as its own grid track (4-column template) hosting the thread pane.
    const drawer = wrapper.get('[role="complementary"][aria-label="Thread"]')
    expect(drawer.find('[data-testid="thread-pane"]').exists()).toBe(true)
    expect(wrapper.get('[role="application"]').classes()).toContain(
      'grid-cols-[3.5rem_16rem_1fr_24rem]',
    )

    // Closing removes the pane immediately (no leave transition), as before.
    thread.close()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="complementary"][aria-label="Thread"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="thread-pane"]').exists()).toBe(false)
  })

  it('hosts exactly one sync indicator (unique selector for the golden path)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    const wrapper = await mountShell(fake, router)
    expect(wrapper.findAll('[data-testid="sync-indicator"]')).toHaveLength(1)
  })
})
