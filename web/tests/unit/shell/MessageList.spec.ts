import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import MessageList from '../../../src/components/shell/MessageList.vue'
import type { DisplayMessage } from '../../../src/stores/messages'

function msg(i: number, ts: number): DisplayMessage {
  return {
    message_id: `m_${String(i).padStart(24, '0')}`,
    stream_id: 's1',
    created_seq: i,
    author_user_id: 'u_other',
    text: `m${i}`,
    format: 'plain',
    mention_user_ids: [],
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
