// useShellController — ENG-136 "Ranin" shell orchestration (PR-B).
//
// Extracts ShellView's cross-store wiring into a single composable so BOTH the
// current `ShellView` (PR-B) and the future `AppShell` (PR-C) consume identical
// behavior — the view swap becomes a pure reshuffle, not a rewrite. This is a
// MECHANICAL extraction: the data flow is unchanged from the original ShellView.
//
// It owns cross-store wiring only: workspace selection drives the messages store
// (a ZERO-network projection read), the global Cmd+K opens the palette, the sync
// store feeds the reconnect indicator, and a lightweight `activeView` flips the
// main panel between the live conversation timeline and the scaffold placeholder
// sections (Inbox / Feeds / Apps / Admin). No message data ever comes from the
// HTTP API — the shell reads exclusively through the worker client (via stores).
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

import type { QuickItem } from '../components/shell/CommandPalette.vue'
import { useAuthStore } from '../stores/auth'
import { useMessagesStore } from '../stores/messages'
import { useSyncStore } from '../stores/sync'
import { useThreadStore } from '../stores/thread'
import { useWorkspaceStore } from '../stores/workspace'

/** Which panel the main column renders: the live timeline vs a scaffold section. */
export type ActiveView = 'conversation' | 'inbox' | 'feeds' | 'apps' | 'admin'

/** The neutral workspace name shown in the sidebar header + rail glyph (NOT "Ranin"). */
const WORKSPACE_NAME = 'msg'

/** Copy for the scaffold placeholder EmptyState shown in the main panel. */
const SCAFFOLD_COPY: Record<
  Exclude<ActiveView, 'conversation'>,
  { title: string; body: string }
> = {
  inbox: { title: 'Inbox', body: 'A unified inbox of your unreads and mentions is on the way.' },
  feeds: { title: 'Feeds', body: 'Feeds are coming soon.' },
  apps: { title: 'Apps', body: 'Apps are coming soon.' },
  admin: { title: 'Admin', body: 'Workspace administration is coming soon.' },
}

export function useShellController() {
  const router = useRouter()
  const auth = useAuthStore()
  const workspace = useWorkspaceStore()
  const messages = useMessagesStore()
  const thread = useThreadStore()
  const sync = useSyncStore()

  const { myUserId, role } = storeToRefs(auth)
  const { selectedStream, selectedStreamId, channels, dms, mentionItems } = storeToRefs(workspace)
  const { displayMessages, hasMore } = storeToRefs(messages)
  const { isOpen: threadOpen } = storeToRefs(thread)

  const paletteOpen = ref(false)
  /** The message currently in inline edit (ENG-102); null = none. */
  const editingMessageId = ref<string | null>(null)
  /** Which main panel is active: the conversation timeline vs a scaffold section. */
  const activeView: Ref<ActiveView> = ref('conversation')

  /** Admin section is only offered to privileged roles. */
  const canAdmin = computed(() => role.value === 'admin' || role.value === 'owner')

  const workspaceName = WORKSPACE_NAME
  /** Up-to-two-letter glyph for the rail (neutral, derived from the workspace name). */
  const workspaceInitials = computed(() => WORKSPACE_NAME.slice(0, 2).toUpperCase())

  const headerLabel = computed(() => {
    const s = selectedStream.value
    if (!s) return ''
    const name = s.name ?? s.stream_id
    return s.kind === 'dm' ? name : `# ${name}`
  })

  /** Title shown in the channel-header for the current view. */
  const mainTitle = computed(() => {
    if (activeView.value === 'conversation') return headerLabel.value || 'No channel selected'
    return SCAFFOLD_COPY[activeView.value].title
  })

  /** Copy for the scaffold EmptyState (null when a conversation is shown). */
  const scaffold = computed(() =>
    activeView.value === 'conversation' ? null : SCAFFOLD_COPY[activeView.value],
  )

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
      if (id) {
        void messages.selectStream(id)
        activeView.value = 'conversation'
      }
      // A thread belongs to one stream; switching streams closes the pane.
      thread.close()
    },
    { immediate: false },
  )

  /** Flip the main panel to a scaffold section (Inbox/Feeds/Apps/Admin) or the timeline. */
  function setActiveView(view: ActiveView): void {
    // Navigating to a scaffold view closes any open thread so the drawer doesn't dock
    // beside a placeholder (PR-B review #4). The conversation view keeps its thread.
    if (view !== 'conversation') thread.close()
    activeView.value = view
  }

  function openPalette(): void {
    paletteOpen.value = true
  }

  function onGlobalKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      paletteOpen.value = true
    }
  }

  function onPaletteSelect(streamId: string): void {
    workspace.selectStream(streamId)
    activeView.value = 'conversation'
    paletteOpen.value = false
  }

  function onSend(text: string, mentions: string[], fileIds: string[]): void {
    void messages.send(text, mentions, fileIds)
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

  /**
   * Open the thread pane on a root (ENG-103) — the reply-count affordance or a
   * "Reply in thread" action. The root is in the selected stream; a re-open of the
   * same root is a no-op in the store.
   */
  function onOpenThread(rootMessageId: string): void {
    const streamId = selectedStreamId.value
    if (streamId) void thread.openThread(rootMessageId, streamId)
  }

  async function onLogout(): Promise<void> {
    await auth.logout()
    await router.push('/login')
  }

  onMounted(async () => {
    messages.setMyUserId(myUserId.value ?? '')
    thread.setMyUserId(myUserId.value ?? '')
    void sync.start()
    await workspace.load()
    if (selectedStreamId.value) void messages.selectStream(selectedStreamId.value)
    window.addEventListener('keydown', onGlobalKeydown)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onGlobalKeydown)
    workspace.dispose()
    messages.dispose()
    thread.dispose()
    sync.stop()
  })

  return {
    // stores (for template method refs — e.g. messages.loadOlder/retry/discard)
    messages,
    // reactive state
    activeView,
    paletteOpen,
    editingMessageId,
    canAdmin,
    workspaceName,
    workspaceInitials,
    // store-derived refs
    selectedStream,
    selectedStreamId,
    channels,
    dms,
    mentionItems,
    displayMessages,
    hasMore,
    threadOpen,
    // computed view state
    headerLabel,
    mainTitle,
    scaffold,
    composerPlaceholder,
    quickItems,
    // handlers
    setActiveView,
    openPalette,
    onPaletteSelect,
    onSend,
    onEditLast,
    onReact,
    onEditStart,
    onEditSubmit,
    onEditCancel,
    onDeleteMessage,
    onOpenThread,
    onLogout,
  }
}
