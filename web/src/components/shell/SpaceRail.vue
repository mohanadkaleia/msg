<script setup lang="ts">
// SpaceRail — ENG-136 "Ranin" left rail (PR-B). A slim (~56px) vertical rail that
// anchors the shell: a neutral workspace glyph at the top, and at the bottom the
// GLOBAL sync indicator (relocated here from the sidebar footer so it lives once,
// workspace-wide) plus an account affordance that signs out. A `theme` slot is
// left for PR-D's ThemeToggle (not mounted yet — theme is pinned light).
//
// The sync dot is driven entirely by the ENG-79 sync engine status mirrored in the
// sync store (same source as the old SyncIndicator); it keeps the single
// `data-testid="sync-indicator"` so the golden-path selector still resolves.
import { computed } from 'vue'
import { storeToRefs } from 'pinia'

import { useSyncStore } from '../../stores/sync'
import IconButton from '../ui/IconButton.vue'
import StatusBadge from '../ui/StatusBadge.vue'

defineProps<{ workspaceInitials: string; workspaceName: string }>()
const emit = defineEmits<{ logout: [] }>()

const sync = useSyncStore()
const { tone, label } = storeToRefs(sync)

/** Map the sync store's coarse tone → the StatusBadge token tone. */
const badgeTone = computed<'online' | 'syncing' | 'offline'>(() => {
  if (tone.value === 'live') return 'online'
  if (tone.value === 'offline') return 'offline'
  return 'syncing'
})
</script>

<template>
  <nav
    role="navigation"
    aria-label="Workspaces"
    class="flex h-full w-14 shrink-0 flex-col items-center gap-3 border-r border-subtle bg-surface py-3"
  >
    <!-- Neutral workspace glyph (initials, not "Ranin"). -->
    <div
      class="flex h-9 w-9 select-none items-center justify-center rounded-md bg-accent text-[13px] font-semibold text-accent-fg"
      :title="workspaceName"
      :aria-label="workspaceName"
    >
      {{ workspaceInitials }}
    </div>

    <div class="flex-1" />

    <!-- Global sync indicator (relocated from the sidebar footer; unique testid). -->
    <div
      class="flex h-7 w-7 items-center justify-center"
      data-testid="sync-indicator"
      :data-tone="tone"
      :title="label"
      :aria-label="`Connection: ${label}`"
    >
      <StatusBadge :tone="badgeTone" />
    </div>

    <!-- PR-D mounts <ThemeToggle> here. -->
    <slot name="theme" />

    <!-- Account affordance: sign out lives in the rail (§ Ranin PR-B). PR-C: this
         is the first IconButton call site, proving the `label` primitive. -->
    <IconButton label="Sign out" title="Sign out" data-testid="logout" @click="emit('logout')">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        class="h-4 w-4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6" />
        <path d="M10.5 11 14 8l-3.5-3M14 8H6" />
      </svg>
    </IconButton>
  </nav>
</template>
