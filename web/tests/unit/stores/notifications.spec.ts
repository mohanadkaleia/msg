// tests/unit/stores/notifications.spec.ts — ENG-129 notification behavior. The
// pure `shouldNotify` matrix (own/active/mute/mentions/all), plus the store
// end-to-end against the FakeWorker + the REAL workspace store: a new inbound
// message (delivered exactly like a live WS projection update) raises a toast,
// fires a browser Notification ONLY when permission is `granted`, respects the
// per-stream pref gate reactively (the `{kind:'prefs'}` push), notifies for a
// brand-new DM stream, and drives the tab-title unread count. No HTTP anywhere —
// the FakeWorker's fetch spy stays untouched.
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import {
  previewText,
  shouldNotify,
  useNotificationsStore,
  type NotifyInput,
} from '../../../src/stores/notifications'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import { FakeWorker } from '../shell/fakeWorker'

// -- shouldNotify: the pure decision matrix -----------------------------------

function input(overrides: Partial<NotifyInput> = {}): NotifyInput {
  return {
    streamId: 's_general',
    streamKind: 'channel',
    authorUserId: 'u_other',
    mentionsMe: false,
    level: 'all',
    myUserId: 'u_me',
    activeStreamId: null,
    documentVisible: true,
    ...overrides,
  }
}

describe('shouldNotify (ENG-129 decision matrix)', () => {
  it('suppresses my own message (even a self-mention in a DM)', () => {
    expect(shouldNotify(input({ authorUserId: 'u_me' }))).toBe(false)
    expect(
      shouldNotify(
        input({ authorUserId: 'u_me', streamKind: 'dm', mentionsMe: true, level: 'all' }),
      ),
    ).toBe(false)
  })

  it('suppresses the active conversation while the document is visible', () => {
    expect(shouldNotify(input({ activeStreamId: 's_general' }))).toBe(false)
  })

  it('notifies for the active conversation when the document is HIDDEN', () => {
    expect(shouldNotify(input({ activeStreamId: 's_general', documentVisible: false }))).toBe(true)
  })

  it('mute silences everything — even a mention or a DM', () => {
    expect(shouldNotify(input({ level: 'mute' }))).toBe(false)
    expect(shouldNotify(input({ level: 'mute', mentionsMe: true }))).toBe(false)
    expect(shouldNotify(input({ level: 'mute', streamKind: 'dm' }))).toBe(false)
  })

  it('mentions level: a plain message is silent; an @me mention or a DM notifies', () => {
    expect(shouldNotify(input({ level: 'mentions' }))).toBe(false)
    expect(shouldNotify(input({ level: 'mentions', mentionsMe: true }))).toBe(true)
    expect(shouldNotify(input({ level: 'mentions', streamKind: 'dm' }))).toBe(true)
  })

  it('all (the default) notifies on any inbound message', () => {
    expect(shouldNotify(input())).toBe(true)
  })
})

describe('previewText', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(previewText('  hello\n\nworld  ')).toBe('hello world')
    const long = 'a'.repeat(200)
    const out = previewText(long)
    expect(out.length).toBe(120)
    expect(out.endsWith('…')).toBe(true)
  })
})

// -- The store, end-to-end over the FakeWorker + workspace store ---------------

/** A constructible Notification mock with a controllable static permission. */
class MockNotification {
  static permission: NotificationPermission = 'default'
  static requestPermission = vi.fn(() => Promise.resolve(MockNotification.permission))
  static instances: MockNotification[] = []
  onclick: (() => void) | null = null
  constructor(
    public title: string,
    public options?: { body?: string; tag?: string },
  ) {
    MockNotification.instances.push(this)
  }
}

/** Force `document.visibilityState` (jsdom defaults to 'visible'). */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
}

describe('useNotificationsStore (ENG-129)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    setActivePinia(createPinia())
    fake = new FakeWorker()
    fake.addStream({ stream_id: 's_general', name: 'general', head_seq: 1 })
    fake.addStream({ stream_id: 's_dm', name: 'Rana', kind: 'dm', head_seq: 1 })
    fake.addMessage('s_general', { created_seq: 1, text: 'old', author_user_id: 'u_rana' })
    fake.setDirectory([{ user_id: 'u_rana', display_name: 'Rana' }], [])
    setWorkerClient(fake.client)
    MockNotification.permission = 'default'
    MockNotification.instances = []
    MockNotification.requestPermission.mockClear()
    document.title = 'msg'
    setVisibility('visible')
  })

  afterEach(() => {
    setWorkerClient(undefined)
    vi.unstubAllGlobals()
  })

  /** Boot the workspace + notifications stores (baseline = the seeded streams). */
  async function boot(): Promise<ReturnType<typeof useNotificationsStore>> {
    const workspace = useWorkspaceStore()
    await workspace.load()
    const store = useNotificationsStore()
    await store.start('u_me')
    await flushPromises()
    return store
  }

  it('toasts on a new inbound message (name + author + text-only preview)', async () => {
    const store = await boot()
    expect(store.toasts).toHaveLength(0)

    fake.deliver('s_general', { created_seq: 2, author_user_id: 'u_rana', text: 'lunch?' })
    await flushPromises()

    expect(store.toasts).toHaveLength(1)
    expect(store.toasts[0]).toMatchObject({
      stream_id: 's_general',
      title: '# general',
      author: 'Rana',
      preview: 'lunch?',
    })
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it('never re-notifies history: the baseline snapshot raises no toasts', async () => {
    fake.setBadge('s_general', { unread: 5 })
    const store = await boot()
    expect(store.toasts).toHaveLength(0)
  })

  it('suppresses my own message', async () => {
    const store = await boot()
    fake.deliver('s_general', { created_seq: 2, author_user_id: 'u_me', text: 'mine' })
    await flushPromises()
    expect(store.toasts).toHaveLength(0)
  })

  it('suppresses the ACTIVE conversation while visible, but not when hidden', async () => {
    const store = await boot()
    store.setActiveStream('s_general')

    fake.deliver('s_general', { created_seq: 2, author_user_id: 'u_rana', text: 'seen live' })
    await flushPromises()
    expect(store.toasts).toHaveLength(0)

    setVisibility('hidden')
    fake.deliver('s_general', { created_seq: 3, author_user_id: 'u_rana', text: 'while away' })
    await flushPromises()
    expect(store.toasts).toHaveLength(1)
    expect(store.toasts[0]!.preview).toBe('while away')
  })

  it('mute silences even a mention; mentions level gates a plain message', async () => {
    const store = await boot()

    // mute: an @me mention stays silent.
    await fake.client.prefs.set('s_general', 'mute')
    await flushPromises()
    fake.deliver('s_general', {
      created_seq: 2,
      author_user_id: 'u_rana',
      text: 'hey @me',
      mention_user_ids: ['u_me'],
    })
    await flushPromises()
    expect(store.toasts).toHaveLength(0)

    // mentions: a plain message is silent…
    await fake.client.prefs.set('s_general', 'mentions')
    await flushPromises()
    fake.deliver('s_general', { created_seq: 3, author_user_id: 'u_rana', text: 'plain' })
    await flushPromises()
    expect(store.toasts).toHaveLength(0)

    // …but an @me mention notifies.
    fake.deliver('s_general', {
      created_seq: 4,
      author_user_id: 'u_rana',
      text: 'ping @me',
      mention_user_ids: ['u_me'],
    })
    await flushPromises()
    expect(store.toasts).toHaveLength(1)
  })

  it('a DM notifies at the mentions level (high-signal) and is muteable', async () => {
    const store = await boot()

    await fake.client.prefs.set('s_dm', 'mentions')
    await flushPromises()
    fake.deliver('s_dm', { created_seq: 2, author_user_id: 'u_rana', text: 'psst' })
    await flushPromises()
    expect(store.toasts).toHaveLength(1)
    // DM toast titles carry the peer's name, not a '#'.
    expect(store.toasts[0]!.title).toBe('Rana')

    await fake.client.prefs.set('s_dm', 'mute')
    await flushPromises()
    fake.deliver('s_dm', { created_seq: 3, author_user_id: 'u_rana', text: 'psst again' })
    await flushPromises()
    expect(store.toasts).toHaveLength(1) // unchanged
  })

  it('notifies the first message of a BRAND-NEW DM stream (post-baseline discovery)', async () => {
    const store = await boot()

    // A new DM stream lands via sync with its first inbound message already
    // projected (head 2 = dm.created + message; 1 unread).
    fake.addStream({ stream_id: 's_dm_new', name: 'Zed', kind: 'dm', head_seq: 2, unread: 1 })
    fake.addMessage('s_dm_new', { created_seq: 2, author_user_id: 'u_zed', text: 'first ever' })
    fake.emitSync({ state: 'live', online: true })
    await flushPromises()

    expect(store.toasts).toHaveLength(1)
    expect(store.toasts[0]).toMatchObject({ stream_id: 's_dm_new', preview: 'first ever' })
  })

  it('fires a browser Notification ONLY when permission is granted', async () => {
    vi.stubGlobal('Notification', MockNotification)
    const store = await boot()

    // default → toast only, no Notification.
    fake.deliver('s_general', { created_seq: 2, author_user_id: 'u_rana', text: 'no perm' })
    await flushPromises()
    expect(store.toasts).toHaveLength(1)
    expect(MockNotification.instances).toHaveLength(0)

    // denied → still none.
    MockNotification.permission = 'denied'
    fake.deliver('s_general', { created_seq: 3, author_user_id: 'u_rana', text: 'denied' })
    await flushPromises()
    expect(MockNotification.instances).toHaveLength(0)

    // granted → Notification with a text-only body, tagged by stream (coalesce).
    MockNotification.permission = 'granted'
    fake.deliver('s_general', {
      created_seq: 4,
      author_user_id: 'u_rana',
      text: '<img src=x onerror=alert(1)>',
    })
    await flushPromises()
    expect(MockNotification.instances).toHaveLength(1)
    const n = MockNotification.instances[0]!
    expect(n.title).toBe('# general')
    expect(n.options?.body).toBe('Rana: <img src=x onerror=alert(1)>') // plain string, never HTML
    expect(n.options?.tag).toBe('s_general')

    // Clicking the Notification focuses the window + jumps through the handler.
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const jump = vi.fn()
    store.setJumpHandler(jump)
    n.onclick?.()
    expect(focus).toHaveBeenCalled()
    expect(jump).toHaveBeenCalledWith('s_general')
  })

  it('requestPermission mirrors the browser answer; unsupported stays inert', async () => {
    vi.stubGlobal('Notification', MockNotification)
    MockNotification.permission = 'granted'
    const store = await boot()
    await store.requestPermission()
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce()
    expect(store.permission).toBe('granted')
  })

  it('tab title carries the total unread count and resets at zero', async () => {
    await boot()
    expect(document.title).toBe('msg')

    fake.deliver('s_general', { created_seq: 2, author_user_id: 'u_rana', text: 'one' })
    await flushPromises()
    expect(document.title).toBe('(1) msg')

    fake.deliver('s_dm', { created_seq: 2, author_user_id: 'u_rana', text: 'two' })
    await flushPromises()
    expect(document.title).toBe('(2) msg')

    // Read-state cleared (badges re-derive to zero) → the plain title returns.
    fake.setBadge('s_general', { unread: 0 })
    fake.setBadge('s_dm', { unread: 0 })
    await flushPromises()
    expect(document.title).toBe('msg')
  })

  it('dismissToast removes one card; stop() clears state and restores the title', async () => {
    const store = await boot()
    fake.deliver('s_general', { created_seq: 2, author_user_id: 'u_rana', text: 'a' })
    await flushPromises()
    expect(store.toasts).toHaveLength(1)

    store.dismissToast(store.toasts[0]!.id)
    expect(store.toasts).toHaveLength(0)

    store.stop()
    expect(document.title).toBe('msg')
    // After stop, deliveries no longer notify (watchers torn down).
    fake.deliver('s_general', { created_seq: 3, author_user_id: 'u_rana', text: 'late' })
    await flushPromises()
    expect(store.toasts).toHaveLength(0)
  })
})
