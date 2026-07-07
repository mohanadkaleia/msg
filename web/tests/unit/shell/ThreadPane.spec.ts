import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import ThreadPane from '../../../src/components/shell/ThreadPane.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useThreadStore } from '../../../src/stores/thread'
import { FakeWorker } from './fakeWorker'

describe('ThreadPane (ENG-103)', () => {
  let fake: FakeWorker
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    fake = new FakeWorker()
    setWorkerClient(fake.client)
  })

  afterEach(() => {
    setWorkerClient(undefined)
  })

  it('renders the root at top and its replies, and closes on the close button', async () => {
    fake.addStream({ stream_id: 's1' })
    const root = fake.addMessage('s1', { created_seq: 1, text: 'the root message' })
    fake.addReply('s1', root.message_id, { created_seq: 2, text: 'reply A', author_user_id: 'u_a' })
    fake.addReply('s1', root.message_id, { created_seq: 3, text: 'reply B', author_user_id: 'u_b' })

    const store = useThreadStore()
    store.setMyUserId('u_me')
    await store.openThread(root.message_id, 's1')
    await flushPromises()

    const wrapper = mount(ThreadPane, { global: { plugins: [pinia] } })

    expect(wrapper.find('[data-testid="thread-pane"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="thread-root"]').text()).toContain('the root message')
    const replies = wrapper.findAll('[data-testid="thread-reply"]')
    expect(replies.map((r) => r.text())).toEqual(
      expect.arrayContaining([
        expect.stringContaining('reply A'),
        expect.stringContaining('reply B'),
      ]),
    )
    // The compact in-thread composer is present.
    expect(wrapper.find('[data-testid="thread-composer"]').exists()).toBe(true)

    await wrapper.get('[data-testid="thread-close"]').trigger('click')
    expect(store.isOpen).toBe(false)
  })

  it('renders a reply and a participant name with XSS payloads as inert text', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">Mallory'
    fake.setDirectory([{ user_id: 'u_x', display_name: evil }], [])
    fake.addStream({ stream_id: 's1' })
    const root = fake.addMessage('s1', { created_seq: 1, text: 'root' })
    fake.addReply('s1', root.message_id, {
      created_seq: 2,
      text: '<img src=x onerror="window.__pwned=1">reply',
      author_user_id: 'u_x',
    })

    const store = useThreadStore()
    store.setMyUserId('u_me')
    await store.openThread(root.message_id, 's1')
    await flushPromises()

    const wrapper = mount(ThreadPane, { global: { plugins: [pinia] } })

    // No injected element survived — the markup is inert everywhere in the pane.
    // (The payload only ever appears as escaped text / an escaped attribute value.)
    expect(wrapper.find('img').exists()).toBe(false)
    // The reply text survives verbatim as escaped text.
    const replyText = wrapper
      .get('[data-testid="thread-reply"]')
      .get('[data-testid="message-text"]')
    expect(replyText.text()).toBe('<img src=x onerror="window.__pwned=1">reply')
    // The participant name rides the root affordance avatar title as inert text.
    expect(wrapper.get('[data-testid="thread-participant"]').attributes('title')).toBe(evil)
  })
})
