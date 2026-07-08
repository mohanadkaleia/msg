// stores/thread.ts — the thread pane's state (ENG-103, M3 D7 flat-channel threads).
//
// A sibling of the `messages` store, scoped to ONE open thread: the root message,
// its replies (messages whose `thread_root_id` is the root), and the participant
// set. It is a DUMB cache over the SAME worker RPC surface — reads are the new
// `messages.thread` projection query (ZERO network for already-synced replies),
// and an in-thread reply is the SAME `outbox.send` mutation as a channel message,
// only with `thread_root_id` set. The pane subscribes to the thread's stream, so a
// reply arriving over the WS (its own or someone else's) re-queries and lands in
// the pane; the main list's own subscription updates the root's count/participants.
// No message data comes from the HTTP API (the token boundary holds).

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { resolveWorkerClient } from '../composables/useWorkerClient'
import { messageTimestamp } from '../lib/time'
import type { DisplayMessage } from './messages'
import type { MessageRow, ReactionAggregate, ThreadParticipant, Unsubscribe } from '../worker'

/** Newest-first reply page size for a thread projection read. */
const PAGE = 50
/** Hard cap on the re-queried reply window (mirrors the projection page cap). */
const MAX_WINDOW = 500

export const useThreadStore = defineStore('thread', () => {
  /** The open thread's root id + its stream; both `null` while the pane is closed. */
  const rootId = ref<string | null>(null)
  const streamId = ref<string | null>(null)
  const rootRow = ref<MessageRow | null>(null)
  /** Ascending (oldest→newest) replies — the render order. */
  const replyRows = ref<MessageRow[]>([])
  const participants = ref<ThreadParticipant[]>([])
  const hasMore = ref(false)
  const loading = ref(false)
  const loadingOlder = ref(false)
  const myUserId = ref<string>('')

  /** `message_id → outbox event_id` for replies composed this session (retry/discard). */
  const sendEventIds = new Map<string, string>()
  /** `message_id → aggregated reaction chips` for the root + its replies. */
  const reactionsByMessage = ref<Map<string, ReactionAggregate[]>>(new Map())
  let unsub: Unsubscribe | undefined

  const isOpen = computed(() => rootId.value !== null)

  /** Decorate a projection row for rendering (never mutates the source row). */
  function decorate(m: MessageRow): DisplayMessage {
    const decorated: DisplayMessage = {
      ...m,
      ts: messageTimestamp(m),
      mine: m.author_user_id === myUserId.value,
      reactions: reactionsByMessage.value.get(m.message_id) ?? [],
    }
    const eventId = sendEventIds.get(m.message_id)
    if (eventId !== undefined) decorated.eventId = eventId
    return decorated
  }

  const displayRoot = computed<DisplayMessage | null>(() => {
    if (!rootRow.value) return null
    // The root carries the thread's participants so its in-pane affordance shows
    // the same reply-count + avatars as the main list.
    return { ...decorate(rootRow.value), threadParticipants: participants.value }
  })
  const displayReplies = computed<DisplayMessage[]>(() => replyRows.value.map(decorate))

  function setMyUserId(id: string): void {
    myUserId.value = id
  }

  /** Open the pane on a root: local projection read, then live subscription. */
  async function openThread(rootMessageId: string, threadStreamId: string): Promise<void> {
    if (rootMessageId === rootId.value) return
    unsub?.()
    unsub = undefined
    rootId.value = rootMessageId
    streamId.value = threadStreamId
    rootRow.value = null
    replyRows.value = []
    participants.value = []
    hasMore.value = false
    await load()
    const client = await resolveWorkerClient()
    // A push on the thread's stream (new reply / settle / edit / delete) re-reads.
    unsub = client.subscribe({ kind: 'stream', stream_id: threadStreamId }, () => {
      void refresh()
    })
  }

  /** Close the pane: drop the subscription + all thread state. */
  function close(): void {
    unsub?.()
    unsub = undefined
    rootId.value = null
    streamId.value = null
    rootRow.value = null
    replyRows.value = []
    participants.value = []
    hasMore.value = false
    reactionsByMessage.value = new Map()
    sendEventIds.clear()
  }

  /** Initial (or re-opened) reply page — newest `PAGE` replies, ASC. */
  async function load(): Promise<void> {
    const id = rootId.value
    if (id === null) return
    loading.value = true
    try {
      const client = await resolveWorkerClient()
      const res = await client.query({ q: 'messages.thread', root_message_id: id, limit: PAGE })
      if (id !== rootId.value) return // reopened mid-flight — drop
      rootRow.value = res.root
      replyRows.value = res.replies
      participants.value = res.participants
      hasMore.value = res.has_more
      await syncReactions()
    } finally {
      loading.value = false
    }
  }

  /**
   * Re-query the current reply window in place (a reply arrived / settled / was
   * edited or deleted, via the stream push). Keeps the window size stable so a
   * settle swaps the row rather than the whole list.
   */
  async function refresh(): Promise<void> {
    const id = rootId.value
    if (id === null) return
    const client = await resolveWorkerClient()
    const limit = Math.min(Math.max(replyRows.value.length, PAGE), MAX_WINDOW)
    const res = await client.query({ q: 'messages.thread', root_message_id: id, limit })
    if (id !== rootId.value) return
    rootRow.value = res.root
    replyRows.value = res.replies
    participants.value = res.participants
    hasMore.value = res.has_more
    await syncReactions()
  }

  /**
   * Scroll-up backfill of OLDER replies. The replies live in the thread's stream,
   * so we first extend that stream's window backward one server page
   * (`sync.backfill`, a no-op at the floor / when nothing older exists), then
   * re-read the thread older-than-oldest and PREPEND. Returns the number of
   * replies prepended so the pane can preserve scroll position. Zero network when
   * the older replies are already synced (the projection read alone yields them).
   */
  async function loadOlder(): Promise<number> {
    const id = rootId.value
    const stream = streamId.value
    if (id === null || stream === null || loadingOlder.value || !hasMore.value) return 0
    loadingOlder.value = true
    try {
      const client = await resolveWorkerClient()
      const oldest = replyRows.value[0]?.created_seq
      const backfilled = await client.sync.backfill(stream)
      const res = await client.query({
        q: 'messages.thread',
        root_message_id: id,
        ...(oldest !== undefined ? { before_seq: oldest } : {}),
        limit: PAGE,
      })
      if (id !== rootId.value) return 0
      const older = res.replies
      if (older.length > 0) replyRows.value = [...older, ...replyRows.value]
      hasMore.value = res.has_more || backfilled.has_more
      await syncReactions()
      return older.length
    } finally {
      loadingOlder.value = false
    }
  }

  /**
   * Re-read the reaction chips for the root + loaded replies (ENG-102 parity) —
   * a LOCAL `messages.reactions` projection read (present-only, zero network).
   */
  async function syncReactions(): Promise<void> {
    const id = rootId.value
    const ids = [
      ...(rootRow.value ? [rootRow.value.message_id] : []),
      ...replyRows.value.map((m) => m.message_id),
    ]
    if (ids.length === 0) {
      reactionsByMessage.value = new Map()
      return
    }
    const client = await resolveWorkerClient()
    const res = await client.query({ q: 'messages.reactions', message_ids: ids })
    if (id !== rootId.value) return // reopened mid-flight — drop
    const next = new Map<string, ReactionAggregate[]>()
    for (const m of res.messages) next.set(m.message_id, m.reactions)
    reactionsByMessage.value = next
  }

  /**
   * Send an in-thread reply — the SAME `outbox.send` mutation as a channel
   * message, with `thread_root_id` set to the open root. The optimistic pending
   * reply arrives via the stream push (→ `refresh`), renders greyed, and settles
   * on ack. `mentions` ride the existing optional field (the composer resolves them).
   */
  async function sendReply(
    text: string,
    mentions: string[] = [],
    fileIds: string[] = [],
  ): Promise<void> {
    const id = rootId.value
    const stream = streamId.value
    const body = text.trim()
    // A FILE-ONLY reply (ENG-121) is allowed: empty body with attachments still sends.
    if (id === null || stream === null || (body.length === 0 && fileIds.length === 0)) return
    const client = await resolveWorkerClient()
    const res = await client.mutate({
      m: 'outbox.send',
      stream_id: stream,
      text: body,
      thread_root_id: id,
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
    })
    sendEventIds.set(res.message_id, res.event_id)
  }

  /** Toggle YOUR reaction on the root or a reply (optimistic; idempotent). */
  async function toggleReaction(messageId: string, emoji: string, remove: boolean): Promise<void> {
    const stream = streamId.value
    if (stream === null || emoji.length === 0) return
    const client = await resolveWorkerClient()
    await client.mutate({
      m: 'outbox.react',
      stream_id: stream,
      message_id: messageId,
      emoji,
      remove,
    })
  }

  /** Edit one of YOUR replies/root (optimistic; LWW on settle). */
  async function editMessage(messageId: string, text: string): Promise<void> {
    const stream = streamId.value
    const body = text.trim()
    if (stream === null || body.length === 0) return
    const client = await resolveWorkerClient()
    await client.mutate({ m: 'outbox.edit', stream_id: stream, message_id: messageId, text: body })
  }

  /** Soft-delete one of YOUR replies/root (optimistic tombstone + redact). */
  async function deleteMessage(messageId: string): Promise<void> {
    const stream = streamId.value
    if (stream === null) return
    const client = await resolveWorkerClient()
    await client.mutate({ m: 'outbox.remove', stream_id: stream, message_id: messageId })
  }

  /** Re-queue a failed reply composed this session. */
  async function retry(messageId: string): Promise<void> {
    const eventId = sendEventIds.get(messageId)
    if (eventId === undefined) return
    const client = await resolveWorkerClient()
    await client.mutate({ m: 'outbox.retry', event_id: eventId })
  }

  /** Discard a failed/pending reply composed this session. */
  async function discard(messageId: string): Promise<void> {
    const eventId = sendEventIds.get(messageId)
    if (eventId === undefined) return
    const client = await resolveWorkerClient()
    await client.mutate({ m: 'outbox.delete', event_id: eventId })
    sendEventIds.delete(messageId)
  }

  function dispose(): void {
    close()
  }

  return {
    rootId,
    streamId,
    isOpen,
    displayRoot,
    displayReplies,
    participants,
    hasMore,
    loading,
    setMyUserId,
    openThread,
    close,
    refresh,
    loadOlder,
    sendReply,
    toggleReaction,
    editMessage,
    deleteMessage,
    retry,
    discard,
    dispose,
  }
})
