// tests/unit/shell/InboxItem.spec.ts — ENG-136 Inbox triage row. A dumb view over
// one InboxEntry: title + preview + meta chip render (text interpolation only),
// the accent unread dot + "N new" count appear only while unread, the timestamp
// is relative, and a click emits `open`.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import InboxItem from '../../../src/components/shell/InboxItem.vue'
import type { InboxEntry } from '../../../src/composables/useInbox'

const DAY = 24 * 60 * 60 * 1000

function makeEntry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    stream_id: 's_eng',
    kind: 'channel',
    title: '# engineering',
    preview: 'Bob: ship it',
    lastActivityTs: Date.now(),
    unread: 0,
    mention: false,
    ...overrides,
  }
}

function mountItem(entry: InboxEntry): ReturnType<typeof mount> {
  return mount(InboxItem, { props: { entry } })
}

describe('InboxItem (ENG-136)', () => {
  it('renders the title, preview, and channel chip', () => {
    const wrapper = mountItem(makeEntry())
    const row = wrapper.get('[data-testid="inbox-item"]')
    expect(row.attributes('data-stream-id')).toBe('s_eng')
    expect(row.text()).toContain('# engineering')
    expect(row.text()).toContain('Bob: ship it')
  })

  it('shows a DM chip and an initial avatar for a DM entry', () => {
    const wrapper = mountItem(makeEntry({ kind: 'dm', title: 'alice' }))
    expect(wrapper.text()).toContain('DM')
    expect(wrapper.text()).toContain('A') // uppercased initial avatar
  })

  it('shows the accent unread dot + "N new" count only while unread', () => {
    const read = mountItem(makeEntry({ unread: 0 }))
    expect(read.find('[data-testid="inbox-unread-dot"]').exists()).toBe(false)
    expect(read.find('[data-testid="inbox-new-count"]').exists()).toBe(false)

    const unread = mountItem(makeEntry({ unread: 4 }))
    const dot = unread.get('[data-testid="inbox-unread-dot"]')
    expect(dot.classes()).toContain('bg-accent')
    expect(unread.get('[data-testid="inbox-new-count"]').text()).toBe('4 new')
    expect(unread.get('[data-testid="inbox-item"]').attributes('data-unread')).toBe('4')
  })

  it('renders a relative timestamp ("Yesterday" for the previous day)', () => {
    const wrapper = mountItem(makeEntry({ lastActivityTs: Date.now() - DAY }))
    expect(wrapper.text()).toContain('Yesterday')
  })

  it('emits open on click', async () => {
    const wrapper = mountItem(makeEntry())
    await wrapper.get('[data-testid="inbox-item"]').trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('renders hostile title/preview as inert text (never HTML)', () => {
    const wrapper = mountItem(
      makeEntry({ title: '<img src=x onerror=alert(1)>', preview: '<b>bold</b>' }),
    )
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
  })
})
