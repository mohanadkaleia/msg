<script setup lang="ts">
// ShellView — the authed app shell (ENG-82, TDD §5.4). Composes the sidebar,
// virtualized message list, composer, and Cmd+K switcher over the worker RPC.
// It owns cross-store wiring only: workspace selection drives the messages store
// (a ZERO-network projection read), the global Cmd+K opens the palette, and the
// sync store feeds the reconnect indicator. No message data ever comes from the
// HTTP API — the shell reads exclusively through the worker client.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

import AppSidebar from '../components/shell/AppSidebar.vue'
import CommandPalette, { type QuickItem } from '../components/shell/CommandPalette.vue'
import MessageComposer from '../components/shell/MessageComposer.vue'
import MessageList from '../components/shell/MessageList.vue'
import { useAuthStore } from '../stores/auth'
import { useMessagesStore } from '../stores/messages'
import { useSyncStore } from '../stores/sync'
import { useWorkspaceStore } from '../stores/workspace'

const router = useRouter()
const auth = useAuthStore()
const workspace = useWorkspaceStore()
const messages = useMessagesStore()
const sync = useSyncStore()

const { myUserId } = storeToRefs(auth)
const { selectedStream, selectedStreamId, channels, dms, mentionItems } = storeToRefs(workspace)
const { displayMessages, hasMore } = storeToRefs(messages)

const paletteOpen = ref(false)
/** The message currently in inline edit (ENG-102); null = none. */
const editingMessageId = ref<string | null>(null)

const headerLabel = computed(() => {
  const s = selectedStream.value
  if (!s) return ''
  const name = s.name ?? s.stream_id
  return s.kind === 'dm' ? name : `# ${name}`
})

const composerPlaceholder = computed(() =>
  selectedStream.value ? `Message ${headerLabel.value}` : 'Select a channel',
)

/** Quick-switch targets: channels then DMs, in sidebar order. */
const quickItems = computed<QuickItem[]>(() =>
  [...channels.value, ...dms.value].map((s) => ({
    id: s.stream_id,
    label: s.name ?? s.stream_id,
    kind: s.kind,
    unread: s.unread,
  })),
)

// Selection → load that stream's messages (local projection read, no network).
watch(
  selectedStreamId,
  (id) => {
    if (id) void messages.selectStream(id)
  },
  { immediate: false },
)

function onGlobalKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    paletteOpen.value = true
  }
}

function onPaletteSelect(streamId: string): void {
  workspace.selectStream(streamId)
  paletteOpen.value = false
}

function onSend(text: string, mentions: string[]): void {
  void messages.send(text, mentions)
}

/**
 * SEAM (ENG-102): ArrowUp on an empty composer edits the user's last own message.
 * Loads it into the inline editor (Slack-style); a no-op when the user has no
 * editable message in the loaded window.
 */
function onEditLast(): void {
  const id = messages.lastOwnMessageId
  if (id) editingMessageId.value = id
}

/** Toggle YOUR reaction on a message (optimistic; idempotent). */
function onReact(messageId: string, emoji: string, remove: boolean): void {
  void messages.toggleReaction(messageId, emoji, remove)
}

/** Open the inline editor on a message. */
function onEditStart(messageId: string): void {
  editingMessageId.value = messageId
}

/** Commit an inline edit, then close the editor. */
function onEditSubmit(messageId: string, text: string): void {
  void messages.editMessage(messageId, text)
  editingMessageId.value = null
}

/** Abandon the inline edit. */
function onEditCancel(): void {
  editingMessageId.value = null
}

/** Soft-delete a message (confirmed in-UI; honest labeling lives in MessageItem). */
function onDeleteMessage(messageId: string): void {
  if (editingMessageId.value === messageId) editingMessageId.value = null
  void messages.deleteMessage(messageId)
}

async function onLogout(): Promise<void> {
  await auth.logout()
  await router.push('/login')
}

onMounted(async () => {
  messages.setMyUserId(myUserId.value ?? '')
  void sync.start()
  await workspace.load()
  if (selectedStreamId.value) void messages.selectStream(selectedStreamId.value)
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  workspace.dispose()
  messages.dispose()
  sync.stop()
})
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-white text-slate-900">
    <AppSidebar @open-switcher="paletteOpen = true" />

    <main class="flex min-w-0 flex-1 flex-col">
      <header
        class="flex items-center justify-between border-b border-slate-200 px-4 py-3"
        data-testid="channel-header"
      >
        <h1 class="truncate text-sm font-semibold text-slate-900">
          {{ headerLabel || 'No channel selected' }}
        </h1>
        <button
          type="button"
          class="rounded-md px-2 py-1 text-xs text-slate-500 hover:text-slate-900"
          data-testid="logout"
          @click="onLogout"
        >
          Sign out
        </button>
      </header>

      <MessageList
        :messages="displayMessages"
        :has-more="hasMore"
        :stream-key="selectedStreamId"
        :load-older="messages.loadOlder"
        :editing-message-id="editingMessageId"
        @retry="messages.retry"
        @discard="messages.discard"
        @react="onReact"
        @edit-start="onEditStart"
        @edit-submit="onEditSubmit"
        @edit-cancel="onEditCancel"
        @delete="onDeleteMessage"
      />

      <MessageComposer
        :placeholder="composerPlaceholder"
        :disabled="!selectedStream"
        :mention-items="mentionItems"
        @send="onSend"
        @edit-last="onEditLast"
      />
    </main>

    <CommandPalette
      :open="paletteOpen"
      :items="quickItems"
      @select="onPaletteSelect"
      @close="paletteOpen = false"
    />
  </div>
</template>
