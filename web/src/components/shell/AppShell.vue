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
import { ref } from 'vue'

import AppSidebar from './AppSidebar.vue'
import ChannelHeader from './ChannelHeader.vue'
import CommandPalette from './CommandPalette.vue'
import InboxView from './InboxView.vue'
import MessageComposer from './MessageComposer.vue'
import MessageList from './MessageList.vue'
import NewDmDialog from './NewDmDialog.vue'
import RightDrawer from './RightDrawer.vue'
import SpaceRail from './SpaceRail.vue'
import TopBar from './TopBar.vue'
import EmptyState from '../ui/EmptyState.vue'
import { useShellController } from '../../composables/useShellController'

const {
  messages,
  activeView,
  paletteOpen,
  editingMessageId,
  canAdmin,
  workspaceName,
  workspaceInitials,
  selectedStream,
  selectedStreamId,
  mentionItems,
  displayMessages,
  hasMore,
  threadOpen,
  mainTitle,
  names,
  memberCount,
  unreadCount,
  scaffold,
  composerPlaceholder,
  quickItems,
  setActiveView,
  openPalette,
  onPaletteSelect,
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

/** TopBar compose → open a New DM (REAL: compose maps to "new direct message"). */
const showCompose = ref(false)

/** SCAFFOLD: the add-member affordance lives in the sidebar's channel settings
 * today; the header's button is a forward hook (details drawer lands in a later PR). */
function onHeaderAddMember(): void {
  // No-op scaffold — a real add-member entry point is wired in a follow-up.
}
function onToggleDetails(): void {
  // No-op scaffold — the details drawer is a later PR.
}
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
      @open-switcher="openPalette"
      @select-view="setActiveView"
    />

    <!-- Right: a top-bar row spanning the main + drawer region, then the columns. -->
    <div class="flex min-w-0 flex-1 flex-col">
      <TopBar @search="openPalette" @compose="showCompose = true" />

      <div
        class="grid min-h-0 flex-1"
        :class="threadOpen ? 'grid-cols-[1fr_24rem]' : 'grid-cols-[1fr]'"
      >
        <!-- Main column. The Inbox brings its own header + tabs, so the shared
             channel-header is skipped for it (preserved for every other view). -->
        <main role="main" class="flex min-h-0 min-w-0 flex-col">
          <ChannelHeader
            v-if="activeView !== 'inbox'"
            :title="mainTitle"
            :member-count="memberCount"
            @add-member="onHeaderAddMember"
            @toggle-details="onToggleDetails"
          />

          <!-- Live conversation timeline (real channel/DM). -->
          <template v-if="activeView === 'conversation'">
            <MessageList
              :messages="displayMessages"
              :names="names"
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

          <!-- Scaffold placeholder (Apps / Files / Admin). -->
          <div v-else class="flex flex-1 items-center justify-center">
            <EmptyState v-if="scaffold" :title="scaffold.title" :description="scaffold.body" />
          </div>
        </main>

        <!-- Drawer column (M3 thread pane, ENG-103) — only while a thread is open. -->
        <RightDrawer :open="threadOpen" />
      </div>
    </div>

    <CommandPalette
      :open="paletteOpen"
      :items="quickItems"
      @select="onPaletteSelect"
      @close="paletteOpen = false"
    />

    <!-- REAL compose target: a New DM dialog opened from the TopBar compose button. -->
    <NewDmDialog v-if="showCompose" @close="showCompose = false" />
  </div>
</template>
