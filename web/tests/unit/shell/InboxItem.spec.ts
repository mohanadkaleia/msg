// tests/unit/shell/InboxItem.spec.ts — ENG-136 Inbox triage row. A dumb view over
// one InboxEntry: title + preview + meta chip render (text interpolation only),
// the accent unread dot + "N new" count appear only while unread, and the
// timestamp is relative. ENG-152 (feed + preview split): a CLICK emits `select`
// (preview), a DOUBLE-CLICK emits `open` (full jump), and the `selected` prop
// drives the accent-subtle active state.
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

  it('distinguishes unread (semibold primary + accent time) from read (muted) rows', () => {
    // ENG-152 PR-c feed density: the unread/read contrast must be obvious.
    const unread = mountItem(makeEntry({ unread: 3 }))
    expect(unread.get('[data-testid="inbox-item-title"]').classes()).toContain('font-semibold')
    expect(unread.get('[data-testid="inbox-item-title"]').classes()).toContain('text-primary')
    expect(unread.get('[data-testid="inbox-item-preview"]').classes()).toContain('text-secondary')
    expect(unread.get('[data-testid="inbox-item-time"]').classes()).toContain('text-accent')

    const read = mountItem(makeEntry({ unread: 0 }))
    expect(read.get('[data-testid="inbox-item-title"]').classes()).toContain('text-secondary')
    expect(read.get('[data-testid="inbox-item-title"]').classes()).not.toContain('font-semibold')
    expect(read.get('[data-testid="inbox-item-preview"]').classes()).toContain('text-muted')
    expect(read.get('[data-testid="inbox-item-time"]').classes()).toContain('text-muted')
  })

  it('shows a "Mentioned you" accent chip only when the REAL mention flag is set', () => {
    const plain = mountItem(makeEntry({ mention: false }))
    expect(plain.find('[data-testid="inbox-mention-chip"]').exists()).toBe(false)

    const mentioned = mountItem(makeEntry({ mention: true, unread: 1 }))
    const chip = mentioned.get('[data-testid="inbox-mention-chip"]')
    expect(chip.text()).toBe('Mentioned you')
    expect(chip.classes()).toContain('text-accent')
  })

  it('emits select on click (preview) and open on double-click (full jump)', async () => {
    const wrapper = mountItem(makeEntry())
    await wrapper.get('[data-testid="inbox-item"]').trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
    expect(wrapper.emitted('open')).toBeUndefined()

    await wrapper.get('[data-testid="inbox-item"]').trigger('dblclick')
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('marks the selected row with the accent-subtle active state', () => {
    const idle = mountItem(makeEntry())
    expect(idle.get('[data-testid="inbox-item"]').attributes('data-selected')).toBe('false')
    expect(idle.get('[data-testid="inbox-item"]').classes()).not.toContain('bg-accent-subtle')

    const selected = mount(InboxItem, { props: { entry: makeEntry(), selected: true } })
    const row = selected.get('[data-testid="inbox-item"]')
    expect(row.attributes('data-selected')).toBe('true')
    expect(row.classes()).toContain('bg-accent-subtle')
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
