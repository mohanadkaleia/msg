import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import MessageItem from '../../../src/components/shell/MessageItem.vue'
import type { DisplayMessage } from '../../../src/stores/messages'

function makeMessage(over: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    message_id: 'm_00000000000000000000000000',
    stream_id: 's1',
    created_seq: 1,
    author_user_id: 'u_other',
    text: 'hello',
    format: 'plain',
    mention_user_ids: [],
    ts: Date.now(),
    mine: false,
    ...over,
  }
}

describe('MessageItem', () => {
  it('renders other users’ text as escaped plain text, never as DOM (XSS)', () => {
    const payload = '<img src=x onerror="window.__pwned=1"> </script><b>bold</b>'
    const wrapper = mount(MessageItem, { props: { message: makeMessage({ text: payload }) } })

    // The dangerous markup is inert: no injected elements exist.
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    // ...it survives verbatim as text (Vue interpolation escaped it).
    expect(wrapper.find('[data-testid="message-text"]').text()).toBe(payload)
    expect(wrapper.html()).not.toContain('<img')
  })

  it('renders a pending row greyed with a "Sending…" clock', () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage({ state: 'pending' }) } })
    expect(wrapper.get('[data-testid="message-row"]').classes()).toContain('opacity-50')
    expect(wrapper.get('[data-testid="message-time"]').text()).toContain('Sending')
  })

  it('shows retry/delete on a failed row and emits with the message id', async () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ state: 'failed', error_code: 'too_long', eventId: 'e1' }) },
    })

    expect(wrapper.find('[data-testid="message-failed"]').text()).toContain('too_long')
    await wrapper.get('[data-testid="message-retry"]').trigger('click')
    await wrapper.get('[data-testid="message-delete"]').trigger('click')

    expect(wrapper.emitted('retry')?.[0]).toEqual(['m_00000000000000000000000000'])
    expect(wrapper.emitted('discard')?.[0]).toEqual(['m_00000000000000000000000000'])
  })

  it('hides retry/delete when there is no outbox id to act on', () => {
    const wrapper = mount(MessageItem, { props: { message: makeMessage({ state: 'failed' }) } })
    expect(wrapper.find('[data-testid="message-retry"]').exists()).toBe(false)
  })
})
