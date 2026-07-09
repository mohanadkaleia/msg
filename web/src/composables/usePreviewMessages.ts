// usePreviewMessages — ENG-152 Inbox preview pane (feed + preview split).
//
// A SMALL, preview-scoped message window for the Inbox's right-hand pane: the
// selected feed item's recent messages + a quick-reply send, WITHOUT touching the
// main messages store (the active conversation's window must survive Inbox
// triage untouched — selecting a feed item is a preview, not a navigation).
//
// Reads are the SAME zero-network `messages.list` projection query the
// conversation uses, scoped to the previewed stream and capped to a recent page
// (no scrollback/backfill here — "Open" jumps to the full conversation for
// history). A `{kind:'stream'}` subscription keeps the preview live, so a
// quick-reply (or any inbound message) re-reads and appears in place. Sends go
// through the SAME `outbox.send` outbox mutation as the conversation composer.
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'

import { resolveWorkerClient } from './useWorkerClient'
import { messageTimestamp } from '../lib/time'
import { useAuthStore } from '../stores/auth'
import type { DisplayMessage } from '../stores/messages'
import type { MessageRow, Unsubscribe } from '../worker'

/** Recent-page size for the preview (a triage glance, not full scrollback). */
const PREVIEW_PAGE = 30

export interface UsePreviewMessages {
  /** The previewed stream's recent messages, oldest→newest, render-decorated. */
  messages: ComputedRef<DisplayMessage[]>
  /** True while the previewed stream's initial read is in flight. */
  loading: Ref<boolean>
  /** Quick-reply: send to the PREVIEWED stream via the outbox (stays in Inbox). */
  send: (text: string, mentions?: string[], fileIds?: string[]) => Promise<void>
}

/**
 * Load + live-follow the recent messages of `streamId()` (null = no selection —
 * the window empties and no subscription is held). Fully independent of the
 * messages store: its own rows, its own subscription, disposed with the scope.
 */
export function usePreviewMessages(streamId: () => string | null): UsePreviewMessages {
  const auth = useAuthStore()

  /** Ascending (oldest→newest) — the render order. */
  const rows = ref<MessageRow[]>([])
  const loading = ref(false)
  let unsub: Unsubscribe | undefined
  /** Drops a stale in-flight read/subscription when the selection changes. */
  let generation = 0

  /** Re-read the previewed stream's recent page (LOCAL projection, zero network). */
  async function refresh(id: string, gen: number): Promise<void> {
    const client = await resolveWorkerClient()
    const res = await client.query({ q: 'messages.list', stream_id: id, limit: PREVIEW_PAGE })
    if (gen !== generation) return // selection changed mid-flight — drop
    // Defensive: never trust a page longer than we asked for (no-infallibility).
    rows.value = res.messages.slice(0, PREVIEW_PAGE).reverse()
    loading.value = false
  }

  watch(
    streamId,
    (id) => {
      unsub?.()
      unsub = undefined
      rows.value = []
      const gen = ++generation
      if (id === null) {
        loading.value = false
        return
      }
      loading.value = true
      void (async () => {
        const client = await resolveWorkerClient()
        if (gen !== generation) return // selection changed while resolving
        unsub = client.subscribe({ kind: 'stream', stream_id: id }, () => void refresh(id, gen))
        await refresh(id, gen)
      })()
    },
    { immediate: true },
  )

  const messages = computed<DisplayMessage[]>(() =>
    rows.value.map((m) => ({
      ...m,
      ts: messageTimestamp(m),
      mine: m.author_user_id === auth.myUserId,
    })),
  )

  /** Quick-reply through the outbox — the pending row lands via the stream push. */
  async function send(
    text: string,
    mentions: string[] = [],
    fileIds: string[] = [],
  ): Promise<void> {
    const id = streamId()
    const body = text.trim()
    // A file-only message is allowed (parity with the conversation composer).
    if (id === null || (body.length === 0 && fileIds.length === 0)) return
    const client = await resolveWorkerClient()
    await client.mutate({
      m: 'outbox.send',
      stream_id: id,
      text: body,
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
    })
  }

  onScopeDispose(() => {
    unsub?.()
    unsub = undefined
  })

  return { messages, loading, send }
}
