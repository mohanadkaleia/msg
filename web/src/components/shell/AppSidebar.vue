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
// constant, one-line to reverse), NOT the workspace name. ENG-152 PR-b demotes it
// to a small, muted, uppercase app-brand mark so the WORKSPACE pill below (name +
// "Local workspace" sub-label) is the clear primary identity — "Ranin" must not
// read as a second workspace.
//
// ENG-152 PR-b: the footer carries a one-line local-first note (`local-first-note`)
// under the UserCard — sync-store-derived ("Synced · Local" when live, the store
// label otherwise), reinforcing the local-first identity without inventing data.
//
// ENG-152 PR-c: a "+ New" button sits under the workspace pill, opening the
// REAL create flows (New message / New channel — the same dialogs the section
// "+" affordances open). Restyled COMPACT (sidebar restructure feedback): a
// small ghost control, not a hero accent button. Unread rows get an
// accent-subtle count pill (mention rows keep the danger `mention-badge`).
//
// ENG-152 sidebar restructure (user feedback): the "Messages" category header
// is GONE — Inbox, DMs, and Channels are TOP-LEVEL nodes. Inbox is a single
// leaf; DMs and Channels are each a collapsible ui/NavGroup (chevron,
// aria-expanded, per-node localStorage persistence under `msg:nav-group:dms` /
// `msg:nav-group:channels`, default EXPANDED — the E2E flows click rows
// without toggling) whose children render INDENTED under the single thin
// `border-subtle` connector rule. The WORKSPACE group (Files, Apps, Search,
// Admin) is unchanged. Every item, route, and test-id is preserved
// (`nav-inbox`, `sidebar-dm`, `sidebar-channel`, …); `nav-group-dms` /
// `nav-group-channels` address the new header buttons. DM rows NO LONGER show
// the counterpart presence dot (same feedback) — presence elsewhere (footer
// card, message rows) is untouched.
//
// SECURITY: stream names + the user's display name are other users' input —
// rendered via text interpolation only.
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'

import { dmDisplayName } from '../../lib/dm'
import { activeStatus } from '../../lib/status'
import { useAuthStore } from '../../stores/auth'
import { usePresenceStore } from '../../stores/presence'
import { useSyncStore } from '../../stores/sync'
import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'
import Icon from '../ui/Icon.vue'
import NavGroup from '../ui/NavGroup.vue'
import NavSection from '../ui/NavSection.vue'
import SidebarItem from '../ui/SidebarItem.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import UserPopover from '../ui/UserPopover.vue'
import ChannelBrowser from './ChannelBrowser.vue'
import ChannelSettingsDialog from './ChannelSettingsDialog.vue'
import CreateChannelDialog from './CreateChannelDialog.vue'
import NewButton from './NewButton.vue'
import NewDmDialog from './NewDmDialog.vue'
import UserCard from './UserCard.vue'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import ProfileDialog from '../profile/ProfileDialog.vue'

import type { ActiveView } from '../../composables/useShellController'

/** The product brand shown in the header (NOT the workspace name — see file note). */
const BRAND = 'Ranin'

const props = defineProps<{
  activeView: ActiveView
  workspaceName: string
  workspaceInitials: string
  /** ENG-152: the folded workspace icon sha (undefined = no icon → glyph). */
  workspaceIconSha?: string | undefined
  canAdmin: boolean
}>()

const emit = defineEmits<{ openSearch: []; selectView: [view: ActiveView] }>()

const workspace = useWorkspaceStore()
const auth = useAuthStore()
const presence = usePresenceStore()
const sync = useSyncStore()
const { channels, dms, directory, selectedStreamId } = storeToRefs(workspace)

/** Footer local-first note — sync-store-derived, never invented (ENG-152). */
const localFirstNote = computed(() => {
  if (sync.tone === 'live') return 'Synced · Local'
  if (sync.tone === 'offline') return 'Offline · Local'
  return `${sync.label} · Local` // 'Syncing… · Local' / 'Connecting… · Local'
})

/** Which modal is open (ENG-104). `settings` also carries the target channel. */
const showCreateChannel = ref(false)
const showChannelBrowser = ref(false)
const showNewDm = ref(false)
const settingsFor = ref<SidebarStream | null>(null)
/** The current user's own profile dialog (view + edit display name). */
const showProfile = ref(false)

/** REAL total unread across every channel + DM — the Inbox badge (0 = no badge). */
const totalUnread = computed(() =>
  [...channels.value, ...dms.value].reduce((sum, s) => sum + s.unread, 0),
)

/** The signed-in user's display name (directory-resolved) for the footer card. */
const myName = computed(() => {
  const id = auth.myUserId
  if (id === undefined) return 'You'
  return workspace.displayNameOf(id)
})

/** REAL presence for the footer dot (defaults to online while connected). */
const myStatus = computed(() => presence.myStatus)

/**
 * The signed-in user's ACTIVE custom status for the footer card (ENG-164) —
 * folded from the directory record, with lazy expiry applied at render time
 * (`activeStatus` returns null for an expired or unset status).
 */
const myCustomStatus = computed(() => activeStatus(workspace.userOf(auth.myUserId)))

/** The signed-in user's avatar ref for the footer card (ENG-152). */
const myAvatarSha = computed(() => workspace.userOf(auth.myUserId)?.avatar_sha256)

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

/**
 * The single OTHER participant of a 1:1 DM (ENG-152 avatar target). A group DM
 * (or unknown participants) returns undefined — the row keeps the initials chip.
 */
function dmOtherUserId(stream: SidebarStream): string | undefined {
  const others = (stream.dm_user_ids ?? []).filter((id) => id !== auth.myUserId)
  return others.length === 1 ? others[0] : undefined
}

/** The DM counterpart's avatar ref, when they have one (ENG-152). */
function dmAvatarSha(stream: SidebarStream): string | undefined {
  const other = dmOtherUserId(stream)
  return other === undefined ? undefined : workspace.userOf(other)?.avatar_sha256
}
</script>

<template>
  <aside
    role="navigation"
    aria-label="Channels and direct messages"
    class="flex h-full w-64 flex-col border-r border-subtle bg-surface"
  >
    <!-- Header: the app-brand mark (small, muted, clearly secondary — the
         workspace pill below is the primary identity) + a collapse affordance
         (SCAFFOLD, no-op). -->
    <div class="flex items-center justify-between px-3 py-3">
      <span class="truncate text-[11px] font-semibold uppercase tracking-wider text-muted">{{
        BRAND
      }}</span>
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

    <!-- Workspace selector pill (preserves `open-switcher`) — self-contained:
         it opens its OWN workspace menu (ENG-152 nav cleanup), not the palette. -->
    <WorkspaceSwitcher
      :workspace-name="workspaceName"
      :workspace-initials="workspaceInitials"
      :workspace-icon-sha="workspaceIconSha"
    />

    <!-- "+ New" — compact, restrained create control (sidebar restructure).
         The menu opens the SAME dialogs the node "+" affordances open. -->
    <div class="px-2 pt-2">
      <NewButton @new-dm="showNewDm = true" @new-channel="showCreateChannel = true" />
    </div>

    <!-- Scroll region for the feed list. The root <aside> is the (labeled)
         navigation landmark, so this stays a plain div to avoid a nested,
         unlabeled second nav landmark. -->
    <div class="mt-2 flex-1 space-y-2 overflow-y-auto px-2 pb-3">
      <!-- TOP-LEVEL nodes (sidebar restructure): no "Messages" category header —
           Inbox is a single leaf; DMs and Channels are collapsible nodes whose
           children indent under the NavGroup connector rule. -->

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

      <!-- REAL Direct Messages (ENG-80 projection) — expandable top-level node. -->
      <NavGroup title="DMs" storage-key="dms" data-testid="nav-group-dms">
        <template #icon><Icon name="users" :size="14" /></template>
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
            <!-- Avatar (image when set, initial otherwise) — the DM-row presence
                 dot was removed (sidebar restructure feedback); presence now shows
                 on demand in the UserPopover hovercard. Clicking the avatar opens
                 the counterpart's user-details drawer WITHOUT selecting the DM
                 (@click.stop), so the row text stays the "open conversation" hit. -->
            <UserPopover :user-id="dmOtherUserId(stream)" :name="labelFor(stream)" @click.stop>
              <UserAvatar
                class="grid h-4 w-4 place-items-center rounded-full bg-accent-subtle text-[10px] font-semibold text-accent"
                :user-id="dmOtherUserId(stream)"
                :name="labelFor(stream)"
                :sha="dmAvatarSha(stream)"
              />
            </UserPopover>
          </template>
          {{ labelFor(stream) }}
          <template v-if="stream.mention" #trailing>
            <span
              class="rounded-full bg-danger px-1.5 text-xs font-semibold text-danger-fg"
              data-testid="mention-badge"
              >{{ stream.unread }}</span
            >
          </template>
          <template v-else-if="stream.unread > 0" #trailing>
            <span
              class="rounded-full bg-accent-subtle px-1.5 text-xs font-semibold text-accent"
              data-testid="unread-badge"
              >{{ stream.unread }}</span
            >
          </template>
        </SidebarItem>
      </NavGroup>

      <!-- REAL Channels (ENG-80 projection) — expandable top-level node. -->
      <NavGroup title="Channels" storage-key="channels" data-testid="nav-group-channels">
        <template #icon><Icon name="hash" :size="14" /></template>
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
            <template v-else-if="stream.unread > 0" #trailing>
              <span
                class="rounded-full bg-accent-subtle px-1.5 text-xs font-semibold text-accent"
                data-testid="unread-badge"
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
      </NavGroup>

      <!-- WORKSPACE group: the non-messaging sections (ENG-152 PR-c) — same
           collapsible + indented-connector treatment, behind a divider. -->
      <div class="border-t border-subtle pt-2">
        <NavGroup title="Workspace" storage-key="workspace" data-testid="nav-group-workspace">
          <template #icon><Icon name="folder" :size="14" /></template>

          <!-- REAL Files surface (ENG-152): the workspace file listing. -->
          <SidebarItem
            :active="activeView === 'files'"
            data-testid="nav-files"
            @click="emit('selectView', 'files')"
          >
            <template #leading><Icon name="file" :size="16" /></template>
            Files
          </SidebarItem>

          <SidebarItem
            :active="activeView === 'apps'"
            data-testid="nav-apps"
            @click="emit('selectView', 'apps')"
          >
            <template #leading><Icon name="grid" :size="16" /></template>
            Apps
          </SidebarItem>

          <!-- Search row → the ONE unified search modal (ENG-152 nav cleanup;
               it previously opened the palette — crossed quick-switcher wiring). -->
          <SidebarItem data-testid="nav-search" @click="emit('openSearch')">
            <template #leading><Icon name="search" :size="16" /></template>
            Search
          </SidebarItem>

          <!-- REAL Admin (ENG-151 PR-3) — expandable, role-gated, inside the
               Workspace group; opens the members + pending-invites surface. -->
          <NavSection v-if="canAdmin" title="Admin" :default-open="false">
            <template #icon><Icon name="shield" :size="16" /></template>
            <SidebarItem
              :active="activeView === 'admin'"
              data-testid="nav-admin"
              @click="emit('selectView', 'admin')"
            >
              Members &amp; invites
            </SidebarItem>
          </NavSection>
        </NavGroup>
      </div>
    </div>

    <!-- Pinned footer: the signed-in user card with a REAL presence dot, plus a
         one-line local-first note (sync-store-derived, ENG-152). -->
    <div class="border-t border-subtle p-2">
      <UserCard
        :name="myName"
        :status="myStatus"
        :status-emoji="myCustomStatus?.emoji"
        :status-text="myCustomStatus?.text"
        :user-id="auth.myUserId ?? undefined"
        :avatar-sha="myAvatarSha"
        @open-profile="showProfile = true"
      />
      <p class="px-2 pt-1 text-[11px] text-muted" data-testid="local-first-note">
        {{ localFirstNote }}
      </p>
    </div>
  </aside>

  <CreateChannelDialog v-if="showCreateChannel" @close="showCreateChannel = false" />
  <ChannelBrowser v-if="showChannelBrowser" @close="showChannelBrowser = false" />
  <NewDmDialog v-if="showNewDm" @close="showNewDm = false" />
  <ChannelSettingsDialog v-if="settingsFor" :stream="settingsFor" @close="settingsFor = null" />
  <ProfileDialog v-if="showProfile" @close="showProfile = false" />
</template>
