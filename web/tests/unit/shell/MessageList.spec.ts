import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import MessageList from '../../../src/components/shell/MessageList.vue'
import type { DisplayMessage } from '../../../src/stores/messages'

function msg(i: number, ts: number, author = 'u_other'): DisplayMessage {
  return {
    message_id: `m_${String(i).padStart(24, '0')}`,
    stream_id: 's1',
    created_seq: i,
    author_user_id: author,
    text: `m${i}`,
    format: 'plain',
    mention_user_ids: [],
    file_ids: [],
    ts,
    mine: false,
  }
}

describe('MessageList virtualization', () => {
  it('renders only the windowed subset for a large message set', () => {
    const day = new Date('2026-07-06T10:00:00').getTime()
    const messages = Array.from({ length: 1000 }, (_, i) => msg(i, day))

    const wrapper = mount(MessageList, {
      props: { messages, viewportHeight: 400, rowHeight: 40, overscan: 6, streamKey: 's1' },
    })

    const rendered = wrapper.findAll('[data-testid="message-row"]')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(40) // a tiny window, not all 1000
  })

  it('shifts the window on scroll (renders later messages, not the first)', async () => {
    const day = new Date('2026-07-06T10:00:00').getTime()
    const messages = Array.from({ length: 1000 }, (_, i) => msg(i, day))
    const wrapper = mount(MessageList, {
      props: { messages, viewportHeight: 400, rowHeight: 40, overscan: 6, streamKey: 's1' },
    })

    const el = wrapper.get('[data-testid="message-list"]').element as HTMLElement
    el.scrollTop = 20000 // ~row 500
    await wrapper.get('[data-testid="message-list"]').trigger('scroll')

    const texts = wrapper.findAll('[data-testid="message-text"]').map((n) => n.text())
    const firstIndex = Number(texts[0]!.slice(1))
    expect(firstIndex).toBeGreaterThan(400)
  })

  it('inserts a day divider at each calendar-day boundary', () => {
    const d1 = new Date('2026-07-01T10:00:00').getTime()
    const d1b = new Date('2026-07-01T18:00:00').getTime()
    const d2 = new Date('2026-07-02T09:00:00').getTime()
    const messages = [msg(1, d1), msg(2, d1b), msg(3, d2)]

    const wrapper = mount(MessageList, {
      props: { messages, viewportHeight: 2000, rowHeight: 64, streamKey: 's1' },
    })

    expect(wrapper.findAll('[data-testid="day-divider"]')).toHaveLength(2)
  })

  // -- ENG-136 grouping + display names + "New" divider ---------------------

  it('groups consecutive same-author messages within ~5 min (only the first shows a header)', () => {
    const t = new Date('2026-07-06T10:00:00').getTime()
    const messages = [
      msg(1, t, 'u_a'),
      msg(2, t + 60_000, 'u_a'), // grouped (same author, +1 min)
      msg(3, t + 120_000, 'u_b'), // new author → header
      msg(4, t + 10 * 60_000, 'u_b'), // same author but >5 min → header
    ]
    const wrapper = mount(MessageList, {
      props: { messages, viewportHeight: 2000, rowHeight: 64, streamKey: 's1' },
    })
    // One avatar per LEADING row of a group: rows 1, 3, 4 → 3 avatars (row 2 grouped).
    expect(wrapper.findAll('[data-testid="message-avatar"]')).toHaveLength(3)
    expect(wrapper.findAll('[data-testid="message-row"]')).toHaveLength(4)
    // EVERY row keeps the 40px avatar gutter — a grouped follow-up's text stays
    // indented under the first message's text, never flush-left.
    const gutters = wrapper.findAll('[data-testid="message-gutter"]')
    expect(gutters).toHaveLength(4)
    for (const gutter of gutters) expect(gutter.classes()).toContain('w-10')
  })

  it('threads the display-name map down to each row', () => {
    const t = new Date('2026-07-06T10:00:00').getTime()
    const names = new Map([['u_a', 'Alice']])
    const wrapper = mount(MessageList, {
      props: { messages: [msg(1, t, 'u_a')], viewportHeight: 2000, streamKey: 's1', names },
    })
    expect(wrapper.get('[data-testid="message-author"]').text()).toBe('Alice')
  })

  it('renders a "New" divider before the last unreadCount messages', () => {
    const t = new Date('2026-07-06T10:00:00').getTime()
    const messages = Array.from({ length: 5 }, (_, i) => msg(i, t + i * 60_000))
    const wrapper = mount(MessageList, {
      props: { messages, viewportHeight: 2000, rowHeight: 64, streamKey: 's1', unreadCount: 2 },
    })
    expect(wrapper.findAll('[data-testid="new-divider"]')).toHaveLength(1)
  })

  it('omits the "New" divider when there are no unreads', () => {
    const t = new Date('2026-07-06T10:00:00').getTime()
    const messages = Array.from({ length: 5 }, (_, i) => msg(i, t + i * 60_000))
    const wrapper = mount(MessageList, {
      props: { messages, viewportHeight: 2000, rowHeight: 64, streamKey: 's1', unreadCount: 0 },
    })
    expect(wrapper.find('[data-testid="new-divider"]').exists()).toBe(false)
  })

  // -- ENG-127 search jump-to-message ---------------------------------------

  it('scrollToMessage jumps the window to a far row and briefly highlights it', async () => {
    const day = new Date('2026-07-06T10:00:00').getTime()
    const messages = Array.from({ length: 1000 }, (_, i) => msg(i, day))
    const wrapper = mount(MessageList, {
      props: { messages, viewportHeight: 400, rowHeight: 40, overscan: 6, streamKey: 's1' },
    })
    const target = messages[500]!.message_id
    const vm = wrapper.vm as unknown as { scrollToMessage: (id: string) => boolean }

    expect(vm.scrollToMessage(target)).toBe(true)
    await nextTick()

    // The virtualized window re-centered on the row (it is actually rendered) …
    const row = wrapper.find(`[data-message-id="${target}"]`)
    expect(row.exists()).toBe(true)
    // … and it carries the brief jump highlight.
    expect(row.classes()).toContain('bg-accent-subtle')
  })

  it('scrollToMessage returns false for a message outside the loaded window', () => {
    const day = new Date('2026-07-06T10:00:00').getTime()
    const messages = Array.from({ length: 5 }, (_, i) => msg(i, day))
    const wrapper = mount(MessageList, {
      props: { messages, viewportHeight: 400, rowHeight: 40, streamKey: 's1' },
    })
    const vm = wrapper.vm as unknown as { scrollToMessage: (id: string) => boolean }
    expect(vm.scrollToMessage('m_not_loaded')).toBe(false)
  })

  it('calls loadOlder when the user scrolls to the top and more remain', async () => {
    const day = new Date('2026-07-06T10:00:00').getTime()
    const messages = Array.from({ length: 5 }, (_, i) => msg(i, day))
    const loadOlder = vi.fn().mockResolvedValue(0)

    const wrapper = mount(MessageList, {
      props: {
        messages,
        viewportHeight: 400,
        rowHeight: 40,
        hasMore: true,
        streamKey: 's1',
        loadOlder,
      },
    })
    await nextTick()

    const el = wrapper.get('[data-testid="message-list"]').element as HTMLElement
    el.scrollTop = 0
    await wrapper.get('[data-testid="message-list"]').trigger('scroll')

    expect(loadOlder).toHaveBeenCalledTimes(1)
  })
})
