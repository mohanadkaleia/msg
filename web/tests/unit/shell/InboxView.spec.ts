// tests/unit/shell/InboxView.spec.ts — ENG-136 Inbox triage page; ENG-152 makes it
// a TWO-PANE surface (feed list + preview). Proves the view over REAL derived data
// (FakeWorker projection, zero network): the header + the five filter tabs render
// (with counts on All/Unread/Mentions), the active tab gets the accent underline
// and filters the day-grouped list, refresh re-reads previews, and a fresh
// workspace shows the EmptyState instead of fabricated rows. ENG-152: a row CLICK
// selects it for the PREVIEW pane (recent messages + a quick-reply composer bound
// to that stream — via a preview-scoped messages.list, not the messages store);
// the preview's "Open" button (or a row double-click) emits `open-stream`.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import InboxView from '../../../src/components/shell/InboxView.vue'
import MessageComposer from '../../../src/components/shell/MessageComposer.vue'
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

  it('shows the preview empty state while nothing is selected (ENG-152)', async () => {
    seedActivity(fake)
    const wrapper = await mountView(fake)

    const pane = wrapper.get('[data-testid="inbox-preview"]')
    expect(pane.find('[data-testid="inbox-preview-empty"]').exists()).toBe(true)
    expect(pane.text()).toContain('Select an item to preview')
    expect(pane.find('[data-testid="inbox-preview-open"]').exists()).toBe(false)
  })

  it('clicking a row SELECTS it for preview — no navigation (ENG-152)', async () => {
    seedActivity(fake)
    const wrapper = await mountView(fake)

    await wrapper.get('[data-testid="inbox-item"][data-stream-id="s_dm"]').trigger('click')
    await flushPromises()

    // Selected, highlighted, previewed — but NOT navigated.
    expect(wrapper.emitted('open-stream')).toBeUndefined()
    const row = wrapper.get('[data-testid="inbox-item"][data-stream-id="s_dm"]')
    expect(row.attributes('data-selected')).toBe('true')
    const pane = wrapper.get('[data-testid="inbox-preview"]')
    expect(pane.find('[data-testid="inbox-preview-empty"]').exists()).toBe(false)
    expect(pane.find('[data-testid="inbox-preview-open"]').exists()).toBe(true)
  })

  it('the preview "Open" button (or a row double-click) emits open-stream', async () => {
    seedActivity(fake)
    const wrapper = await mountView(fake)

    await wrapper.get('[data-testid="inbox-item"][data-stream-id="s_dm"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="inbox-preview-open"]').trigger('click')
    expect(wrapper.emitted('open-stream')).toEqual([['s_dm']])

    await wrapper.get('[data-testid="inbox-item"][data-stream-id="s_eng"]').trigger('dblclick')
    expect(wrapper.emitted('open-stream')).toEqual([['s_dm'], ['s_eng']])
  })

  it('preview loads the SELECTED stream recent messages via a scoped messages.list', async () => {
    seedActivity(fake)
    fake.addMessage('s_eng', { created_seq: 3, author_user_id: 'u_bob', text: 'and tests too' })
    const wrapper = await mountView(fake)
    fake.querySpy.mockClear()

    await wrapper.get('[data-testid="inbox-item"][data-stream-id="s_eng"]').trigger('click')
    await flushPromises()

    // A preview-scoped recent page for the SELECTED stream (limit 30 — not the
    // feed's limit-1 preview read, not the messages store's window).
    expect(fake.querySpy).toHaveBeenCalledWith({
      q: 'messages.list',
      stream_id: 's_eng',
      limit: 30,
    })
    const pane = wrapper.get('[data-testid="inbox-preview"]')
    const rows = pane.findAll('[data-testid="inbox-preview-message"]')
    expect(rows).toHaveLength(2)
    expect(pane.text()).toContain('ship it')
    expect(pane.text()).toContain('and tests too')
    expect(pane.text()).toContain('# engineering')

    // Still a projection surface — never HTTP.
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('quick-reply sends to the selected stream and stays in Inbox (ENG-152)', async () => {
    seedActivity(fake)
    const wrapper = await mountView(fake)

    await wrapper.get('[data-testid="inbox-item"][data-stream-id="s_eng"]').trigger('click')
    await flushPromises()

    // The ONLY composer mounted is the preview's, bound to the selected stream.
    const composer = wrapper.findComponent(MessageComposer)
    expect(composer.props('streamId')).toBe('s_eng')
    composer.vm.$emit('send', 'on it', [], [])
    await flushPromises()

    expect(fake.sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ m: 'outbox.send', stream_id: 's_eng', text: 'on it' }),
    )
    // Sending is a quick reply: no navigation, and the (pending) echo lands in
    // the preview via its stream subscription.
    expect(wrapper.emitted('open-stream')).toBeUndefined()
    expect(wrapper.get('[data-testid="inbox-preview"]').text()).toContain('on it')
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
