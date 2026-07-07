import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useMessagesStore } from '../../../src/stores/messages'
import { FakeWorker } from './fakeWorker'

describe('messages store', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    setWorkerClient(fake.client)
  })

  afterEach(() => {
    setWorkerClient(undefined)
  })

  it('switches channels via a projection read with ZERO network', async () => {
    fake.addStream({ stream_id: 's1' }).addStream({ stream_id: 's2' })
    fake.addMessage('s1', { created_seq: 1, text: 'from-one' })
    fake.addMessage('s2', { created_seq: 1, text: 'from-two' })
    const store = useMessagesStore()

    await store.selectStream('s1')
    expect(store.rows.map((r) => r.text)).toEqual(['from-one'])

    await store.selectStream('s2')

    // The switch is a local projection read — the HTTP escape hatch is untouched.
    expect(fake.fetch).not.toHaveBeenCalled()
    expect(store.rows.map((r) => r.text)).toEqual(['from-two'])
    expect(fake.querySpy).toHaveBeenCalledWith({ q: 'messages.list', stream_id: 's2', limit: 50 })
  })

  it('renders an optimistic send greyed, then settles it in place on ack', async () => {
    fake.addStream({ stream_id: 's1' })
    const store = useMessagesStore()
    store.setMyUserId('u_me')
    await store.selectStream('s1')

    await store.send('hello world')
    await flushPromises()

    const pending = store.displayMessages.find((m) => m.text === 'hello world')
    expect(pending).toBeDefined()
    expect(pending!.state).toBe('pending')
    expect(pending!.mine).toBe(true)

    // Server ack settles the SAME row (no duplicate, state cleared).
    fake.settle(pending!.message_id, 7)
    await flushPromises()

    const settled = store.displayMessages.filter((m) => m.text === 'hello world')
    expect(settled).toHaveLength(1)
    expect(settled[0]!.state).toBeUndefined()
    expect(settled[0]!.created_seq).toBe(7)
  })

  it('carries resolved @mention ids on the SAME outbox.send contract (ENG-101)', async () => {
    fake.addStream({ stream_id: 's1' })
    const store = useMessagesStore()
    store.setMyUserId('u_me')
    await store.selectStream('s1')

    await store.send('hey @Dana', ['u_dana'])
    await flushPromises()

    // Same mutation, unchanged shape — mentions ride the existing optional field.
    expect(fake.sendSpy).toHaveBeenCalledWith({
      m: 'outbox.send',
      stream_id: 's1',
      text: 'hey @Dana',
      mentions: ['u_dana'],
    })
    // The pending projection row carries the mention (badge derivation input).
    const pending = store.displayMessages.find((m) => m.text === 'hey @Dana')!
    expect(pending.mention_user_ids).toEqual(['u_dana'])

    // No mentions → the field is omitted entirely (byte-identical to the M2 send).
    await store.send('plain message')
    expect(fake.sendSpy).toHaveBeenLastCalledWith({
      m: 'outbox.send',
      stream_id: 's1',
      text: 'plain message',
    })
  })

  it('surfaces a failed send with retry/delete wired to the outbox RPCs', async () => {
    fake.addStream({ stream_id: 's1' })
    const store = useMessagesStore()
    store.setMyUserId('u_me')
    await store.selectStream('s1')

    await store.send('will fail')
    await flushPromises()
    const row = store.displayMessages.find((m) => m.text === 'will fail')!

    fake.fail(row.message_id, 'too_long')
    await flushPromises()

    const failed = store.displayMessages.find((m) => m.message_id === row.message_id)!
    expect(failed.state).toBe('failed')
    expect(failed.error_code).toBe('too_long')
    expect(failed.eventId).toBeDefined()

    await store.retry(row.message_id)
    expect(fake.retrySpy).toHaveBeenCalledWith(failed.eventId)

    await store.discard(row.message_id)
    expect(fake.deleteSpy).toHaveBeenCalledWith(failed.eventId)
  })

  // -- ENG-102 optimistic reactions / edit / delete -------------------------

  it('renders an optimistic reaction chip instantly + settles, with ZERO network', async () => {
    fake.addStream({ stream_id: 's1' })
    const msg = fake.addMessage('s1', { created_seq: 1, text: 'hi' })
    const store = useMessagesStore()
    store.setMyUserId('u_me')
    await store.selectStream('s1')
    expect(store.displayMessages[0]!.reactions).toEqual([])

    await store.toggleReaction(msg.message_id, '👍', false)
    await flushPromises()

    // The outbox RPC drove it — never the HTTP escape hatch.
    expect(fake.reactSpy).toHaveBeenCalledWith({
      m: 'outbox.react',
      stream_id: 's1',
      message_id: msg.message_id,
      emoji: '👍',
      remove: false,
    })
    expect(fake.fetch).not.toHaveBeenCalled()

    const chips = store.displayMessages[0]!.reactions!
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({ emoji: '👍', count: 1, mine: true })
  })

  it('toggling an active reaction removes it (idempotent)', async () => {
    fake.addStream({ stream_id: 's1' })
    const msg = fake.addMessage('s1', { created_seq: 1, text: 'hi' })
    fake.addReaction(msg.message_id, 'u_me', '👍')
    const store = useMessagesStore()
    store.setMyUserId('u_me')
    await store.selectStream('s1')
    expect(store.displayMessages[0]!.reactions![0]).toMatchObject({ mine: true, count: 1 })

    await store.toggleReaction(msg.message_id, '👍', true) // remove my active reaction
    await flushPromises()

    expect(fake.reactSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ emoji: '👍', remove: true }),
    )
    expect(store.displayMessages[0]!.reactions).toEqual([])
  })

  it('edits a message optimistically: text updates + an "edited" marker', async () => {
    fake.addStream({ stream_id: 's1' })
    const msg = fake.addMessage('s1', { created_seq: 1, text: 'before', author_user_id: 'u_me' })
    const store = useMessagesStore()
    store.setMyUserId('u_me')
    await store.selectStream('s1')

    await store.editMessage(msg.message_id, 'after')
    await flushPromises()

    expect(fake.editSpy).toHaveBeenCalledWith({
      m: 'outbox.edit',
      stream_id: 's1',
      message_id: msg.message_id,
      text: 'after',
    })
    const edited = store.displayMessages[0]!
    expect(edited.text).toBe('after')
    expect(edited.edited_seq).toBeDefined()
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('deletes a message optimistically → tombstone (content gone)', async () => {
    fake.addStream({ stream_id: 's1' })
    const msg = fake.addMessage('s1', { created_seq: 1, text: 'secret', author_user_id: 'u_me' })
    const store = useMessagesStore()
    store.setMyUserId('u_me')
    await store.selectStream('s1')

    await store.deleteMessage(msg.message_id)
    await flushPromises()

    expect(fake.removeSpy).toHaveBeenCalledWith({
      m: 'outbox.remove',
      stream_id: 's1',
      message_id: msg.message_id,
    })
    const gone = store.displayMessages[0]!
    expect(gone.deleted).toBe(true)
    expect(gone.text).toBe('') // redacted — content is gone
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('lastOwnMessageId points at the newest own, non-deleted message (edit-last target)', async () => {
    fake.addStream({ stream_id: 's1' })
    fake.addMessage('s1', { created_seq: 1, text: 'mine-old', author_user_id: 'u_me' })
    fake.addMessage('s1', { created_seq: 2, text: 'theirs', author_user_id: 'u_other' })
    const mineNew = fake.addMessage('s1', {
      created_seq: 3,
      text: 'mine-new',
      author_user_id: 'u_me',
    })
    const store = useMessagesStore()
    store.setMyUserId('u_me')
    await store.selectStream('s1')

    expect(store.lastOwnMessageId).toBe(mineNew.message_id)
  })

  it('backfills on scroll-top and prepends older messages (server + projection)', async () => {
    fake.addStream({ stream_id: 's1' })
    // 51 in the projection so the head page (50) reports has_more.
    for (let seq = 100; seq <= 150; seq++) {
      fake.addMessage('s1', { created_seq: seq, text: `m${seq}` })
    }
    // A server-only older page the backfill pull reveals below the floor.
    fake.queueBackfill('s1', [{ created_seq: 50, text: 'server50' }])

    const store = useMessagesStore()
    await store.selectStream('s1')
    expect(store.rows).toHaveLength(50)
    expect(store.hasMore).toBe(true)
    expect(store.rows[0]!.text).toBe('m101') // oldest loaded

    const prepended = await store.loadOlder()

    expect(fake.backfillSpy).toHaveBeenCalledWith('s1') // the before= pull fired
    expect(prepended).toBe(2)
    expect(store.rows[0]!.text).toBe('server50') // server-only row now at the top
    expect(store.rows[1]!.text).toBe('m100') // + the projection row below the floor
    expect(store.rows).toHaveLength(52)
  })
})
