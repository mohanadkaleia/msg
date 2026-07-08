<script setup lang="ts">
// AppShell — the authed app shell (ENG-82, TDD §5.4; ENG-136 "Ranin" PR-C).
//
// PR-C promotes the shell assembly out of `views/ShellView.vue` into a proper
// CSS-grid layout component. The regions are laid out on a single grid row with
// explicit tracks — rail | sidebar | main — and the right drawer appears as a
// fourth track only while a thread is open (a clean, resize-friendly grid rather
// than the old nested flex). The track widths match each region component's own
// width exactly (rail 3.5rem, sidebar 16rem, drawer 24rem), so the layout is
// pixel-identical to PR-B; ONLY the wrapping layout element changed.
//
// Behavior and every E2E test-id are IDENTICAL to the old ShellView: it composes
// SpaceRail | feed-first AppSidebar | main (channel-header + virtualized
// MessageList + MessageComposer, OR a scaffold EmptyState) | RightDrawer (thread)
// + the CommandPalette overlay, and delegates ALL cross-store wiring to
// `useShellController`. No message data ever comes from the HTTP API — the shell
// reads exclusively through the worker client (via the stores).
//
// STILL LIGHT theme (dark mode ships in PR-D); the message/composer components are
// NOT restyled here (that's PR-D too) — this PR only restructures the shell chrome.
import AppSidebar from './AppSidebar.vue'
import CommandPalette from './CommandPalette.vue'
import MessageComposer from './MessageComposer.vue'
import MessageList from './MessageList.vue'
import RightDrawer from './RightDrawer.vue'
import SpaceRail from './SpaceRail.vue'
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
  scaffold,
  composerPlaceholder,
  quickItems,
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
} = useShellController()
</script>

<template>
  <div
    role="application"
    class="grid h-screen w-screen overflow-hidden bg-background text-primary"
    :class="threadOpen ? 'grid-cols-[3.5rem_16rem_1fr_24rem]' : 'grid-cols-[3.5rem_16rem_1fr]'"
  >
    <!-- Rail track. -->
    <SpaceRail
      :workspace-initials="workspaceInitials"
      :workspace-name="workspaceName"
      @logout="onLogout"
    />

    <!-- Sidebar track. -->
    <AppSidebar
      :active-view="activeView"
      :workspace-name="workspaceName"
      :can-admin="canAdmin"
      @open-switcher="openPalette"
      @select-view="setActiveView"
    />

    <!-- Main track. -->
    <main role="main" class="flex min-h-0 min-w-0 flex-col">
      <header
        class="flex items-center justify-between border-b border-subtle px-4 py-3"
        data-testid="channel-header"
      >
        <h1 class="truncate text-sm font-semibold text-primary">{{ mainTitle }}</h1>
      </header>

      <!-- Live conversation timeline (real channel/DM). -->
      <template v-if="activeView === 'conversation'">
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

      <!-- Scaffold placeholder (Inbox / Feeds / Apps / Admin). -->
      <div v-else class="flex flex-1 items-center justify-center">
        <EmptyState v-if="scaffold" :title="scaffold.title" :description="scaffold.body" />
      </div>
    </main>

    <!-- Drawer track (M3 thread pane, ENG-103) — appears only while a thread is open. -->
    <RightDrawer :open="threadOpen" />

    <CommandPalette
      :open="paletteOpen"
      :items="quickItems"
      @select="onPaletteSelect"
      @close="paletteOpen = false"
    />
  </div>
</template>
