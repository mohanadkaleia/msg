// tests/unit/shell/useInbox.spec.ts — ENG-136 Inbox triage assembly. Proves the
// composable derives REAL entries from the workspace store's streams+badges and
// each stream's latest locally-projected message (a `messages.list` limit-1 read
// through the FakeWorker — ZERO network, fetch spy untouched): assembly + author
// resolution + omission of message-less streams, tab filtering + counts, day
// grouping (Today/Yesterday/Earlier), and a live refresh when a stream publishes.
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useInbox, type UseInbox } from '../../../src/composables/useInbox'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { useAuthStore } from '../../../src/stores/auth'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from './fakeWorker'

/** Crockford alphabet (mirrors core/ids.ts) for minting ids at a chosen time. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A message id whose ULID timestamp decodes to `ms` (suffix keeps ids unique). */
function messageIdAt(ms: number, suffix: string): string {
  let ts = ''
  let rem = ms
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[rem % 32]! + ts
    rem = Math.floor(rem / 32)
  }
  return `m_${ts}${suffix.padEnd(16, '0').slice(0, 16).toUpperCase()}`
}

const DAY = 24 * 60 * 60 * 1000

/** Mount a harness exposing the live composable, after loading the workspace. */
async function mountInbox(fake: FakeWorker): Promise<UseInbox> {
  setWorkerClient(fake.client)
  await useWorkspaceStore().load()
  const Harness = defineComponent({
    setup() {
      const inbox = useInbox()
      return { inbox }
    },
    template: '<div />',
  })
  const wrapper = mount(Harness)
  await flushPromises()
  return (wrapper.vm as unknown as { inbox: UseInbox }).inbox
}

describe('useInbox (ENG-136 Inbox triage)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
  })

  afterEach(() => {
    setWorkerClient(undefined)
  })

  it('assembles one entry per active stream, newest first, omitting message-less streams', async () => {
    const now = Date.now()
    fake.addStream({ stream_id: 's_eng', name: 'engineering', kind: 'channel', unread: 2 })
    fake.addStream({ stream_id: 's_dm', name: 'Alice', kind: 'dm' })
    fake.addStream({ stream_id: 's_quiet', name: 'quiet', kind: 'channel' })
    fake.setDirectory([{ user_id: 'u_bob', display_name: 'Bob' }], [])
    fake.addMessage('s_eng', {
      message_id: messageIdAt(now - 60_000, 'ENG'),
      created_seq: 5,
      author_user_id: 'u_bob',
      text: 'ship it',
    })
    fake.addMessage('s_dm', {
      message_id: messageIdAt(now - 10_000, 'DM1'),
      created_seq: 3,
      author_user_id: 'u_bob',
      text: 'hi there',
    })

    const inbox = await mountInbox(fake)

    // `s_quiet` has no local messages — omitted, never fabricated.
    expect(inbox.entries.value.map((e) => e.stream_id)).toEqual(['s_dm', 's_eng'])

    const [dm, chan] = inbox.entries.value
    expect(dm).toMatchObject({ kind: 'dm', title: 'Alice', preview: 'Bob: hi there', unread: 0 })
    expect(chan).toMatchObject({
      kind: 'channel',
      title: '# engineering',
      preview: 'Bob: ship it',
      unread: 2,
    })

    // The whole assembly is projection reads — never HTTP.
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('titles a DM entry with the OTHER participant’s display name (ENG-149)', async () => {
    fake.addStream({ stream_id: 's_dm', kind: 'dm', dm_user_ids: ['u_me', 'u_dana'] })
    fake.setDirectory([{ user_id: 'u_dana', display_name: 'Dana' }], [])
    fake.addMessage('s_dm', { created_seq: 1, author_user_id: 'u_dana', text: 'hey' })
    useAuthStore().myUserId = 'u_me'

    const inbox = await mountInbox(fake)
    expect(inbox.entries.value[0]).toMatchObject({
      kind: 'dm',
      title: 'Dana',
      preview: 'Dana: hey',
    })
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('falls back to the raw author id when the directory has no name', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.addMessage('s_a', { created_seq: 1, author_user_id: 'u_ghost', text: 'boo' })

    const inbox = await mountInbox(fake)
    expect(inbox.entries.value[0]?.preview).toBe('u_ghost: boo')
  })

  it('filters by tab and reports counts (All / Unread / Mentions / DMs / Channels)', async () => {
    fake.addStream({ stream_id: 's_c1', name: 'c-unread', kind: 'channel', unread: 3 })
    fake.addStream({ stream_id: 's_c2', name: 'c-read', kind: 'channel' })
    fake.addStream({ stream_id: 's_d1', name: 'd-mention', kind: 'dm', unread: 1, mention: true })
    fake.addStream({ stream_id: 's_d2', name: 'd-read', kind: 'dm' })
    for (const [i, id] of ['s_c1', 's_c2', 's_d1', 's_d2'].entries()) {
      fake.addMessage(id, { created_seq: i + 1, text: `m${i}` })
    }

    const inbox = await mountInbox(fake)

    expect(inbox.counts.value).toEqual({ all: 4, unread: 2, mentions: 1, dms: 2, channels: 2 })

    const ids = () => inbox.filtered.value.map((e) => e.stream_id).sort()
    expect(inbox.activeTab.value).toBe('all')
    expect(ids()).toEqual(['s_c1', 's_c2', 's_d1', 's_d2'])
    inbox.activeTab.value = 'unread'
    expect(ids()).toEqual(['s_c1', 's_d1'])
    inbox.activeTab.value = 'mentions'
    expect(ids()).toEqual(['s_d1'])
    inbox.activeTab.value = 'dms'
    expect(ids()).toEqual(['s_d1', 's_d2'])
    inbox.activeTab.value = 'channels'
    expect(ids()).toEqual(['s_c1', 's_c2'])
  })

  it('groups entries by day: Today, Yesterday, Earlier (empty buckets dropped)', async () => {
    const now = Date.now()
    fake.addStream({ stream_id: 's_t', name: 'today', kind: 'channel' })
    fake.addStream({ stream_id: 's_y', name: 'yesterday', kind: 'channel' })
    fake.addStream({ stream_id: 's_o', name: 'older', kind: 'channel' })
    fake.addMessage('s_t', { message_id: messageIdAt(now, 'T'), created_seq: 3, text: 't' })
    fake.addMessage('s_y', { message_id: messageIdAt(now - DAY, 'Y'), created_seq: 2, text: 'y' })
    fake.addMessage('s_o', {
      message_id: messageIdAt(now - 5 * DAY, 'X'),
      created_seq: 1,
      text: 'o',
    })

    const inbox = await mountInbox(fake)

    expect(inbox.groups.value.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Earlier'])
    expect(inbox.groups.value.map((g) => g.entries.map((e) => e.stream_id))).toEqual([
      ['s_t'],
      ['s_y'],
      ['s_o'],
    ])

    // Filtering to an empty subset drops every bucket.
    inbox.activeTab.value = 'dms'
    expect(inbox.groups.value).toEqual([])
  })

  it('previews a deleted latest message honestly (no redacted text leaks)', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.addMessage('s_a', { created_seq: 1, text: '' }).deleted = true

    const inbox = await mountInbox(fake)
    expect(inbox.entries.value[0]?.preview).toBe('Message deleted')
  })

  it('re-reads previews when a stream publishes new activity', async () => {
    fake.addStream({ stream_id: 's_a', name: 'alpha', kind: 'channel' })
    fake.addMessage('s_a', { created_seq: 1, text: 'first' })

    const inbox = await mountInbox(fake)
    expect(inbox.entries.value[0]?.preview).toContain('first')

    // A new message lands + the stream publishes → workspace refreshes → inbox re-reads.
    fake.addMessage('s_a', { created_seq: 2, text: 'second' })
    fake.setBadge('s_a', { unread: 1 })
    await flushPromises()

    expect(inbox.entries.value[0]?.preview).toContain('second')
    expect(inbox.entries.value[0]?.unread).toBe(1)
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('is empty (not loading) for a workspace with no activity', async () => {
    const inbox = await mountInbox(fake)
    expect(inbox.entries.value).toEqual([])
    expect(inbox.groups.value).toEqual([])
    expect(inbox.loading.value).toBe(false)
  })
})
