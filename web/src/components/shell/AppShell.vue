<script setup lang="ts">
// AppShell — the authed app shell (ENG-82, TDD §5.4; ENG-136 "Ranin" PR-C).
//
// PR-3 lays the shell out as: a left region (SpaceRail + feed-first AppSidebar,
// each full height) beside a right region that stacks a full-width TopBar row over
// the main + drawer columns. The main/drawer pair is a nested grid whose 24rem
// drawer track appears only while a thread is open (a clean, resize-friendly grid);
// the TopBar deliberately spans ONLY the main + drawer region, never the rail or
// sidebar — matching the reference mockup.
//
// Behavior and every load-bearing E2E test-id are preserved: it composes SpaceRail
// | AppSidebar | TopBar | main (channel-header + virtualized MessageList +
// MessageComposer, OR the REAL InboxView triage page — ENG-136, the Feeds concept
// folded into Inbox — OR a scaffold EmptyState) | RightDrawer (thread) + the
// CommandPalette overlay, and delegates ALL cross-store wiring to
// `useShellController`. The Inbox brings its own header + filter tabs, so the
// ChannelHeader is skipped for it. No message data ever comes from the HTTP API —
// the shell reads exclusively through the worker client (via the stores).
import { computed, nextTick, ref } from 'vue'

import AppSidebar from './AppSidebar.vue'
import ChannelBrowser from './ChannelBrowser.vue'
import ChannelHeader from './ChannelHeader.vue'
import ChannelSettingsDialog from './ChannelSettingsDialog.vue'
import CommandPalette from './CommandPalette.vue'
import CreateChannelDialog from './CreateChannelDialog.vue'
import InboxView from './InboxView.vue'
import MessageComposer from './MessageComposer.vue'
import MessageList from './MessageList.vue'
import NewDmDialog from './NewDmDialog.vue'
import RightDrawer from './RightDrawer.vue'
import SearchOverlay from './SearchOverlay.vue'
import SpaceRail from './SpaceRail.vue'
import ToastContainer from './ToastContainer.vue'
import AdminView from '../admin/AdminView.vue'
import FilesView from '../files/FilesView.vue'
import TopBar from './TopBar.vue'
import TypingIndicator from './TypingIndicator.vue'
import EmptyState from '../ui/EmptyState.vue'
import { useShellController } from '../../composables/useShellController'
import { provideOpenUserDetails } from '../../composables/useUserDetails'
import type { SidebarStream } from '../../stores/workspace'

const {
  messages,
  activeView,
  paletteOpen,
  createChannelOpen,
  channelBrowserOpen,
  newDmOpen,
  searchOpen,
  editingMessageId,
  canAdmin,
  workspaceName,
  workspaceInitials,
  myUserId,
  selectedStream,
  selectedStreamId,
  mentionItems,
  displayMessages,
  hasMore,
  drawerMode,
  detailsUser,
  detailsPresence,
  detailsRole,
  openUserDetails,
  closeUserDetails,
  mainTitle,
  headerPresence,
  names,
  avatars,
  memberCount,
  unreadCount,
  scaffold,
  composerPlaceholder,
  quickItems,
  paletteCommands,
  setActiveView,
  toggleDetails,
  closeDetails,
  onChannelLeft,
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
} = useShellController()

// ENG-152: any interactive avatar/name (message rows, sidebar DM rows) opens the
// right-drawer user-details panel through this provided seam — no prop-drilling.
provideOpenUserDetails(openUserDetails)

// ENG-152 nav cleanup: EVERY search entry point — the TopBar field, the
// sidebar's Search row, the palette's "Search" command, and the global ⌘/ —
// routes to the ONE unified search modal (SearchOverlay) via the controller's
// single `searchOpen` flag. ⌘K is the command palette, and the workspace pill
// opens the WorkspaceSwitcher's own menu (self-contained — no shell wiring).

/** The live MessageList, for the search jump's best-effort scroll-to-message. */
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)

/**
 * Search jump-to-message (ENG-127): close the overlay, select the hit's stream
 * (the shell's existing stream-select), then BEST-EFFORT scroll to the message.
 * The stream's window loads asynchronously, so we poll briefly; if the hit is
 * older than the loaded window we simply leave the channel open at its tail —
 * deep-loading pages around an arbitrary hit is a follow-up.
 */
async function onSearchJump(streamId: string, messageId: string): Promise<void> {
  searchOpen.value = false
  onOpenStream(streamId)
  for (let attempt = 0; attempt < 20; attempt++) {
    await nextTick()
    const list = messageListRef.value
    if (list && typeof list.scrollToMessage === 'function' && list.scrollToMessage(messageId)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The Details drawer's Members row → the EXISTING channel-settings dialog
 * (rename/archive + add/remove member, ENG-104), targeted at the selected stream. */
const settingsFor = ref<SidebarStream | null>(null)
function onOpenMembers(): void {
  if (selectedStream.value) settingsFor.value = selectedStream.value
}

/** Drawer grid column: 24rem for the thread (unchanged), 16rem (~250px) for
 * channel details, 18rem for the user-details profile (ENG-152). */
const gridCols = computed(() => {
  if (drawerMode.value === 'thread') return 'grid-cols-[1fr_24rem]'
  if (drawerMode.value === 'details') return 'grid-cols-[1fr_16rem]'
  if (drawerMode.value === 'user') return 'grid-cols-[1fr_18rem]'
  return 'grid-cols-[1fr]'
})
</script>

<template>
  <div role="application" class="flex h-screen w-screen overflow-hidden bg-background text-primary">
    <!-- Left: rail + sidebar span the full height. -->
    <SpaceRail
      :workspace-initials="workspaceInitials"
      :workspace-name="workspaceName"
      @logout="onLogout"
    />

    <AppSidebar
      :active-view="activeView"
      :workspace-name="workspaceName"
      :workspace-initials="workspaceInitials"
      :can-admin="canAdmin"
      @open-search="searchOpen = true"
      @select-view="setActiveView"
    />

    <!-- Right: a top-bar row spanning the main + drawer region, then the columns. -->
    <div class="flex min-w-0 flex-1 flex-col">
      <TopBar @search="searchOpen = true" />

      <div class="grid min-h-0 flex-1" :class="gridCols">
        <!-- Main column. The Inbox brings its own header + tabs, so the shared
             channel-header is skipped for it (preserved for every other view). -->
        <main role="main" class="flex min-h-0 min-w-0 flex-col">
          <ChannelHeader
            v-if="activeView !== 'inbox'"
            :title="mainTitle"
            :presence="headerPresence"
            :member-count="memberCount"
            @toggle-details="toggleDetails"
          />

          <!-- Live conversation timeline (real channel/DM). -->
          <template v-if="activeView === 'conversation'">
            <MessageList
              ref="messageListRef"
              :messages="displayMessages"
              :names="names"
              :avatars="avatars"
              :unread-count="unreadCount"
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
              @open-thread="onOpenThread"
            />

            <!-- Ephemeral "X is typing…" line (ENG-128), just above the composer. -->
            <TypingIndicator
              :stream-id="selectedStreamId"
              :names="names"
              :my-user-id="myUserId ?? undefined"
            />

            <MessageComposer
              :placeholder="composerPlaceholder"
              :disabled="!selectedStream"
              :mention-items="mentionItems"
              :stream-id="selectedStreamId ?? undefined"
              @send="onSend"
              @edit-last="onEditLast"
            />
          </template>

          <!-- REAL Inbox triage view (ENG-136): tabs over derived stream activity. -->
          <InboxView v-else-if="activeView === 'inbox'" @open-stream="onOpenStream" />

          <!-- REAL Admin surface (ENG-151 PR-3): members + pending invites over
               the `client.admin.*` worker RPCs; the view re-checks the role. -->
          <AdminView v-else-if="activeView === 'admin'" />

          <!-- REAL Files surface (ENG-152): the workspace file listing over the
               local `files` projection via `client.files.list` — zero HTTP here. -->
          <FilesView v-else-if="activeView === 'files'" />

          <!-- Scaffold placeholder (Apps). -->
          <div v-else class="flex flex-1 items-center justify-center">
            <EmptyState v-if="scaffold" :title="scaffold.title" :description="scaffold.body" />
          </div>
        </main>

        <!-- Drawer column: the thread pane (ENG-103) OR the channel Details panel
             (ENG-136/129) — mutually exclusive, keyed on the shell's drawerMode. -->
        <RightDrawer
          :mode="drawerMode"
          :stream="selectedStream"
          :user="detailsUser"
          :user-presence="detailsPresence"
          :user-role="detailsRole"
          @close="closeDetails"
          @open-members="onOpenMembers"
          @left="onChannelLeft"
          @close-user="closeUserDetails"
        />
      </div>
    </div>

    <CommandPalette
      :open="paletteOpen"
      :items="quickItems"
      :commands="paletteCommands"
      @select="onPaletteSelect"
      @run="onPaletteCommand"
      @close="paletteOpen = false"
    />

    <!-- The ONE unified search modal (ENG-127 server FTS via the worker's `search`
         RPC; ENG-152 unification) — opened from the top-bar field, the sidebar's
         Search row, the palette's "Search" command, or ⌘/. Jump closes it +
         selects the hit's stream. -->
    <SearchOverlay :open="searchOpen" @close="searchOpen = false" @jump="onSearchJump" />

    <!-- REAL compose target: a New DM dialog, opened from the sidebar's "+ New"
         menu OR the palette's "Start a direct message" command. -->
    <NewDmDialog v-if="newDmOpen" @close="newDmOpen = false" />

    <!-- Palette command targets (ENG-136): the EXISTING create-channel dialog +
         channel browser, shell-mounted so Cmd+K actions work from any view. -->
    <CreateChannelDialog v-if="createChannelOpen" @close="createChannelOpen = false" />
    <ChannelBrowser v-if="channelBrowserOpen" @close="channelBrowserOpen = false" />

    <!-- The Details drawer's Members row reuses the existing settings dialog. -->
    <ChannelSettingsDialog v-if="settingsFor" :stream="settingsFor" @close="settingsFor = null" />

    <!-- ENG-129 notification toasts: click jumps via the shell's open-stream. -->
    <ToastContainer @select="onOpenStream" />
  </div>
</template>
