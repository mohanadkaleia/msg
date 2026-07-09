// tests/unit/shell/TopBar.spec.ts — ENG-136 PR-3 + ENG-152 PR-b. The top bar hosts
// a centered search (opens the palette via a `search` event), a REAL compose action
// (new DM), SCAFFOLD bell/more actions, and the EXPLICIT sync-state pill
// (`topbar-sync`) driven by the sync store's tone/label — the local-first signal.
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import TopBar from '../../../src/components/shell/TopBar.vue'
import { useSyncStore } from '../../../src/stores/sync'

describe('TopBar (ENG-136 PR-3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('emits search from the centered search button (topbar-search)', async () => {
    const wrapper = mount(TopBar)
    const search = wrapper.get('[data-testid="topbar-search"]')
    expect(search.text()).toContain('Search anything…')
    expect(search.text()).toContain('⌘K')
    await search.trigger('click')
    expect(wrapper.emitted('search')).toHaveLength(1)
  })

  it('emits compose from the compose action', async () => {
    const wrapper = mount(TopBar)
    const compose = wrapper.get('button[aria-label="New message"]')
    await compose.trigger('click')
    expect(wrapper.emitted('compose')).toHaveLength(1)
  })

  it('shows a scaffold notifications bell with an unread dot', () => {
    const wrapper = mount(TopBar)
    expect(wrapper.find('button[aria-label="Notifications"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="topbar-bell-dot"]').exists()).toBe(true)
    expect(wrapper.find('button[aria-label="More"]').exists()).toBe(true)
  })
})

describe('TopBar sync pill (ENG-152 PR-b)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders "Synced" with a success dot when the store tone is live', async () => {
    const wrapper = mount(TopBar)
    const sync = useSyncStore()
    sync.status = { state: 'live', online: true }
    await wrapper.vm.$nextTick()

    const pill = wrapper.get('[data-testid="topbar-sync"]')
    expect(pill.attributes('data-tone')).toBe('live')
    expect(pill.text()).toBe('Synced')
    expect(pill.find('.bg-success').exists()).toBe(true)
    expect(pill.find('svg').exists()).toBe(false)
  })

  it('renders the syncing label with a spinner while catching up', async () => {
    const wrapper = mount(TopBar)
    const sync = useSyncStore()
    sync.status = { state: 'syncing', online: true }
    await wrapper.vm.$nextTick()

    const pill = wrapper.get('[data-testid="topbar-sync"]')
    expect(pill.attributes('data-tone')).toBe('syncing')
    expect(pill.text()).toBe('Syncing…')
    expect(pill.find('svg.animate-spin').exists()).toBe(true)
  })

  it('renders "Offline" with a danger dot when the connection is gone', async () => {
    const wrapper = mount(TopBar)
    const sync = useSyncStore()
    sync.status = { state: 'degraded', online: false }
    await wrapper.vm.$nextTick()

    const pill = wrapper.get('[data-testid="topbar-sync"]')
    expect(pill.attributes('data-tone')).toBe('offline')
    expect(pill.text()).toBe('Offline')
    expect(pill.find('.bg-danger').exists()).toBe(true)
  })
})
