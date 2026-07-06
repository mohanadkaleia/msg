// stores/messages.ts — the selected stream's message window (ENG-82).
//
// A DUMB cache over the worker RPC. Reads are `messages.list` projection queries
// (ENG-80) — switching channels is a local projection read, ZERO network. Sends
// go through the ENG-81 outbox (`mutate outbox.send`): the worker inserts a
// PENDING row and publishes the stream, our `{kind:'stream'}` subscription
// re-queries, and the row renders greyed until the ack settles it in place.
// Scroll-top backfill calls the ENG-79 `sync.backfill` pull, then re-queries the
// now-extended window and prepends the older page.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { resolveWorkerClient } from '../composables/useWorkerClient'
import { messageTimestamp } from '../lib/time'
import type { MessageRow, Unsubscribe } from '../worker'

/** Newest-first page size for a projection read. */
const PAGE = 50
/** Hard cap on the re-queried head window (mirrors the projection page cap). */
const MAX_WINDOW = 500

/** A message row decorated for rendering (never mutates the projection row). */
export interface DisplayMessage extends MessageRow {
  /** ms-epoch creation time, decoded from the ULID id (day dividers / clock). */
  ts: number
  /** True when authored by the signed-in user. */
  mine: boolean
  /** Outbox `event_id` for a pending/failed row composed this session (retry/delete). */
  eventId?: string
}

export const useMessagesStore = defineStore('messages', () => {
  /** Ascending (oldest→newest) — the render order. */
  const rows = ref<MessageRow[]>([])
  const currentStreamId = ref<string | null>(null)
  const loading = ref(false)
  const loadingOlder = ref(false)
  const hasMore = ref(false)
  const myUserId = ref<string>('')

  /** `message_id → outbox event_id`, populated from this session's sends. */
  const sendEventIds = new Map<string, string>()
  let unsub: Unsubscribe | undefined

  const displayMessages = computed<DisplayMessage[]>(() =>
    rows.value.map((m) => {
      const decorated: DisplayMessage = {
        ...m,
        ts: messageTimestamp(m),
        mine: m.author_user_id === myUserId.value,
      }
      const eventId = sendEventIds.get(m.message_id)
      if (eventId !== undefined) decorated.eventId = eventId
      return decorated
    }),
  )

  const isEmpty = computed(() => !loading.value && rows.value.length === 0)

  function setMyUserId(id: string): void {
    myUserId.value = id
  }

  /** Switch the visible stream: local projection read, then live subscription. */
  async function selectStream(streamId: string): Promise<void> {
    if (streamId === currentStreamId.value) return
    unsub?.()
    unsub = undefined
    currentStreamId.value = streamId
    rows.value = []
    hasMore.value = false
    await load()
    const client = await resolveWorkerClient()
    unsub = client.subscribe({ kind: 'stream', stream_id: streamId }, () => {
      void refresh()
    })
  }

  /** Initial (or re-selected) head page — newest `PAGE` messages, ASC. */
  async function load(): Promise<void> {
    const streamId = currentStreamId.value
    if (streamId === null) return
    loading.value = true
    try {
      const client = await resolveWorkerClient()
      const res = await client.query({ q: 'messages.list', stream_id: streamId, limit: PAGE })
      rows.value = [...res.messages].reverse()
      hasMore.value = res.has_more
    } finally {
      loading.value = false
    }
  }

  /**
   * Re-query the current head window in place (pending insert / ack settle / new
   * arrival). Keeps the window size stable so a settle swaps the row, not the
   * whole list. Older backfilled pages beyond the window are re-fetched on scroll.
   */
  async function refresh(): Promise<void> {
    const streamId = currentStreamId.value
    if (streamId === null) return
    const client = await resolveWorkerClient()
    const limit = Math.min(Math.max(rows.value.length, PAGE), MAX_WINDOW)
    const res = await client.query({ q: 'messages.list', stream_id: streamId, limit })
    rows.value = [...res.messages].reverse()
    hasMore.value = res.has_more
  }

  /**
   * Scroll-top scrollback: pull the previous server page into the projection
   * (`sync.backfill`), then re-query older-than-oldest and PREPEND. Returns the
   * number of rows prepended so the view can preserve scroll position.
   */
  async function loadOlder(): Promise<number> {
    const streamId = currentStreamId.value
    if (streamId === null || loadingOlder.value || !hasMore.value) return 0
    loadingOlder.value = true
    try {
      const client = await resolveWorkerClient()
      const oldest = rows.value[0]?.created_seq
      // Extend the stream's window backward one server page (§10). No-op at the floor.
      const backfilled = await client.sync.backfill(streamId)
      const res = await client.query({
        q: 'messages.list',
        stream_id: streamId,
        ...(oldest !== undefined ? { before_seq: oldest } : {}),
        limit: PAGE,
      })
      const older = [...res.messages].reverse()
      if (older.length > 0) rows.value = [...older, ...rows.value]
      hasMore.value = res.has_more || backfilled.has_more
      return older.length
    } finally {
      loadingOlder.value = false
    }
  }

  /** Optimistic send through the outbox. The pending row arrives via the push. */
  async function send(text: string): Promise<void> {
    const streamId = currentStreamId.value
    const body = text.trim()
    if (streamId === null || body.length === 0) return
    const client = await resolveWorkerClient()
    const res = await client.mutate({ m: 'outbox.send', stream_id: streamId, text: body })
    sendEventIds.set(res.message_id, res.event_id)
  }

  /** Re-queue a failed send composed this session. */
  async function retry(messageId: string): Promise<void> {
    const eventId = sendEventIds.get(messageId)
    if (eventId === undefined) return
    const client = await resolveWorkerClient()
    await client.mutate({ m: 'outbox.retry', event_id: eventId })
  }

  /** Discard a failed/pending send composed this session. */
  async function discard(messageId: string): Promise<void> {
    const eventId = sendEventIds.get(messageId)
    if (eventId === undefined) return
    const client = await resolveWorkerClient()
    await client.mutate({ m: 'outbox.delete', event_id: eventId })
    sendEventIds.delete(messageId)
  }

  function dispose(): void {
    unsub?.()
    unsub = undefined
  }

  return {
    rows,
    displayMessages,
    currentStreamId,
    loading,
    loadingOlder,
    hasMore,
    isEmpty,
    setMyUserId,
    selectStream,
    load,
    refresh,
    loadOlder,
    send,
    retry,
    discard,
    dispose,
  }
})
