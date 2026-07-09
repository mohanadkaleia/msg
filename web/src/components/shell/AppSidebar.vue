<script setup lang="ts">
// AppSidebar — ENG-136 "Ranin" sidebar (PR-3). A DUMB view over the workspace
// store (streams + badges from the ENG-80 projection). IA: a "Ranin" wordmark
// header + a workspace selector pill, then Inbox (with a REAL total-unread
// count), the REAL projection-backed DM + Channel lists, then the scaffold
// Apps / Files / Search / Admin sections. A pinned footer UserCard shows the
// signed-in user with a REAL presence dot (ENG-126 presence store).
//
// IA NOTE (user decision): the former "Feeds" section was REMOVED — Inbox and
// Feeds were the same triage concept, so Inbox is the single triage surface
// (InboxView with filter tabs); a separate Feeds section was redundant.
//
// Clicking a channel/DM selects a stream (a local flip; the message load is a
// separate ZERO-network projection read) and switches the main panel to the
// conversation timeline. The "+"/browse buttons open dialogs that author
// workspace-meta events worker-side. The global sync indicator lives in the
// SpaceRail (once, workspace-wide), NOT here — keeping `sync-indicator` unique.
//
// NAMING (flag): the header wordmark is the product BRAND "Ranin" (a `BRAND`
// constant, one-line to reverse), NOT the workspace name. The user asked for a
// working-name header earlier, then "follow the pic" which shows "Ranin" — so we
// show "Ranin"; reversing to the workspace name is a single edit here.
//
// SECURITY: stream names + the user's display name are other users' input —
// rendered via text interpolation only.
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'

import { dmDisplayName, dmOtherUserId } from '../../lib/dm'
import { useAuthStore } from '../../stores/auth'
import { usePresenceStore } from '../../stores/presence'
import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'
import Icon from '../ui/Icon.vue'
import NavSection from '../ui/NavSection.vue'
import PresenceDot from '../ui/PresenceDot.vue'
import SidebarItem from '../ui/SidebarItem.vue'
import ChannelBrowser from './ChannelBrowser.vue'
import ChannelSettingsDialog from './ChannelSettingsDialog.vue'
import CreateChannelDialog from './CreateChannelDialog.vue'
import NewDmDialog from './NewDmDialog.vue'
import UserCard from './UserCard.vue'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'

import type { ActiveView } from '../../composables/useShellController'
import type { PresenceStatus } from '../../worker'

/** The product brand shown in the header (NOT the workspace name — see file note). */
const BRAND = 'Ranin'

const props = defineProps<{
  activeView: ActiveView
  workspaceName: string
  workspaceInitials: string
  canAdmin: boolean
}>()

const emit = defineEmits<{ openSwitcher: []; selectView: [view: ActiveView] }>()

const workspace = useWorkspaceStore()
const auth = useAuthStore()
const presence = usePresenceStore()
const { channels, dms, directory, selectedStreamId } = storeToRefs(workspace)

/** Which modal is open (ENG-104). `settings` also carries the target channel. */
const showCreateChannel = ref(false)
const showChannelBrowser = ref(false)
const showNewDm = ref(false)
const settingsFor = ref<SidebarStream | null>(null)

/** REAL total unread across every channel + DM — the Inbox badge (0 = no badge). */
const totalUnread = computed(() =>
  [...channels.value, ...dms.value].reduce((sum, s) => sum + s.unread, 0),
)

/** The signed-in user's display name (directory-resolved) for the footer card. */
const myName = computed(() => {
  const id = auth.myUserId
  if (id === undefined) return 'You'
  return directory.value.users.find((u) => u.user_id === id)?.display_name ?? id
})

/** REAL presence for the footer dot (defaults to online while connected). */
const myStatus = computed(() => presence.myStatus)

/** Select a real stream + switch the main panel to the conversation timeline. */
function select(stream: SidebarStream): void {
  workspace.selectStream(stream.stream_id)
  emit('selectView', 'conversation')
}

/** True when this stream is the one shown in the conversation timeline. */
function isActive(stream: SidebarStream): boolean {
  return props.activeView === 'conversation' && stream.stream_id === selectedStreamId.value
}

/** Directory-backed `user_id → display_name` map (the DM label source, ENG-149). */
const names = computed<ReadonlyMap<string, string>>(
  () => new Map(directory.value.users.map((u) => [u.user_id, u.display_name])),
)

/**
 * Display label: a DM shows the OTHER participant's display name (resolved from
 * `dm_user_ids` — the cached `dm.created` fold, ENG-149); when the participants
 * are unknown the row keeps its previous name/id fallback. A channel shows its
 * bare name (the leading '#' comes from the icon).
 */
function labelFor(stream: SidebarStream): string {
  if (stream.kind === 'dm') {
    return (
      dmDisplayName(stream.dm_user_ids, auth.myUserId, names.value) ??
      stream.name ??
      stream.stream_id
    )
  }
  return stream.name ?? stream.stream_id
}

/** Single-letter avatar for a DM row (from the resolved label). */
function dmInitial(stream: SidebarStream): string {
  return labelFor(stream).trim()[0]?.toUpperCase() ?? '?'
}

/**
 * The DM counterpart's live presence for the row dot (ENG-149, closing the
 * ENG-128 gap) — `undefined` (no dot) when the participants are unresolvable.
 */
function dmStatus(stream: SidebarStream): PresenceStatus | undefined {
  const other = dmOtherUserId(stream.dm_user_ids, auth.myUserId)
  return other === undefined ? undefined : presence.statusOf(other)
}
</script>

<template>
  <aside
    role="navigation"
    aria-label="Channels and direct messages"
    class="flex h-full w-64 flex-col border-r border-subtle bg-surface"
  >
    <!-- Header: "Ranin" wordmark + a collapse affordance (SCAFFOLD, no-op). -->
    <div class="flex items-center justify-between px-3 py-3">
      <span class="truncate text-sm font-semibold text-primary">{{ BRAND }}</span>
      <button
        type="button"
        class="grid h-7 w-7 place-items-center rounded text-muted transition-colors hover:bg-surface-hover hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="Collapse sidebar (coming soon)"
        title="Collapse sidebar (coming soon)"
        data-testid="collapse-sidebar"
      >
        <Icon name="chevrons-left-right" :size="16" />
      </button>
    </div>

    <!-- Workspace selector pill (preserves `open-switcher`). -->
    <WorkspaceSwitcher
      :workspace-name="workspaceName"
      :workspace-initials="workspaceInitials"
      @open-switcher="emit('openSwitcher')"
    />

    <!-- Scroll region for the feed list. The root <aside> is the (labeled)
         navigation landmark, so this stays a plain div to avoid a nested,
         unlabeled second nav landmark. -->
    <div class="mt-2 flex-1 space-y-2 overflow-y-auto px-2 pb-3">
      <!-- Feed-first: Inbox with a REAL total-unread count. -->
      <SidebarItem
        :active="activeView === 'inbox'"
        data-testid="nav-inbox"
        @click="emit('selectView', 'inbox')"
      >
        <template #leading><Icon name="mail" :size="16" /></template>
        Inbox
        <template v-if="totalUnread > 0" #trailing>
          <span
            class="rounded-full bg-accent-subtle px-1.5 text-xs font-medium text-accent"
            data-testid="inbox-unread"
            >{{ totalUnread }}</span
          >
        </template>
      </SidebarItem>

      <!-- REAL Direct Messages (ENG-80 projection). -->
      <NavSection title="DMs">
        <template #icon><Icon name="users" :size="16" /></template>
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
          <template #leading>
            <span class="relative">
              <span
                class="grid h-4 w-4 place-items-center rounded-full bg-accent-subtle text-[10px] font-semibold text-accent"
                >{{ dmInitial(stream) }}</span
              >
              <!-- REAL presence for the DM counterpart (ENG-149/ENG-128). -->
              <PresenceDot
                v-if="dmStatus(stream) !== undefined"
                size="sm"
                :status="dmStatus(stream)!"
                class="absolute -bottom-0.5 -right-0.5 border border-surface"
              />
            </span>
          </template>
          {{ labelFor(stream) }}
          <template v-if="stream.mention" #trailing>
            <span
              class="rounded-full bg-danger px-1.5 text-xs font-semibold text-danger-fg"
              data-testid="mention-badge"
              >{{ stream.unread }}</span
            >
          </template>
        </SidebarItem>
      </NavSection>

      <!-- REAL Channels (ENG-80 projection). -->
      <NavSection title="Channels">
        <template #icon><Icon name="hash" :size="16" /></template>
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
        <div v-for="stream in channels" :key="stream.stream_id" class="group/row relative">
          <SidebarItem
            :active="isActive(stream)"
            :unread="stream.unread > 0"
            data-testid="sidebar-channel"
            :data-stream-id="stream.stream_id"
            :data-unread="stream.unread"
            @click="select(stream)"
          >
            <template #leading><Icon name="hash" :size="16" /></template>
            {{ labelFor(stream) }}
            <template v-if="stream.mention" #trailing>
              <span
                class="rounded-full bg-danger px-1.5 text-xs font-semibold text-danger-fg"
                data-testid="mention-badge"
                >{{ stream.unread }}</span
              >
            </template>
          </SidebarItem>
          <button
            type="button"
            class="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded px-1 text-xs text-muted transition-colors hover:text-primary group-hover/row:block"
            title="Channel settings"
            data-testid="open-channel-settings"
            :data-stream-id="stream.stream_id"
            @click.stop="settingsFor = stream"
          >
            ⚙
          </button>
        </div>
      </NavSection>

      <!-- SCAFFOLD single-row nav. -->
      <SidebarItem
        :active="activeView === 'apps'"
        data-testid="nav-apps"
        @click="emit('selectView', 'apps')"
      >
        <template #leading><Icon name="grid" :size="16" /></template>
        Apps
      </SidebarItem>

      <SidebarItem
        :active="activeView === 'files'"
        data-testid="nav-files"
        @click="emit('selectView', 'files')"
      >
        <template #leading><Icon name="file" :size="16" /></template>
        Files
      </SidebarItem>

      <SidebarItem data-testid="nav-search" @click="emit('openSwitcher')">
        <template #leading><Icon name="search" :size="16" /></template>
        Search
      </SidebarItem>

      <!-- SCAFFOLD Admin — expandable, a bit separated, role-gated. -->
      <div v-if="canAdmin" class="mt-2 border-t border-subtle pt-2">
        <NavSection title="Admin" :default-open="false">
          <template #icon><Icon name="shield" :size="16" /></template>
          <SidebarItem
            :active="activeView === 'admin'"
            data-testid="nav-admin"
            @click="emit('selectView', 'admin')"
          >
            Coming soon
          </SidebarItem>
        </NavSection>
      </div>
    </div>

    <!-- Pinned footer: the signed-in user card with a REAL presence dot. -->
    <div class="border-t border-subtle p-2">
      <UserCard :name="myName" :status="myStatus" />
    </div>
  </aside>

  <CreateChannelDialog v-if="showCreateChannel" @close="showCreateChannel = false" />
  <ChannelBrowser v-if="showChannelBrowser" @close="showChannelBrowser = false" />
  <NewDmDialog v-if="showNewDm" @close="showNewDm = false" />
  <ChannelSettingsDialog v-if="settingsFor" :stream="settingsFor" @close="settingsFor = null" />
</template>
