// tests/unit/shell/TopBar.spec.ts — ENG-136 PR-3 + ENG-152 PR-b + nav cleanup.
// The top bar hosts a centered search (opens the ONE unified search modal via a
// `search` event, hinted ⌘/ — ⌘K belongs to the command palette), a SCAFFOLD
// `more` menu, and the EXPLICIT sync-state pill (`topbar-sync`) driven by the
// sync store's tone/label — the local-first signal. The compose button and the
// notifications bell were REMOVED (user feedback): "+ New" owns creation and
// the Inbox nav badge owns new-message indication.
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import TopBar from '../../../src/components/shell/TopBar.vue'
import { useSyncStore } from '../../../src/stores/sync'

describe('TopBar (ENG-136 PR-3 / ENG-152 nav cleanup)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('emits search from the centered search button (topbar-search), hinted ⌘/', async () => {
    const wrapper = mount(TopBar)
    const search = wrapper.get('[data-testid="topbar-search"]')
    expect(search.text()).toContain('Search anything…')
    // ⌘/ is search's shortcut; the ⌘K chip must NOT come back (⌘K = palette).
    expect(search.text()).toContain('⌘/')
    expect(search.text()).not.toContain('⌘K')
    await search.trigger('click')
    expect(wrapper.emitted('search')).toHaveLength(1)
  })

  it('has NO compose button and NO notifications bell (ENG-152 nav cleanup)', () => {
    const wrapper = mount(TopBar)
    expect(wrapper.find('button[aria-label="New message"]').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Notifications"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="topbar-bell-dot"]').exists()).toBe(false)
    // The scaffold `more` menu stays.
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
