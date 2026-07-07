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
import type { MessageRow, ReactionAggregate, Unsubscribe } from '../worker'

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
  /**
   * Aggregated reaction chips (ENG-102) — present-only, joined in from the
   * `messages.reactions` projection read. Optional so isolated component tests can
   * omit it (defaults to `[]` in the view).
   */
  reactions?: ReactionAggregate[]
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
  /** `message_id → aggregated reaction chips`, from the `messages.reactions` read. */
  const reactionsByMessage = ref<Map<string, ReactionAggregate[]>>(new Map())
  let unsub: Unsubscribe | undefined

  const displayMessages = computed<DisplayMessage[]>(() =>
    rows.value.map((m) => {
      const decorated: DisplayMessage = {
        ...m,
        ts: messageTimestamp(m),
        mine: m.author_user_id === myUserId.value,
        reactions: reactionsByMessage.value.get(m.message_id) ?? [],
      }
      const eventId = sendEventIds.get(m.message_id)
      if (eventId !== undefined) decorated.eventId = eventId
      return decorated
    }),
  )

  /** The newest own, non-deleted message id — the ArrowUp→edit-last target (ENG-102). */
  const lastOwnMessageId = computed<string | null>(() => {
    for (let i = rows.value.length - 1; i >= 0; i--) {
      const r = rows.value[i]!
      if (r.author_user_id === myUserId.value && r.deleted !== true) return r.message_id
    }
    return null
  })

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
      // Defensive: never trust a page longer than we asked for (no-infallibility).
      rows.value = res.messages.slice(0, PAGE).reverse()
      hasMore.value = res.has_more
      await syncReactions()
    } finally {
      loading.value = false
    }
  }

  /**
   * Re-read the reaction chips for the currently loaded rows (ENG-102) — a LOCAL
   * `messages.reactions` projection read (present-only, zero network). Runs after
   * every list load / refresh / backfill and after an optimistic react settles via
   * the stream push, so chips render instantly and converge into server order. A
   * stream-switch race (rows changed mid-await) drops the stale result.
   */
  async function syncReactions(): Promise<void> {
    const streamId = currentStreamId.value
    const ids = rows.value.map((m) => m.message_id)
    if (ids.length === 0) {
      reactionsByMessage.value = new Map()
      return
    }
    const client = await resolveWorkerClient()
    const res = await client.query({ q: 'messages.reactions', message_ids: ids })
    if (streamId !== currentStreamId.value) return // switched streams mid-flight — drop
    const next = new Map<string, ReactionAggregate[]>()
    for (const m of res.messages) next.set(m.message_id, m.reactions)
    reactionsByMessage.value = next
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
    // Defensive: clamp to the requested window (no-infallibility).
    rows.value = res.messages.slice(0, limit).reverse()
    hasMore.value = res.has_more
    await syncReactions()
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
      const older = res.messages.slice(0, PAGE).reverse()
      if (older.length > 0) rows.value = [...older, ...rows.value]
      hasMore.value = res.has_more || backfilled.has_more
      await syncReactions()
      return older.length
    } finally {
      loadingOlder.value = false
    }
  }

  /**
   * Optimistic send through the outbox. The pending row arrives via the push.
   *
   * `mentions` (ENG-101) are the resolved `u_` ids of the composed @mentions; they
   * ride the SAME `outbox.send` mutation (an already-supported optional field) and
   * populate the message payload's `mentions[]` / the projection's
   * `mention_user_ids`. The wire/format contract is otherwise unchanged — text is
   * still markdown source, `format` still defaults markdown worker-side.
   */
  async function send(text: string, mentions: string[] = []): Promise<void> {
    const streamId = currentStreamId.value
    const body = text.trim()
    if (streamId === null || body.length === 0) return
    const client = await resolveWorkerClient()
    const res = await client.mutate({
      m: 'outbox.send',
      stream_id: streamId,
      text: body,
      ...(mentions.length > 0 ? { mentions } : {}),
    })
    sendEventIds.set(res.message_id, res.event_id)
  }

  /**
   * Toggle YOUR reaction on a message (ENG-102) — optimistic via `outbox.react`.
   * `remove` is the caller's read of the CURRENT membership (idempotent toggle:
   * clicking an active reaction removes it). The worker applies the pending overlay
   * + publishes, our subscription re-reads chips, and it settles into server order.
   */
  async function toggleReaction(messageId: string, emoji: string, remove: boolean): Promise<void> {
    const streamId = currentStreamId.value
    if (streamId === null || emoji.length === 0) return
    const client = await resolveWorkerClient()
    await client.mutate({
      m: 'outbox.react',
      stream_id: streamId,
      message_id: messageId,
      emoji,
      remove,
    })
  }

  /**
   * Edit one of YOUR messages (ENG-102) — optimistic via `outbox.edit`
   * (`message.edited`). The text updates immediately and the "edited" marker lands
   * on settle (the projection stamps `edited_seq` on ack). Whitespace-only is a
   * no-op (parity with `send`); server + author-or-admin rules still enforce.
   */
  async function editMessage(messageId: string, text: string): Promise<void> {
    const streamId = currentStreamId.value
    const body = text.trim()
    if (streamId === null || body.length === 0) return
    const client = await resolveWorkerClient()
    await client.mutate({
      m: 'outbox.edit',
      stream_id: streamId,
      message_id: messageId,
      text: body,
    })
  }

  /**
   * Soft-delete one of YOUR messages (ENG-102, ENG-111) — optimistic via
   * `outbox.remove` (`message.deleted`). The projection tombstones + REDACTS the
   * text instantly; the raw event is retained in the log (a soft delete, not a
   * cryptographic erase — the UI labels it honestly).
   */
  async function deleteMessage(messageId: string): Promise<void> {
    const streamId = currentStreamId.value
    if (streamId === null) return
    const client = await resolveWorkerClient()
    await client.mutate({ m: 'outbox.remove', stream_id: streamId, message_id: messageId })
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
    lastOwnMessageId,
    setMyUserId,
    selectStream,
    load,
    refresh,
    loadOlder,
    send,
    toggleReaction,
    editMessage,
    deleteMessage,
    retry,
    discard,
    dispose,
  }
})
