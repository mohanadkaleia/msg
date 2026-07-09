<script setup lang="ts">
// InboxPreview — ENG-152, the Inbox's right-hand PREVIEW pane (feed + preview
// split). Given the SELECTED feed entry it shows, without leaving Inbox:
//
//   • a compact header — the stream title (`# channel` / the DM participant's
//     name, already resolved by useInbox per ENG-149) + an "Open" button that
//     does the full jump (`open` → the shell's onOpenStream), and
//   • the stream's recent messages — the SAME MessageItem rendering the
//     conversation uses, loaded through `usePreviewMessages` (a preview-scoped
//     `messages.list` projection read; the MAIN messages store is untouched), and
//   • a quick-reply composer — the SAME MessageComposer, bound to the selected
//     stream; sending stays in Inbox (the preview + feed item update live).
//
// With no selection it renders the "Select an item to preview" EmptyState.
// XSS: titles/message text/names all render via text interpolation inside
// MessageItem / this template — no raw-HTML sink.
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'

import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import Icon from '../ui/Icon.vue'
import MessageComposer from './MessageComposer.vue'
import MessageItem from './MessageItem.vue'
import { usePreviewMessages } from '../../composables/usePreviewMessages'
import { useWorkspaceStore } from '../../stores/workspace'
import type { InboxEntry } from '../../composables/useInbox'
import type { DisplayMessage } from '../../stores/messages'

const props = defineProps<{ entry: InboxEntry | null }>()

const emit = defineEmits<{ open: [streamId: string] }>()

const workspace = useWorkspaceStore()
const { mentionItems, directory } = storeToRefs(workspace)

/** Directory-backed `user_id → display_name` (author names in message rows). */
const names = computed<ReadonlyMap<string, string>>(
  () => new Map(directory.value.users.map((u) => [u.user_id, u.display_name])),
)

// Preview-scoped window: independent of the active conversation's store.
const { messages, loading, send } = usePreviewMessages(() => props.entry?.stream_id ?? null)

/** Consecutive same-author messages within this window render grouped. */
const GROUP_WINDOW_MS = 5 * 60 * 1000

/** Rows with the conversation's grouping rule (author change / >5min gap). */
const items = computed<Array<{ message: DisplayMessage; showHeader: boolean }>>(() => {
  let prev: DisplayMessage | null = null
  return messages.value.map((message) => {
    const showHeader =
      prev === null ||
      prev.author_user_id !== message.author_user_id ||
      message.ts - prev.ts > GROUP_WINDOW_MS
    prev = message
    return { message, showHeader }
  })
})

const scroller = ref<HTMLElement | null>(null)

// Keep the preview pinned to the newest message: on selection change and when
// a message lands (quick-reply echo / live inbound), scroll to the bottom.
watch(
  () => [props.entry?.stream_id, messages.value.length] as const,
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

/** Quick-reply → the previewed stream, via the outbox (stays in Inbox). */
function onSend(text: string, mentions: string[], fileIds: string[]): void {
  void send(text, mentions, fileIds)
}
</script>

<template>
  <section
    data-testid="inbox-preview"
    class="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
    aria-label="Preview"
  >
    <template v-if="entry">
      <!-- Compact header: the stream title + the full-jump "Open" button. -->
      <header class="flex items-center justify-between gap-2 border-b border-subtle px-4 py-2">
        <h2 class="min-w-0 truncate text-[13px] font-semibold text-primary">{{ entry.title }}</h2>
        <Button
          size="sm"
          variant="ghost"
          data-testid="inbox-preview-open"
          @click="emit('open', entry.stream_id)"
        >
          Open
          <Icon name="chevron-right" :size="14" />
        </Button>
      </header>

      <!-- Recent messages (the conversation's MessageItem rendering, read-only
           surface here — editing/threads live in the full conversation). -->
      <div ref="scroller" class="flex-1 overflow-y-auto py-2">
        <div
          v-for="item in items"
          :key="item.message.message_id"
          data-testid="inbox-preview-message"
        >
          <MessageItem :message="item.message" :show-header="item.showHeader" :names="names" />
        </div>
        <p
          v-if="!loading && messages.length === 0"
          class="px-4 py-6 text-center text-[12px] text-muted"
        >
          No messages yet.
        </p>
      </div>

      <!-- Quick-reply composer, bound to the SELECTED stream. -->
      <div data-testid="inbox-preview-composer">
        <MessageComposer
          :placeholder="`Reply to ${entry.title}`"
          :mention-items="mentionItems"
          :stream-id="entry.stream_id"
          @send="onSend"
        />
      </div>
    </template>

    <!-- No selection: the pane invites a pick instead of sitting blank. -->
    <div v-else class="flex flex-1 items-center justify-center" data-testid="inbox-preview-empty">
      <EmptyState
        title="Select an item to preview"
        description="Click a conversation in the feed to read and reply without leaving Inbox."
      >
        <template #icon><Icon name="message-square" :size="24" /></template>
      </EmptyState>
    </div>
  </section>
</template>
