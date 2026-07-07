import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useMessagesStore } from '../../../src/stores/messages'
import { useThreadStore } from '../../../src/stores/thread'
import { FakeWorker } from './fakeWorker'

describe('thread store (ENG-103)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    setWorkerClient(fake.client)
  })

  afterEach(() => {
    setWorkerClient(undefined)
  })

  it('opens a thread via a messages.thread projection read with ZERO network', async () => {
    fake.addStream({ stream_id: 's1' })
    const root = fake.addMessage('s1', { created_seq: 1, text: 'root msg' })
    fake.addReply('s1', root.message_id, {
      created_seq: 2,
      text: 'first reply',
      author_user_id: 'u_a',
    })
    fake.addReply('s1', root.message_id, {
      created_seq: 3,
      text: 'second reply',
      author_user_id: 'u_b',
    })

    const store = useThreadStore()
    store.setMyUserId('u_me')
    await store.openThread(root.message_id, 's1')

    // The pane read is the new thread projection query — never the HTTP escape hatch.
    expect(fake.querySpy).toHaveBeenCalledWith({
      q: 'messages.thread',
      root_message_id: root.message_id,
      limit: 50,
    })
    expect(fake.fetch).not.toHaveBeenCalled()

    expect(store.displayRoot?.text).toBe('root msg')
    // Replies ordered oldest→newest.
    expect(store.displayReplies.map((r) => r.text)).toEqual(['first reply', 'second reply'])
  })

  it('reply-count and participants match the projection (thread + main list)', async () => {
    fake.setDirectory(
      [
        { user_id: 'u_a', display_name: 'Ann' },
        { user_id: 'u_b', display_name: 'Bo' },
      ],
      [],
    )
    fake.addStream({ stream_id: 's1' })
    const root = fake.addMessage('s1', { created_seq: 1, text: 'root' })
    fake.addReply('s1', root.message_id, { created_seq: 2, text: 'r1', author_user_id: 'u_b' })
    fake.addReply('s1', root.message_id, { created_seq: 3, text: 'r2', author_user_id: 'u_a' })

    const thread = useThreadStore()
    thread.setMyUserId('u_me')
    await thread.openThread(root.message_id, 's1')

    // Participants are the DISTINCT reply authors, name-resolved + sorted.
    expect(thread.participants).toEqual([
      { user_id: 'u_a', display_name: 'Ann' },
      { user_id: 'u_b', display_name: 'Bo' },
    ])

    // The main list's root row carries the same count + participant avatars.
    const messages = useMessagesStore()
    messages.setMyUserId('u_me')
    await messages.selectStream('s1')
    const rootRow = messages.displayMessages.find((m) => m.message_id === root.message_id)!
    expect(rootRow.reply_count).toBe(2)
    expect(rootRow.threadParticipants!.map((p) => p.display_name)).toEqual(['Ann', 'Bo'])
  })

  it('composes an in-thread reply (thread_root_id set), renders it pending, then settles', async () => {
    fake.addStream({ stream_id: 's1' })
    const root = fake.addMessage('s1', { created_seq: 1, text: 'root' })

    const store = useThreadStore()
    store.setMyUserId('u_me')
    await store.openThread(root.message_id, 's1')

    await store.sendReply('my reply')
    await flushPromises()

    // Same outbox.send contract as a channel message, with thread_root_id set.
    expect(fake.sendSpy).toHaveBeenCalledWith({
      m: 'outbox.send',
      stream_id: 's1',
      text: 'my reply',
      thread_root_id: root.message_id,
    })
    expect(fake.fetch).not.toHaveBeenCalled()

    const pending = store.displayReplies.find((r) => r.text === 'my reply')
    expect(pending).toBeDefined()
    expect(pending!.state).toBe('pending')
    expect(pending!.mine).toBe(true)

    // Server ack settles the SAME row in place (no duplicate).
    fake.settle(pending!.message_id, 42)
    await flushPromises()

    const settled = store.displayReplies.filter((r) => r.text === 'my reply')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.state).toBeUndefined()
    expect(settled[0]!.created_seq).toBe(42)
  })

  it('a live reply over the WS updates the pane AND the root reply-count', async () => {
    fake.setDirectory([{ user_id: 'u_c', display_name: 'Cy' }], [])
    fake.addStream({ stream_id: 's1' })
    const root = fake.addMessage('s1', { created_seq: 1, text: 'root' })

    const thread = useThreadStore()
    thread.setMyUserId('u_me')
    await thread.openThread(root.message_id, 's1')

    const messages = useMessagesStore()
    messages.setMyUserId('u_me')
    await messages.selectStream('s1')
    expect(
      messages.displayMessages.find((m) => m.message_id === root.message_id)!.reply_count ?? 0,
    ).toBe(0)

    // A settled reply arrives from someone else over the stream push.
    fake.addReply('s1', root.message_id, {
      created_seq: 60,
      text: 'live one',
      author_user_id: 'u_c',
    })
    await flushPromises()

    // Pane picks up the new reply…
    expect(thread.displayReplies.some((r) => r.text === 'live one')).toBe(true)
    // …and the main list's root count + participants update reactively.
    const rootRow = messages.displayMessages.find((m) => m.message_id === root.message_id)!
    expect(rootRow.reply_count).toBe(1)
    expect(rootRow.threadParticipants!.map((p) => p.display_name)).toEqual(['Cy'])
  })

  it('close() drops the pane state and its subscription', async () => {
    fake.addStream({ stream_id: 's1' })
    const root = fake.addMessage('s1', { created_seq: 1, text: 'root' })
    const store = useThreadStore()
    store.setMyUserId('u_me')
    await store.openThread(root.message_id, 's1')
    expect(store.isOpen).toBe(true)

    store.close()
    expect(store.isOpen).toBe(false)
    expect(store.displayRoot).toBeNull()
    expect(store.displayReplies).toEqual([])
  })
})
