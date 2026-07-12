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
// main panel between the live conversation timeline, the REAL Inbox triage view
// (ENG-136 — the single triage surface; Feeds folded in), and the REAL Admin
// (ENG-151), Files (ENG-152) and Apps (ENG-176) surfaces. No message data ever
// comes from the HTTP API — the shell reads exclusively through the worker
// client (via stores).
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

import type { CommandItem, QuickItem } from '../components/shell/CommandPalette.vue'
import { resolveWorkerClient } from './useWorkerClient'
import { useSidebarCollapse } from './useSidebarCollapse'
import { useTheme } from './useTheme'
import { buildCommands } from '../lib/commands'
import { dmDisplayName, dmOtherUserId } from '../lib/dm'
import { activeStatus } from '../lib/status'
import { useAuthStore } from '../stores/auth'
import { useMessagesStore } from '../stores/messages'
import { useNotificationsStore } from '../stores/notifications'
import { usePresenceStore } from '../stores/presence'
import { useSyncStore } from '../stores/sync'
import { useThreadStore } from '../stores/thread'
import { useWorkspaceStore, type SidebarStream } from '../stores/workspace'

import type { DirectoryUser, PresenceStatus } from '../worker'

/** Which panel the main column renders: the live timeline or a section view
 * (every section is REAL now — Inbox ENG-136, Admin ENG-151, Files ENG-152,
 * Apps ENG-176; no scaffold placeholders remain). */
export type ActiveView = 'conversation' | 'inbox' | 'apps' | 'files' | 'admin'

/** The Admin surface's tab keys — shared by AdminView and the sidebar's SPLIT
 * Admin nav items ("Members & invites" / "Workspace"), which deep-target a tab.
 * Defined HERE (not in AdminView.vue) so plain .ts consumers avoid importing a
 * type through the ambient `*.vue` module shim. */
export type AdminTab = 'members' | 'invites' | 'workspace'

/**
 * What the right drawer hosts (ENG-136 details drawer). The two panels are
 * MUTUALLY EXCLUSIVE: opening a thread closes the details drawer and vice versa.
 * `'thread'` derives from the thread store's `isOpen` (so thread open/close
 * behavior — including the synchronous close — is EXACTLY the pre-details flow).
 */
export type DrawerMode = 'none' | 'thread' | 'details' | 'user'

/** Fallback shown until the real workspace name syncs (the genesis
 * `workspace.created` fold — ENG-152); neutral, NOT "Ranin". */
const WORKSPACE_NAME_FALLBACK = 'Workspace'

export function useShellController() {
  const router = useRouter()
  const auth = useAuthStore()
  const workspace = useWorkspaceStore()
  const messages = useMessagesStore()
  const thread = useThreadStore()
  const sync = useSyncStore()
  const presence = usePresenceStore()
  const notifications = useNotificationsStore()

  const { myUserId, role } = storeToRefs(auth)
  // Live presence snapshot (ENG-128): `user_id → status`, ephemeral + worker-owned.
  // Consumed here for the DM header dot (message rows carry NO presence dot —
  // ENG-152 conversation-pane cleanup).
  const { statuses: presenceStatuses } = storeToRefs(presence)
  const {
    selectedStream,
    selectedStreamId,
    channels,
    dms,
    mentionItems,
    directory,
    workspaceInfo,
  } = storeToRefs(workspace)
  const { displayMessages, hasMore, rows: messageRows, currentStreamId } = storeToRefs(messages)
  const { isOpen: threadOpen } = storeToRefs(thread)

  const paletteOpen = ref(false)
  /** Palette-triggered dialog/overlay flags (ENG-136 command actions). The
   * TopBar's search/compose route through the SAME flags, so each surface stays
   * single-instance regardless of which entry point opened it. */
  const createChannelOpen = ref(false)
  const channelBrowserOpen = ref(false)
  const newDmOpen = ref(false)
  const searchOpen = ref(false)
  /** The message currently in inline edit (ENG-102); null = none. */
  const editingMessageId = ref<string | null>(null)
  /** Which main panel is active: the conversation timeline vs a section view. */
  const activeView: Ref<ActiveView> = ref('conversation')

  /**
   * Left-sidebar collapse (ENG-174): persisted manual toggle + responsive
   * auto-collapse below the narrow breakpoint. Toggled by the sidebar-header
   * control, the TopBar expand affordance, and ⌘\ / Ctrl+\ below.
   */
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebarCollapse()

  /** Whether the channel Details drawer is requested open (ENG-136). */
  const detailsOpen = ref(false)

  /**
   * The user whose details panel is open (ENG-152), or null. This is an OVERLAY:
   * it does not clear the thread/details state, so closing it (→ null) restores
   * whatever the drawer was showing before — "close returns to the prior state".
   */
  const detailsUserId = ref<string | null>(null)

  /**
   * The single drawer-mode truth the shell lays out on. User-details WINS (it is
   * an on-demand overlay the user just clicked into), then thread (opened through
   * any path — including directly on the store — displaces the channel details),
   * then the channel `'details'` when requested, else `'none'`.
   */
  const drawerMode = computed<DrawerMode>(() => {
    if (detailsUserId.value !== null) return 'user'
    if (threadOpen.value) return 'thread'
    return detailsOpen.value ? 'details' : 'none'
  })

  /** The directory record the user-details panel renders (name-only stub when the
   * directory has no record yet), or null when no user panel is open. */
  const detailsUser = computed<DirectoryUser | null>(() => {
    const id = detailsUserId.value
    if (id === null) return null
    return workspace.userOf(id) ?? { user_id: id, display_name: workspace.displayNameOf(id) }
  })

  /** Live presence for the user-details panel (`offline` when unknown). */
  const detailsPresence = computed<PresenceStatus>(() => {
    const id = detailsUserId.value
    return id === null ? 'offline' : (presenceStatuses.value.get(id) ?? 'offline')
  })

  /** Read-only role for the user-details panel — known only for the signed-in
   * user (the directory carries no other member's role), so `undefined` for others. */
  const detailsRole = computed<string | undefined>(() =>
    detailsUserId.value !== null && detailsUserId.value === myUserId.value
      ? (role.value ?? undefined)
      : undefined,
  )

  /** Open the right-drawer user-details panel for a member (ENG-152). Overlay: the
   * prior thread/details state is preserved and restored on close. */
  function openUserDetails(userId: string): void {
    detailsUserId.value = userId
  }

  /** Close the user-details overlay, revealing the prior drawer state. */
  function closeUserDetails(): void {
    detailsUserId.value = null
  }

  // Mutual exclusion, store-side: a thread opened directly on the thread store
  // (not just via onOpenThread) still closes the details drawer.
  watch(threadOpen, (open) => {
    if (open) detailsOpen.value = false
  })

  /** Admin section is only offered to privileged roles. */
  const canAdmin = computed(() => role.value === 'admin' || role.value === 'owner')

  /**
   * Which AdminView tab is (or should be) showing — the deep-target seam for
   * the sidebar's SPLIT Admin nav ("Members & invites" → members/invites,
   * "Workspace" → workspace settings). Fed to AdminView as `initialTab` and
   * kept honest by its `tabChange` events, so the sidebar highlight tracks
   * in-view tab switches too.
   */
  const adminTab = ref<AdminTab>('members')

  /** Open the Admin surface deep-targeted at a tab (the sidebar Admin items). */
  function openAdmin(tab: AdminTab): void {
    adminTab.value = tab
    setActiveView('admin')
  }

  /** AdminView reported a user tab click — mirror it for the sidebar state. */
  function onAdminTabChange(tab: AdminTab): void {
    adminTab.value = tab
  }

  /** The REAL workspace name (ENG-152) — folded from the cached workspace-meta
   * events (`workspace.created`, then any admin `workspace.updated` renames);
   * the neutral fallback until the genesis event has synced. */
  const workspaceName = computed(() => workspaceInfo.value.name ?? WORKSPACE_NAME_FALLBACK)
  /** Up-to-two-letter glyph for the rail, derived from the workspace name. */
  const workspaceInitials = computed(() => workspaceName.value.slice(0, 2).toUpperCase())
  /** ENG-152: the workspace icon ref (folded from `workspace.updated`) — the
   * rail/switcher render the icon IMAGE (worker-fetched by sha) when set, else
   * the initials glyph. `undefined` (not `null`) when absent, matching the
   * `useWorkspaceIconUrl` getter contract. */
  const workspaceIconSha = computed(() => workspaceInfo.value.icon_sha256 ?? undefined)

  /**
   * Directory-backed `user_id → display_name` map (ENG-136) — threaded to the
   * message list for author names + avatar initials, and the DM label source
   * (ENG-149). Rebuilt when the workspace directory refreshes; the raw id is the
   * fallback in the view.
   */
  const names = computed<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>()
    for (const u of directory.value.users) map.set(u.user_id, u.display_name)
    return map
  })

  /**
   * Directory-backed `user_id → avatar_sha256` map (ENG-152) — threaded down
   * the SAME paths as `names`, so a message row can render the author's avatar
   * IMAGE (worker-fetched by user id + sha) instead of the initials chip.
   * Users without an avatar are simply absent (→ initials fallback).
   */
  const avatars = computed<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>()
    for (const u of directory.value.users) {
      if (u.avatar_sha256 !== undefined) map.set(u.user_id, u.avatar_sha256)
    }
    return map
  })

  /** A DM stream's label: the OTHER participant's name (ENG-149), else name/id. */
  function dmLabel(s: SidebarStream): string {
    return dmDisplayName(s.dm_user_ids, myUserId.value, names.value) ?? s.name ?? s.stream_id
  }

  const headerLabel = computed(() => {
    const s = selectedStream.value
    if (!s) return ''
    return s.kind === 'dm' ? dmLabel(s) : `# ${s.name ?? s.stream_id}`
  })

  /** Title shown in the channel-header for the current view (Inbox brings its own). */
  const mainTitle = computed(() => {
    if (activeView.value === 'conversation') return headerLabel.value || 'No channel selected'
    if (activeView.value === 'inbox') return 'Inbox'
    if (activeView.value === 'admin') return 'Admin'
    if (activeView.value === 'files') return 'Files'
    return 'Apps'
  })

  /**
   * The selected DM counterpart's live presence for the header dot (ENG-149) —
   * `undefined` (no dot) for channels, non-conversation views, and a DM whose
   * participants are unresolvable (no cached genesis / group DM).
   */
  const headerPresence = computed<PresenceStatus | undefined>(() => {
    if (activeView.value !== 'conversation') return undefined
    const s = selectedStream.value
    if (!s || s.kind !== 'dm') return undefined
    const other = dmOtherUserId(s.dm_user_ids, myUserId.value)
    if (other === undefined) return undefined
    return presenceStatuses.value.get(other) ?? 'offline'
  })

  /**
   * Whether the conversation header describes a DM (ENG-172) — flips its subline
   * from the channel member/topic scaffold to the counterpart's status line.
   * 'channel' for every non-conversation view (Admin/Files/Apps keep the
   * channel-shaped header they already had).
   */
  const headerKind = computed<'channel' | 'dm'>(() =>
    activeView.value === 'conversation' && selectedStream.value?.kind === 'dm' ? 'dm' : 'channel',
  )

  /**
   * The DM header subline (ENG-172): the counterpart's ACTIVE custom status
   * (lazy-expiry applied at render time — ENG-164) followed by their live
   * presence label. `undefined` for channels and for a DM whose counterpart is
   * unresolvable (no cached genesis / group DM) — the header then shows no subline.
   */
  const headerSubtitle = computed<string | undefined>(() => {
    if (headerKind.value !== 'dm') return undefined
    const s = selectedStream.value
    const other = s ? dmOtherUserId(s.dm_user_ids, myUserId.value) : undefined
    if (other === undefined) return undefined
    const presenceLabel =
      (presenceStatuses.value.get(other) ?? 'offline') === 'online' ? 'Active now' : 'Offline'
    const status = activeStatus(workspace.userOf(other))
    const statusText = status ? [status.emoji, status.text].filter(Boolean).join(' ') : ''
    return statusText ? `${statusText} · ${presenceLabel}` : presenceLabel
  })

  /**
   * SCAFFOLD member count for the channel header (ENG-136) — a stand-in using the
   * workspace directory user count. A per-channel roster query is a later follow-up;
   * the header labels this honestly as an approximation.
   */
  const memberCount = computed(() => directory.value.users.length)

  /** INTERIM unread count for the "New" divider (see MessageList's `unreadCount`). */
  const unreadCount = computed(() => selectedStream.value?.unread ?? 0)

  const composerPlaceholder = computed(() =>
    selectedStream.value ? `Message ${headerLabel.value}` : 'Select a channel',
  )

  /** Quick-switch targets: channels then DMs (DMs labeled by participant, ENG-149). */
  const quickItems = computed<QuickItem[]>(() =>
    [...channels.value, ...dms.value].map((s) => ({
      id: s.stream_id,
      label: s.kind === 'dm' ? dmLabel(s) : (s.name ?? s.stream_id),
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

  // -- Mark-read on channel view (ENG-129) ----------------------------------
  //
  // The stream shown in the conversation panel (null on the section views).
  // Threaded to the notifications store so the decision matrix can suppress
  // toasts for the conversation the user is already looking at.
  const activeConversationId = computed(() =>
    activeView.value === 'conversation' ? selectedStreamId.value : null,
  )
  watch(activeConversationId, (id) => notifications.setActiveStream(id), { immediate: true })

  /** Newest SETTLED seq in the loaded window (pending rows carry a ms-epoch
   * sentinel `created_seq` and must never advance read-state). 0 = nothing. */
  const latestLoadedSeq = computed(() => {
    if (currentStreamId.value !== selectedStreamId.value) return 0
    let max = 0
    for (const r of messageRows.value) {
      if (r.state === undefined && r.created_seq > max) max = r.created_seq
    }
    return max
  })

  /**
   * What to mark read: the ACTIVE conversation up to the stream's `head_seq`
   * (the badge is `head_seq − last_read_seq`, so marking only the newest
   * message seq would leave a trailing reaction/edit event counted as unread),
   * falling back to the newest loaded settled message seq when the projection's
   * stream row lags. Fires on open/focus AND when a new message lands while the
   * stream is active — so the badge stays cleared while you're looking at it.
   */
  const markTarget = computed(() => {
    const id = activeConversationId.value
    if (!id) return null
    const head = selectedStream.value?.head_seq ?? 0
    const seq = Math.max(head, latestLoadedSeq.value)
    return seq > 0 ? { id, seq } : null
  })
  /** Last seq marked per stream — dedupes the (monotonic) worker mark RPC. */
  const lastMarked = new Map<string, number>()
  watch(markTarget, (target) => {
    if (!target) return
    if ((lastMarked.get(target.id) ?? 0) >= target.seq) return
    lastMarked.set(target.id, target.seq)
    void resolveWorkerClient().then((client) => client.readState.mark(target.id, target.seq))
  })

  /** Flip the main panel to a section (Inbox/Apps/Files/Admin) or the timeline. */
  function setActiveView(view: ActiveView): void {
    // Navigating away from the conversation closes any open drawer (thread OR
    // details) so neither docks beside a non-conversation panel (PR-B review #4).
    if (view !== 'conversation') {
      thread.close()
      detailsOpen.value = false
    }
    activeView.value = view
  }

  /**
   * ChannelHeader's details button (ENG-136): toggle the Details drawer for the
   * selected stream. Opening it displaces any open thread (mutual exclusion);
   * a second press closes it. Only meaningful on the conversation view with a
   * selected stream — otherwise a no-op.
   */
  function toggleDetails(): void {
    if (detailsOpen.value) {
      detailsOpen.value = false
      return
    }
    if (activeView.value !== 'conversation' || !selectedStream.value) return
    thread.close()
    detailsOpen.value = true
  }

  /** The Details drawer's ✕ (or any programmatic close). */
  function closeDetails(): void {
    detailsOpen.value = false
  }

  /**
   * After the user LEFT the selected channel from the Details drawer (the
   * `channel.removeMember(streamId, myUserId)` mutation already ran): close the
   * drawer and, if the stream dropped out of the sidebar, gracefully select the
   * first remaining channel (else DM, else nothing).
   */
  function onChannelLeft(): void {
    detailsOpen.value = false
    const id = selectedStreamId.value
    const stillVisible =
      id !== null &&
      [...channels.value, ...dms.value].some((s: { stream_id: string }) => s.stream_id === id)
    if (!stillVisible) {
      const next = channels.value[0] ?? dms.value[0]
      workspace.selectedStreamId = next ? next.stream_id : null
    }
  }

  /**
   * "Close conversation" on a DM's Details panel (ENG-172): close the drawer and
   * navigate away from the DM — select the first channel (else nothing). There is
   * no hide/archive semantics for a DM yet, so the row stays in the sidebar; this
   * is honestly just "stop looking at this conversation".
   */
  function onDmClosed(): void {
    detailsOpen.value = false
    const next = channels.value[0]
    workspace.selectedStreamId = next ? next.stream_id : null
  }

  /**
   * Global shortcuts (ENG-152 nav cleanup): ⌘K/Ctrl+K TOGGLES the command
   * palette (actions + navigation); ⌘//Ctrl+/ opens the unified search modal.
   * Each closes the other — both are full-screen z-50 overlays, so leaving the
   * other open would stack them (the later-mounted search would hide the
   * palette). ⌘\/Ctrl+\ toggles the left sidebar (ENG-174 — no collision with
   * the palette/search bindings).
   */
  function onGlobalKeydown(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() === 'k') {
      event.preventDefault()
      searchOpen.value = false
      paletteOpen.value = !paletteOpen.value
    } else if (event.key === '/') {
      event.preventDefault()
      paletteOpen.value = false
      searchOpen.value = true
    } else if (event.key === '\\') {
      event.preventDefault()
      toggleSidebar()
    }
  }

  function onPaletteSelect(streamId: string): void {
    workspace.selectStream(streamId)
    activeView.value = 'conversation'
    paletteOpen.value = false
  }

  // -- Palette commands (ENG-136) --------------------------------------------
  //
  // The registry (lib/commands.ts) is pure; every seam below is an EXISTING
  // shell behavior — dialog flags, view flips, useTheme, the logout flow. The
  // palette only ever sees display descriptors + emits `run(id)` back here.

  /**
   * "Channel notification settings": open the Details drawer (its Notifications
   * area, ENG-129) for the active channel. Gated by `available()` below, but
   * defensively re-checked here.
   */
  function openChannelNotifications(): void {
    if (activeView.value !== 'conversation' || !selectedStream.value) return
    thread.close()
    detailsOpen.value = true
  }

  const { cycleTheme } = useTheme()

  const commands = buildCommands({
    openCreateChannel: () => (createChannelOpen.value = true),
    openNewDm: () => (newDmOpen.value = true),
    openChannelBrowser: () => (channelBrowserOpen.value = true),
    openSearch: () => (searchOpen.value = true),
    cycleTheme,
    goToInbox: () => setActiveView('inbox'),
    openChannelNotifications,
    hasActiveChannel: () =>
      activeView.value === 'conversation' && selectedStream.value?.kind === 'channel',
    signOut: () => void onLogout(),
  })

  /** The palette's Commands group: display descriptors for AVAILABLE commands
   * (context-gated ones — e.g. channel notifications — drop out reactively). */
  const paletteCommands = computed<CommandItem[]>(() =>
    commands
      .filter((c) => c.available?.() ?? true)
      .map(({ id, title, icon, keywords }) => ({ id, title, icon, keywords })),
  )

  /** Run a palette command by id (Enter/click on a Commands row): close the
   * palette, then fire the seam. Unknown/unavailable ids are a no-op. */
  function onPaletteCommand(id: string): void {
    const command = commands.find((c) => c.id === id)
    if (!command || !(command.available?.() ?? true)) return
    paletteOpen.value = false
    command.run()
  }

  /**
   * Open a stream (Inbox triage row, search jump, toast click — ENG-136/129):
   * select it + flip the main panel to the conversation. Explicit `activeView`
   * set because re-opening the ALREADY-selected stream must still leave the
   * Inbox (the selection watch only fires on a changed id). Read-state marks
   * automatically through the `markTarget` watch above (ENG-129 — the earlier
   * "no tab-side mark-read yet" note is resolved).
   */
  function onOpenStream(streamId: string): void {
    workspace.selectStream(streamId)
    activeView.value = 'conversation'
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
    if (!streamId) return
    // Mutual exclusion, synchronously: the thread displaces the details drawer.
    detailsOpen.value = false
    void thread.openThread(rootMessageId, streamId)
  }

  async function onLogout(): Promise<void> {
    await auth.logout()
    await router.push('/login')
  }

  onMounted(async () => {
    messages.setMyUserId(myUserId.value ?? '')
    thread.setMyUserId(myUserId.value ?? '')
    void sync.start()
    // REAL presence (ENG-126): subscribe to the ephemeral snapshot; the footer
    // UserCard dot reads the signed-in user's status (online by default).
    void presence.start(myUserId.value)
    // Notifications (ENG-129): toast/Notification decisions off new inbound
    // messages; toast + Notification clicks jump through the shell's open-stream.
    notifications.setJumpHandler(onOpenStream)
    void notifications.start(myUserId.value ?? '')
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
    presence.stop()
    notifications.stop()
  })

  return {
    // stores (for template method refs — e.g. messages.loadOlder/retry/discard)
    messages,
    // reactive state
    activeView,
    paletteOpen,
    createChannelOpen,
    channelBrowserOpen,
    newDmOpen,
    searchOpen,
    editingMessageId,
    canAdmin,
    // Admin deep-target (sidebar Admin split)
    adminTab,
    openAdmin,
    onAdminTabChange,
    workspaceName,
    workspaceInitials,
    workspaceIconSha,
    // sidebar collapse (ENG-174)
    sidebarCollapsed,
    toggleSidebar,
    // store-derived refs
    myUserId,
    selectedStream,
    selectedStreamId,
    channels,
    dms,
    mentionItems,
    displayMessages,
    hasMore,
    threadOpen,
    drawerMode,
    // user-details drawer (ENG-152)
    detailsUserId,
    detailsUser,
    detailsPresence,
    detailsRole,
    openUserDetails,
    closeUserDetails,
    // computed view state
    headerLabel,
    headerPresence,
    headerKind,
    headerSubtitle,
    mainTitle,
    names,
    avatars,
    memberCount,
    unreadCount,
    composerPlaceholder,
    quickItems,
    paletteCommands,
    // handlers
    setActiveView,
    toggleDetails,
    closeDetails,
    onChannelLeft,
    onDmClosed,
    onPaletteSelect,
    onPaletteCommand,
    onOpenStream,
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
