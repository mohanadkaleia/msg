<script setup lang="ts">
// AppSidebar — ENG-136 "Ranin" feed-first sidebar (PR-B). A DUMB view over the
// workspace store (streams + badges from the ENG-80 projection), rebuilt on the
// PR-A primitives (NavSection / SidebarItem / EmptyState). Feed-first IA: a top
// Inbox scaffold, then REAL Direct Messages + Channels from the projection, then
// scaffold Feeds / Apps / Admin sections that flip the main panel to a placeholder
// (Admin only when the role permits). Clicking a channel/DM selects a stream (a
// local flip; the message load is a separate ZERO-network projection read) and
// switches the main panel to the conversation timeline. The "+"/browse buttons
// open dialogs that author workspace-meta events worker-side.
//
// The global sync indicator now lives in the SpaceRail (once, workspace-wide), so
// it is NO LONGER rendered here — keeping the `sync-indicator` testid unique.
//
// SECURITY: stream names are other users' input — rendered via text interpolation.
import { ref } from 'vue'
import { storeToRefs } from 'pinia'

import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'
import NavSection from '../ui/NavSection.vue'
import SidebarItem from '../ui/SidebarItem.vue'
import ChannelBrowser from './ChannelBrowser.vue'
import ChannelSettingsDialog from './ChannelSettingsDialog.vue'
import CreateChannelDialog from './CreateChannelDialog.vue'
import NewDmDialog from './NewDmDialog.vue'

import type { ActiveView } from '../../composables/useShellController'

const props = defineProps<{
  activeView: ActiveView
  workspaceName: string
  canAdmin: boolean
}>()

const emit = defineEmits<{ openSwitcher: []; selectView: [view: ActiveView] }>()

const workspace = useWorkspaceStore()
const { channels, dms, selectedStreamId } = storeToRefs(workspace)

/** Which modal is open (ENG-104). `settings` also carries the target channel. */
const showCreateChannel = ref(false)
const showChannelBrowser = ref(false)
const showNewDm = ref(false)
const settingsFor = ref<SidebarStream | null>(null)

/** Select a real stream + switch the main panel to the conversation timeline. */
function select(stream: SidebarStream): void {
  workspace.selectStream(stream.stream_id)
  emit('selectView', 'conversation')
}

/** True when this stream is the one shown in the conversation timeline. */
function isActive(stream: SidebarStream): boolean {
  return props.activeView === 'conversation' && stream.stream_id === selectedStreamId.value
}

/** Display label: channel name with a leading '#', DM/other by name or id. */
function labelFor(stream: SidebarStream): string {
  const name = stream.name ?? stream.stream_id
  return stream.kind === 'dm' ? name : `# ${name}`
}
</script>

<template>
  <aside
    role="navigation"
    aria-label="Channels and direct messages"
    class="flex h-full w-64 flex-col border-r border-subtle bg-surface"
  >
    <div class="flex items-center justify-between px-3 py-3">
      <span class="truncate text-sm font-semibold text-primary">{{ workspaceName }}</span>
      <button
        type="button"
        class="rounded border border-subtle bg-background px-2 py-1 text-xs text-secondary transition-colors hover:text-primary"
        data-testid="open-switcher"
        title="Quick switch (⌘K)"
        @click="emit('openSwitcher')"
      >
        ⌘K
      </button>
    </div>

    <!-- Scroll region for the feed list. The root <aside> is the (labeled)
         navigation landmark, so this stays a plain div to avoid a nested,
         unlabeled second nav landmark. -->
    <div class="flex-1 space-y-3 overflow-y-auto px-2 pb-3">
      <!-- Feed-first: Inbox scaffold at the top. -->
      <SidebarItem
        :active="activeView === 'inbox'"
        data-testid="nav-inbox"
        @click="emit('selectView', 'inbox')"
      >
        Inbox
      </SidebarItem>

      <!-- REAL Direct Messages (ENG-80 projection). -->
      <NavSection title="Direct Messages">
        <template #action>
          <button
            type="button"
            class="rounded px-1 text-sm leading-none text-muted transition-colors hover:text-primary"
            aria-label="New direct message"
            title="New direct message"
            data-testid="open-new-dm"
            @click="showNewDm = true"
          >
            +
          </button>
        </template>
        <SidebarItem
          v-for="stream in dms"
          :key="stream.stream_id"
          :active="isActive(stream)"
          :unread="stream.unread > 0"
          data-testid="sidebar-dm"
          :data-stream-id="stream.stream_id"
          :data-unread="stream.unread"
          @click="select(stream)"
        >
          {{ labelFor(stream) }}
          <template v-if="stream.mention" #trailing>
            <span
              class="rounded-full bg-danger px-1.5 text-xs font-semibold text-accent-fg"
              data-testid="mention-badge"
              >{{ stream.unread }}</span
            >
          </template>
        </SidebarItem>
      </NavSection>

      <!-- REAL Channels (ENG-80 projection). -->
      <NavSection title="Channels">
        <template #action>
          <span class="flex items-center gap-0.5">
            <button
              type="button"
              class="rounded px-1 text-sm leading-none text-muted transition-colors hover:text-primary"
              aria-label="Browse channels"
              title="Browse channels"
              data-testid="open-channel-browser"
              @click="showChannelBrowser = true"
            >
              ⌕
            </button>
            <button
              type="button"
              class="rounded px-1 text-sm leading-none text-muted transition-colors hover:text-primary"
              aria-label="Create a channel"
              title="Create a channel"
              data-testid="open-create-channel"
              @click="showCreateChannel = true"
            >
              +
            </button>
          </span>
        </template>
        <div v-for="stream in channels" :key="stream.stream_id" class="group relative">
          <SidebarItem
            :active="isActive(stream)"
            :unread="stream.unread > 0"
            data-testid="sidebar-channel"
            :data-stream-id="stream.stream_id"
            :data-unread="stream.unread"
            @click="select(stream)"
          >
            {{ labelFor(stream) }}
            <template v-if="stream.mention" #trailing>
              <span
                class="rounded-full bg-danger px-1.5 text-xs font-semibold text-accent-fg"
                data-testid="mention-badge"
                >{{ stream.unread }}</span
              >
            </template>
          </SidebarItem>
          <button
            type="button"
            class="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded px-1 text-xs text-muted transition-colors hover:text-primary group-hover:block"
            title="Channel settings"
            data-testid="open-channel-settings"
            :data-stream-id="stream.stream_id"
            @click.stop="settingsFor = stream"
          >
            ⚙
          </button>
        </div>
      </NavSection>

      <!-- Scaffold sections: select a placeholder view (main panel EmptyState). -->
      <NavSection title="Feeds" :default-open="false">
        <SidebarItem
          :active="activeView === 'feeds'"
          data-testid="nav-feeds"
          @click="emit('selectView', 'feeds')"
        >
          Coming soon
        </SidebarItem>
      </NavSection>

      <NavSection title="Apps" :default-open="false">
        <SidebarItem
          :active="activeView === 'apps'"
          data-testid="nav-apps"
          @click="emit('selectView', 'apps')"
        >
          Coming soon
        </SidebarItem>
      </NavSection>

      <NavSection v-if="canAdmin" title="Admin" :default-open="false">
        <SidebarItem
          :active="activeView === 'admin'"
          data-testid="nav-admin"
          @click="emit('selectView', 'admin')"
        >
          Coming soon
        </SidebarItem>
      </NavSection>
    </div>
  </aside>

  <CreateChannelDialog v-if="showCreateChannel" @close="showCreateChannel = false" />
  <ChannelBrowser v-if="showChannelBrowser" @close="showChannelBrowser = false" />
  <NewDmDialog v-if="showNewDm" @close="showNewDm = false" />
  <ChannelSettingsDialog v-if="settingsFor" :stream="settingsFor" @close="settingsFor = null" />
</template>
