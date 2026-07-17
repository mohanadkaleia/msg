<script setup lang="ts">
// ChannelDetailsDrawer — the "Ranin" channel Details panel (ENG-136 + ENG-129).
//
// A ~250px right-hand column listing the channel's detail rows. REAL vs SCAFFOLD:
// - Notifications is REAL (ENG-129): a per-channel notification-level selector
//   backed by the worker prefs surface (ENG-124/126). The row shows the current
//   level (`client.prefs.get()`, default `all` when no pref); selecting an option
//   calls `client.prefs.set(streamId, level)` OPTIMISTICALLY — the `{kind:'prefs'}`
//   push (the set's publish / a cross-device echo) reconciles the label.
// - Members is REAL: it opens the EXISTING channel-settings dialog (add/remove
//   member, ENG-104) via `open-members`; the count is the same honest directory
//   stand-in the ChannelHeader uses (a per-channel roster query is a follow-up).
// - Leave channel is REAL: an inline confirm, then the existing
//   `channel.removeMember(streamId, myUserId)` mutation; `left` lets the shell
//   close the drawer + reselect gracefully.
// - About / Files / Pinned / Apps / Threads / Shortcuts are SCAFFOLD rows —
//   visually faithful, descriptive empty-state copy (ENG-173 — never a bare "—"),
//   clicking is a no-op.
// - DM (ENG-172): a DM's Details panel is context-aware — it shows the OTHER
//   participant's profile (avatar/name/title/status/presence, the same directory
//   + presence data the hovercard uses), shared Files, the REAL Notifications
//   selector (its "Mute" option IS the DM mute, via the same prefs surface), and
//   a "Close conversation" action (`close-dm` — the shell deselects the DM).
//   Channel-only concepts (About/Members/Apps/Threads/Shortcuts/Leave) never
//   render for a DM.
// All data flows through the worker client / stores — never the HTTP API.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'

import Icon, { type IconName } from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'
import PresenceDot from '../ui/PresenceDot.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { dmOtherUserId } from '../../lib/dm'
import { activeStatus } from '../../lib/status'
import { useAuthStore } from '../../stores/auth'
import { useNotificationsStore } from '../../stores/notifications'
import { usePresenceStore } from '../../stores/presence'
import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'
import type { DirectoryUser, PrefLevel, PresenceStatus, Unsubscribe } from '../../worker'

const props = defineProps<{
  /** The selected stream the drawer describes (id, name, kind). */
  stream: SidebarStream
}>()

const emit = defineEmits<{
  /** The ✕ — the shell flips the drawer mode back to 'none'. */
  close: []
  /** Members row — the shell opens the existing channel-settings dialog. */
  'open-members': []
  /** The leave mutation succeeded — the shell closes + reselects. */
  left: []
  /** DM "Close conversation" (ENG-172) — the shell closes + navigates away. */
  'close-dm': []
}>()

const auth = useAuthStore()
const workspace = useWorkspaceStore()
const notifications = useNotificationsStore()
const presence = usePresenceStore()
const { myUserId } = storeToRefs(auth)
const { directory } = storeToRefs(workspace)
const { statuses: presenceStatuses } = storeToRefs(presence)

// -- DM context (ENG-172) -----------------------------------------------------

/** Whether the panel describes a DM — flips it to the participant-profile view. */
const isDm = computed(() => props.stream.kind === 'dm')

/** The DM counterpart's user id (ENG-149 resolution), if resolvable. */
const dmUserId = computed<string | undefined>(() =>
  isDm.value ? dmOtherUserId(props.stream.dm_user_ids, myUserId.value) : undefined,
)

/** The counterpart's directory record (name-only stub when not yet folded). */
const dmUser = computed<DirectoryUser | undefined>(() => {
  const id = dmUserId.value
  if (id === undefined) return undefined
  return workspace.userOf(id) ?? { user_id: id, display_name: workspace.displayNameOf(id) }
})

/** The counterpart's live presence (`offline` when unknown). */
const dmPresence = computed<PresenceStatus>(() => {
  const id = dmUserId.value
  return id === undefined ? 'offline' : (presenceStatuses.value.get(id) ?? 'offline')
})

/** The counterpart's ACTIVE custom status (lazy expiry at render — ENG-164). */
const dmStatus = computed(() => activeStatus(dmUser.value))

// -- Notifications (REAL, ENG-129) ------------------------------------------

/** The three levels + their row labels ("Muted" reads better than "Mute" as state). */
const LEVEL_LABELS: Record<PrefLevel, string> = {
  all: 'All messages',
  mentions: 'Mentions only',
  mute: 'Muted',
}
/** Menu options in display order (option labels use the imperative "Mute"). */
const LEVEL_OPTIONS: ReadonlyArray<{ level: PrefLevel; label: string }> = [
  { level: 'all', label: 'All messages' },
  { level: 'mentions', label: 'Mentions only' },
  { level: 'mute', label: 'Mute' },
]

/** The current per-channel level; absent pref ⇒ `all` (the prefs default). */
const level = ref<PrefLevel>('all')
const notifMenuOpen = ref(false)
let prefsUnsub: Unsubscribe | undefined

const levelLabel = computed(() => LEVEL_LABELS[level.value])

/** Re-derive this stream's level from a full prefs snapshot (get/push payloads). */
function applySnapshot(prefs: ReadonlyArray<{ stream_id: string; level: PrefLevel }>): void {
  const row = prefs.find((p) => p.stream_id === props.stream.stream_id)
  level.value = row?.level ?? 'all'
}

/** Load the stored level for the current stream (`prefs.get`, default `all`). */
async function loadLevel(): Promise<void> {
  const client = await resolveWorkerClient()
  const res = await client.prefs.get()
  applySnapshot(res.prefs)
}

/** Select a level: optimistic label + `prefs.set` (its publish/echo reconciles). */
function selectLevel(next: PrefLevel): void {
  notifMenuOpen.value = false
  level.value = next
  const streamId = props.stream.stream_id
  void resolveWorkerClient().then((client) => client.prefs.set(streamId, next))
}

onMounted(async () => {
  const client = await resolveWorkerClient()
  // Any prefs change (this tab's set, another device's echo) re-derives the label.
  prefsUnsub = client.subscribe({ kind: 'prefs' }, (payload) => {
    applySnapshot(payload.prefs)
  })
  await loadLevel()
})

onBeforeUnmount(() => {
  prefsUnsub?.()
  prefsUnsub = undefined
})

// -- Members (REAL count stand-in; the dialog itself is the parent's) --------

/** SCAFFOLD member count — the same honest directory stand-in as ChannelHeader. */
const memberCount = computed(() => directory.value.users.length)

// -- Leave channel (REAL, ENG-104 mutation) ----------------------------------

const confirmingLeave = ref(false)
const leaving = ref(false)
const leaveError = ref<string | null>(null)

async function leaveChannel(): Promise<void> {
  const userId = myUserId.value
  if (!userId || leaving.value) return
  leaving.value = true
  leaveError.value = null
  try {
    await workspace.removeMember(props.stream.stream_id, userId)
    confirmingLeave.value = false
    emit('left')
  } catch (err) {
    leaveError.value = err instanceof Error ? err.message : 'Could not leave the channel.'
  } finally {
    leaving.value = false
  }
}

// Re-target the drawer when the selected stream changes underneath it.
watch(
  () => props.stream.stream_id,
  () => {
    notifMenuOpen.value = false
    confirmingLeave.value = false
    leaveError.value = null
    void loadLevel()
  },
)

// -- Row model ----------------------------------------------------------------

interface DetailRow {
  icon: IconName
  label: string
  sub: string
  testid?: string
  onClick?: () => void
}

/** SCAFFOLD rows above the Notifications row. Empty sections carry descriptive
 * empty-state copy (ENG-173) — never a bare "—" where words should be. A DM
 * (ENG-172) keeps only the DM-relevant Files row; About/Pinned/Apps/Threads/
 * Shortcuts are channel concepts. */
const topScaffoldRows = computed<DetailRow[]>(() =>
  isDm.value ? [] : [{ icon: 'info', label: 'About', sub: 'Description, members, rules' }],
)
const midScaffoldRows = computed<DetailRow[]>(() =>
  isDm.value
    ? [{ icon: 'file', label: 'Files', sub: 'No files yet' }]
    : [
        { icon: 'file', label: 'Files', sub: 'No files yet' },
        { icon: 'pin', label: 'Pinned', sub: 'No pinned items' },
        { icon: 'grid', label: 'Apps', sub: 'No apps installed' },
      ],
)
const bottomScaffoldRows = computed<DetailRow[]>(() =>
  isDm.value
    ? []
    : [
        { icon: 'message-square', label: 'Threads', sub: 'View all threads' },
        { icon: 'keyboard', label: 'Shortcuts', sub: 'No shortcuts' },
      ],
)
</script>

<template>
  <aside
    class="flex h-full min-w-0 flex-col border-l border-subtle bg-background"
    data-testid="channel-details"
  >
    <header class="flex items-center justify-between border-b border-subtle px-4 py-3">
      <h2 class="text-[15px] font-semibold text-primary">Details</h2>
      <IconButton
        size="sm"
        label="Close details"
        data-testid="details-close"
        @click="emit('close')"
      >
        <Icon name="x" :size="16" />
      </IconButton>
    </header>

    <div class="flex-1 overflow-y-auto py-2">
      <!-- ENG-172 DM: the OTHER participant's profile (directory record + live
           presence — the same data the hovercard/user-details panel renders).
           Every field is user-controlled → text interpolation only. -->
      <div
        v-if="isDm && dmUser"
        class="flex flex-col items-center border-b border-subtle px-4 pb-4 pt-2 text-center"
        data-testid="dm-profile"
      >
        <span class="relative shrink-0">
          <UserAvatar
            aria-hidden="true"
            class="grid h-16 w-16 place-items-center rounded-full bg-accent-subtle text-xl font-semibold text-accent"
            :user-id="dmUser.user_id"
            :name="dmUser.display_name"
            :sha="dmUser.avatar_sha256"
          />
          <PresenceDot
            :status="dmPresence"
            class="absolute bottom-0.5 right-0.5 border-2 border-background"
          />
        </span>
        <h3 class="mt-2 text-sm font-semibold text-primary" data-testid="dm-profile-name">
          {{ dmUser.display_name }}
        </h3>
        <p v-if="dmUser.title" class="mt-0.5 text-xs text-secondary">{{ dmUser.title }}</p>
        <p v-if="dmStatus" data-testid="dm-profile-status" class="mt-0.5 text-xs text-secondary">
          <template v-if="dmStatus.emoji">{{ dmStatus.emoji }} </template>{{ dmStatus.text }}
        </p>
        <p
          class="mt-1.5 flex items-center gap-1.5 text-xs text-muted"
          data-testid="dm-profile-presence"
          :data-status="dmPresence"
        >
          <span
            aria-hidden="true"
            class="h-1.5 w-1.5 shrink-0 rounded-full"
            :class="dmPresence === 'online' ? 'bg-success' : 'bg-muted'"
          />
          {{ dmPresence === 'online' ? 'Active now' : 'Offline' }}
        </p>
      </div>

      <!-- SCAFFOLD: About (channels only). -->
      <button
        v-for="row in topScaffoldRows"
        :key="row.label"
        type="button"
        class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
      >
        <Icon :name="row.icon" :size="18" class="shrink-0 text-secondary" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-primary">{{ row.label }}</span>
          <span class="block truncate text-xs text-muted">{{ row.sub }}</span>
        </span>
        <Icon name="chevron-right" :size="16" class="shrink-0 text-muted" />
      </button>

      <!-- REAL: Members — opens the existing channel-settings dialog (ENG-104).
           Channel-only (ENG-172): a 1:1 DM has no member roster to manage. -->
      <button
        v-if="!isDm"
        type="button"
        class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
        data-testid="channel-members"
        @click="emit('open-members')"
      >
        <Icon name="users" :size="18" class="shrink-0 text-secondary" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-primary">Members</span>
          <span class="block truncate text-xs text-muted">
            {{ memberCount }} {{ memberCount === 1 ? 'member' : 'members' }}
          </span>
        </span>
        <Icon name="chevron-right" :size="16" class="shrink-0 text-muted" />
      </button>

      <!-- SCAFFOLD: Files / Pinned / Apps. -->
      <button
        v-for="row in midScaffoldRows"
        :key="row.label"
        type="button"
        class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
      >
        <Icon :name="row.icon" :size="18" class="shrink-0 text-secondary" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-primary">{{ row.label }}</span>
          <span class="block truncate text-xs text-muted">{{ row.sub }}</span>
        </span>
        <Icon name="chevron-right" :size="16" class="shrink-0 text-muted" />
      </button>

      <!-- REAL: Notifications (ENG-129) — per-stream prefs level selector. Kept
           for DMs too (ENG-172): its "Mute" option is the DM mute action. -->
      <div class="relative">
        <button
          type="button"
          class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
          data-testid="channel-notifications"
          aria-haspopup="menu"
          :aria-expanded="notifMenuOpen"
          @click="notifMenuOpen = !notifMenuOpen"
        >
          <Icon name="bell" :size="18" class="shrink-0 text-secondary" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-primary">Notifications</span>
            <span
              class="block truncate text-xs text-muted"
              data-testid="channel-notifications-level"
            >
              {{ levelLabel }}
            </span>
          </span>
          <Icon name="chevron-right" :size="16" class="shrink-0 text-muted" />
        </button>

        <div
          v-if="notifMenuOpen"
          role="menu"
          aria-label="Notification level"
          class="absolute right-3 top-full z-10 -mt-1 w-44 rounded-md border border-subtle bg-surface-elevated py-1 shadow-lg"
        >
          <button
            v-for="opt in LEVEL_OPTIONS"
            :key="opt.level"
            type="button"
            role="menuitemradio"
            :aria-checked="level === opt.level"
            class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-primary hover:bg-surface-hover"
            :data-testid="`channel-notif-${opt.level}`"
            @click="selectLevel(opt.level)"
          >
            {{ opt.label }}
            <Icon v-if="level === opt.level" name="check" :size="14" class="shrink-0 text-accent" />
          </button>
        </div>

        <!-- ENG-129 browser-Notification opt-in: shown ONCE while permission is
             still `default`; requesting is an explicit user gesture (never on
             load). Granted/denied/unsupported states render honest quiet copy. -->
        <button
          v-if="notifications.permission === 'default'"
          type="button"
          class="block w-full px-4 pb-2 pl-11 text-left text-xs font-medium text-accent hover:underline"
          data-testid="enable-notifications"
          @click="notifications.requestPermission()"
        >
          Enable desktop notifications
        </button>
        <p
          v-else-if="notifications.permission === 'denied'"
          class="px-4 pb-2 pl-11 text-xs text-muted"
        >
          Desktop notifications are blocked in your browser settings.
        </p>
      </div>

      <div v-if="!isDm" class="my-2 border-t border-subtle" />

      <!-- SCAFFOLD: Threads / Shortcuts (channels only). -->
      <button
        v-for="row in bottomScaffoldRows"
        :key="row.label"
        type="button"
        class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface"
      >
        <Icon :name="row.icon" :size="18" class="shrink-0 text-secondary" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-primary">{{ row.label }}</span>
          <span class="block truncate text-xs text-muted">{{ row.sub }}</span>
        </span>
        <Icon name="chevron-right" :size="16" class="shrink-0 text-muted" />
      </button>
    </div>

    <!-- ENG-172 DM action: Close conversation — wired to the shell (`close-dm`),
         which closes this panel and navigates away from the DM. Mute lives in the
         Notifications selector above (the REAL prefs surface). -->
    <div v-if="isDm" class="border-t border-subtle py-2">
      <button
        type="button"
        class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-secondary hover:bg-surface hover:text-primary"
        data-testid="dm-close-conversation"
        @click="emit('close-dm')"
      >
        <Icon name="x" :size="18" class="shrink-0" />
        Close conversation
      </button>
    </div>

    <!-- REAL: Leave channel — inline confirm, then channel.removeMember(me). DMs
         cannot be left this way (no leave semantics for a DM), so the row hides. -->
    <div v-if="stream.kind !== 'dm'" class="border-t border-subtle py-2">
      <button
        v-if="!confirmingLeave"
        type="button"
        class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-danger hover:bg-surface"
        data-testid="channel-leave"
        @click="confirmingLeave = true"
      >
        <Icon name="log-out" :size="18" class="shrink-0" />
        Leave channel
      </button>

      <div v-else class="px-4 py-2.5 text-xs" data-testid="channel-leave-confirm">
        <p class="mb-2 text-secondary">
          Leave # {{ stream.name ?? stream.stream_id }}? You will no longer be a member.
        </p>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded bg-danger px-2 py-0.5 font-medium text-danger-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
            data-testid="channel-leave-confirm-yes"
            :disabled="leaving"
            @click="leaveChannel"
          >
            Leave
          </button>
          <button
            type="button"
            class="font-medium text-secondary hover:text-primary"
            data-testid="channel-leave-cancel"
            :disabled="leaving"
            @click="confirmingLeave = false"
          >
            Cancel
          </button>
        </div>
        <p v-if="leaveError" class="mt-2 text-danger" data-testid="channel-leave-error">
          {{ leaveError }}
        </p>
      </div>
    </div>
  </aside>
</template>
