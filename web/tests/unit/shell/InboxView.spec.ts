// tests/unit/shell/InboxView.spec.ts — ENG-136 Inbox triage page. Proves the view
// over REAL derived data (FakeWorker projection, zero network): the header + the
// five filter tabs render (with counts on All/Unread/Mentions), the active tab
// gets the accent underline and filters the day-grouped list, a row click emits
// `open-stream`, refresh re-reads previews, and a fresh workspace shows the
// EmptyState instead of fabricated rows.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import InboxView from '../../../src/components/shell/InboxView.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'

async function mountView(fake: FakeWorker): Promise<ReturnType<typeof mount>> {
  setWorkerClient(fake.client)
  await useWorkspaceStore().load()
  const wrapper = mount(InboxView)
  await flushPromises()
  return wrapper
}

/** Seed a channel + a DM, one with unread+mention, each with a latest message. */
function seedActivity(fake: FakeWorker): void {
  fake.addStream({ stream_id: 's_eng', name: 'engineering', kind: 'channel', unread: 2 })
  fake.addStream({ stream_id: 's_dm', name: 'Alice', kind: 'dm', unread: 1, mention: true })
  fake.setDirectory([{ user_id: 'u_bob', display_name: 'Bob' }], [])
  fake.addMessage('s_eng', { created_seq: 1, author_user_id: 'u_bob', text: 'ship it' })
  fake.addMessage('s_dm', { created_seq: 2, author_user_id: 'u_bob', text: 'lunch?' })
}

describe('InboxView (ENG-136)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
  })

  afterEach(() => {
    setWorkerClient(undefined)
  })

  it('renders the header, all five tabs (with counts), and the grouped list', async () => {
    seedActivity(fake)
    const wrapper = await mountView(fake)

    expect(wrapper.get('h1').text()).toBe('Inbox')
    for (const key of ['all', 'unread', 'mentions', 'dms', 'channels']) {
      expect(wrapper.find(`[data-testid="inbox-tab-${key}"]`).exists()).toBe(true)
    }
    // Counts where meaningful: All=2 entries, Unread=2, Mentions=1.
    expect(wrapper.get('[data-testid="inbox-tab-all"]').text()).toContain('2')
    expect(wrapper.get('[data-testid="inbox-tab-unread"]').text()).toContain('2')
    expect(wrapper.get('[data-testid="inbox-tab-mentions"]').text()).toContain('1')

    // Both seeded messages are fresh → one "Today" group with both rows.
    expect(wrapper.findAll('[data-testid="inbox-group"]').map((g) => g.text())).toEqual(['Today'])
    expect(wrapper.findAll('[data-testid="inbox-item"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('# engineering')
    expect(wrapper.text()).toContain('Bob: ship it')

    // Projection reads only — never HTTP.
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('marks the active tab with the accent underline', async () => {
    seedActivity(fake)
    const wrapper = await mountView(fake)

    const all = wrapper.get('[data-testid="inbox-tab-all"]')
    expect(all.attributes('aria-selected')).toBe('true')
    expect(all.classes()).toContain('border-accent')

    await wrapper.get('[data-testid="inbox-tab-dms"]').trigger('click')
    expect(wrapper.get('[data-testid="inbox-tab-dms"]').classes()).toContain('border-accent')
    expect(wrapper.get('[data-testid="inbox-tab-all"]').attributes('aria-selected')).toBe('false')
  })

  it('filters the list by tab (Mentions / DMs / Channels select the right subset)', async () => {
    seedActivity(fake)
    const wrapper = await mountView(fake)

    const rowIds = () =>
      wrapper.findAll('[data-testid="inbox-item"]').map((r) => r.attributes('data-stream-id'))

    await wrapper.get('[data-testid="inbox-tab-mentions"]').trigger('click')
    expect(rowIds()).toEqual(['s_dm'])

    await wrapper.get('[data-testid="inbox-tab-channels"]').trigger('click')
    expect(rowIds()).toEqual(['s_eng'])

    await wrapper.get('[data-testid="inbox-tab-dms"]').trigger('click')
    expect(rowIds()).toEqual(['s_dm'])

    await wrapper.get('[data-testid="inbox-tab-all"]').trigger('click')
    expect(rowIds()).toHaveLength(2)
  })

  it('shows the unread dot on unread rows only', async () => {
    seedActivity(fake)
    fake.setBadge('s_eng', { unread: 0 })
    await flushPromises()
    const wrapper = await mountView(fake)

    const rows = wrapper.findAll('[data-testid="inbox-item"]')
    const dm = rows.find((r) => r.attributes('data-stream-id') === 's_dm')!
    const eng = rows.find((r) => r.attributes('data-stream-id') === 's_eng')!
    expect(dm.find('[data-testid="inbox-unread-dot"]').exists()).toBe(true)
    expect(eng.find('[data-testid="inbox-unread-dot"]').exists()).toBe(false)
  })

  it('emits open-stream with the clicked row stream id', async () => {
    seedActivity(fake)
    const wrapper = await mountView(fake)

    await wrapper.get('[data-testid="inbox-item"][data-stream-id="s_dm"]').trigger('click')
    expect(wrapper.emitted('open-stream')).toEqual([['s_dm']])
  })

  it('shows a friendly EmptyState for a workspace with no activity', async () => {
    const wrapper = await mountView(fake)
    expect(wrapper.findAll('[data-testid="inbox-item"]')).toHaveLength(0)
    expect(wrapper.text()).toContain("You're all caught up")
  })

  it('shows a filter-specific empty message when a tab has no matches', async () => {
    fake.addStream({ stream_id: 's_eng', name: 'engineering', kind: 'channel' })
    fake.addMessage('s_eng', { created_seq: 1, text: 'hello' })
    const wrapper = await mountView(fake)

    await wrapper.get('[data-testid="inbox-tab-dms"]').trigger('click')
    expect(wrapper.findAll('[data-testid="inbox-item"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('No conversations match this filter')
  })

  it('re-reads previews on refresh', async () => {
    fake.addStream({ stream_id: 's_eng', name: 'engineering', kind: 'channel' })
    fake.addMessage('s_eng', { created_seq: 1, text: 'first' })
    const wrapper = await mountView(fake)
    expect(wrapper.text()).toContain('first')

    // A new latest message lands WITHOUT a publish; the manual refresh picks it up.
    fake.addMessage('s_eng', { created_seq: 2, text: 'second' })
    await wrapper.get('[data-testid="inbox-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('second')
  })
})
