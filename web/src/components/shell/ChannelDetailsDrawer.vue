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
//   visually faithful, honestly "—" counts, clicking is a no-op.
// All data flows through the worker client / stores — never the HTTP API.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'

import Icon, { type IconName } from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { useAuthStore } from '../../stores/auth'
import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'
import type { PrefLevel, Unsubscribe } from '../../worker'

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
}>()

const auth = useAuthStore()
const workspace = useWorkspaceStore()
const { myUserId } = storeToRefs(auth)
const { directory } = storeToRefs(workspace)

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

/** SCAFFOLD rows above the Notifications row (static, honest "—" counts). */
const topScaffoldRows: DetailRow[] = [
  { icon: 'info', label: 'About', sub: 'Description, members, rules' },
]
const midScaffoldRows: DetailRow[] = [
  { icon: 'file', label: 'Files', sub: '— files' },
  { icon: 'pin', label: 'Pinned', sub: '— items' },
  { icon: 'grid', label: 'Apps', sub: '— apps' },
]
const bottomScaffoldRows: DetailRow[] = [
  { icon: 'message-square', label: 'Threads', sub: 'View all threads' },
  { icon: 'keyboard', label: 'Shortcuts', sub: '— shortcuts' },
]
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
      <!-- SCAFFOLD: About. -->
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

      <!-- REAL: Members — opens the existing channel-settings dialog (ENG-104). -->
      <button
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

      <!-- REAL: Notifications (ENG-129) — per-channel prefs level selector. -->
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
            class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-primary hover:bg-surface"
            :data-testid="`channel-notif-${opt.level}`"
            @click="selectLevel(opt.level)"
          >
            {{ opt.label }}
            <Icon v-if="level === opt.level" name="check" :size="14" class="shrink-0 text-accent" />
          </button>
        </div>
      </div>

      <div class="my-2 border-t border-subtle" />

      <!-- SCAFFOLD: Threads / Shortcuts. -->
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
            class="rounded bg-danger px-2 py-0.5 font-medium text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
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
