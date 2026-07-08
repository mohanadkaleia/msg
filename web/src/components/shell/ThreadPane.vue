<script setup lang="ts">
// ThreadPane — the M3 right-hand thread panel (ENG-103, D7 flat-channel threads).
//
// A smart panel bound to the `thread` store: it shows the root message at top,
// then the root's replies (messages whose `thread_root_id` is the root) via the
// `messages.thread` projection read, with scroll-up backfill of older replies. A
// compact composer at the bottom sends an in-thread reply — the SAME `outbox.send`
// mutation with `thread_root_id` set → optimistic pending render → settle. A reply
// arriving over the WS re-queries the pane (live). Keeping the store wiring here
// (not in ShellView) keeps the shell's additions minimal (ENG-104 co-edits it).
//
// XSS: reply text, author names and participant names all render via `{{ }}` /
// safe bindings inside MessageItem/MessageComposer — no raw-HTML or script sink.
import { nextTick, ref } from 'vue'
import { storeToRefs } from 'pinia'

import { useThreadStore } from '../../stores/thread'
import { useWorkspaceStore } from '../../stores/workspace'
import MessageComposer from './MessageComposer.vue'
import MessageItem from './MessageItem.vue'

const thread = useThreadStore()
const workspace = useWorkspaceStore()
const { displayRoot, displayReplies, participants, hasMore, streamId } = storeToRefs(thread)
const { mentionItems } = storeToRefs(workspace)

/** The reply currently in inline edit (null = none) — pane-local, like the main list. */
const editingMessageId = ref<string | null>(null)

const scroller = ref<HTMLElement | null>(null)
let loadingOlder = false

/** Scroll-up backfill: pull older replies and re-anchor so the view does not jump. */
async function onScroll(): Promise<void> {
  const el = scroller.value
  if (!el || loadingOlder || !hasMore.value) return
  if (el.scrollTop > 48) return
  loadingOlder = true
  const beforeHeight = el.scrollHeight
  const beforeTop = el.scrollTop
  try {
    const added = await thread.loadOlder()
    await nextTick()
    if (added > 0) el.scrollTop = beforeTop + (el.scrollHeight - beforeHeight)
  } finally {
    loadingOlder = false
  }
}

function onClose(): void {
  editingMessageId.value = null
  thread.close()
}

function onSendReply(text: string, mentions: string[], fileIds: string[]): void {
  void thread.sendReply(text, mentions, fileIds)
}

function onReact(messageId: string, emoji: string, remove: boolean): void {
  void thread.toggleReaction(messageId, emoji, remove)
}

function onEditStart(messageId: string): void {
  editingMessageId.value = messageId
}

function onEditSubmit(messageId: string, text: string): void {
  void thread.editMessage(messageId, text)
  editingMessageId.value = null
}

function onEditCancel(): void {
  editingMessageId.value = null
}

function onDelete(messageId: string): void {
  if (editingMessageId.value === messageId) editingMessageId.value = null
  void thread.deleteMessage(messageId)
}
</script>

<template>
  <aside
    class="flex w-96 min-w-0 flex-col border-l border-subtle bg-background"
    data-testid="thread-pane"
  >
    <header class="flex items-center justify-between border-b border-subtle px-4 py-3">
      <h2 class="text-sm font-semibold text-primary">Thread</h2>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs text-secondary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        data-testid="thread-close"
        aria-label="Close thread"
        @click="onClose"
      >
        Close
      </button>
    </header>

    <div ref="scroller" class="flex-1 overflow-y-auto" @scroll="onScroll">
      <!-- Root message, pinned at the top of the thread. -->
      <div v-if="displayRoot" class="border-b border-subtle" data-testid="thread-root">
        <MessageItem
          :message="displayRoot"
          @react="onReact"
          @edit-start="onEditStart"
          @edit-submit="onEditSubmit"
          @edit-cancel="onEditCancel"
          @delete="onDelete"
          @retry="thread.retry"
          @discard="thread.discard"
        />
      </div>

      <div
        v-if="participants.length > 0"
        class="px-4 py-1 text-xs text-muted"
        data-testid="thread-participants"
      >
        {{ participants.length }}
        {{ participants.length === 1 ? 'participant' : 'participants' }}
      </div>

      <!-- Replies, oldest→newest. -->
      <div v-for="reply in displayReplies" :key="reply.message_id" data-testid="thread-reply">
        <MessageItem
          :message="reply"
          :editing="reply.message_id === editingMessageId"
          @react="onReact"
          @edit-start="onEditStart"
          @edit-submit="onEditSubmit"
          @edit-cancel="onEditCancel"
          @delete="onDelete"
          @retry="thread.retry"
          @discard="thread.discard"
        />
      </div>
    </div>

    <!-- Compact in-thread composer: reuses MessageComposer (mentions supported). -->
    <div data-testid="thread-composer">
      <MessageComposer
        placeholder="Reply…"
        :disabled="!displayRoot"
        :mention-items="mentionItems"
        :stream-id="streamId ?? undefined"
        @send="onSendReply"
      />
    </div>
  </aside>
</template>
