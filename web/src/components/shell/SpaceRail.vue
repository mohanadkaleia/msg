<script setup lang="ts">
// SpaceRail — ENG-136 "Ranin" left rail (PR-3; ENG-152 PR-b cleanup). A slim
// (~56px) vertical rail that anchors the shell: a rounded-square "R" brand logo at
// the top, then the ONE real workspace as an active square (initial, `bg-strong`
// fill + an accent indicator dot on its right edge). The former SCAFFOLD
// placeholder squares ("A"/"B") and the disabled "+" add button were REMOVED
// (ENG-152 user feedback: they read as broken; multi-workspace has no real seam
// yet — reintroduce a functional "+" when one exists). At the bottom sit the
// GLOBAL sync indicator (relocated here so it lives once, workspace-wide), the theme
// toggle, and a settings gear whose popover holds the sign-out affordance.
//
// The sync dot is driven entirely by the ENG-79 sync engine status mirrored in the
// sync store; it keeps the single `data-testid="sync-indicator"` so the golden-path
// selector still resolves. Sign-out keeps `data-testid="logout"`, reachable from the
// gear popover.
import { computed, ref, toRef, watch } from 'vue'
import { storeToRefs } from 'pinia'

import { useWorkspaceIconUrl } from '../../composables/useWorkspaceIconUrl'
import { useSyncStore } from '../../stores/sync'
import Icon from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'
import StatusBadge from '../ui/StatusBadge.vue'
import ThemeToggle from '../ui/ThemeToggle.vue'

const props = defineProps<{
  workspaceInitials: string
  workspaceName: string
  /** ENG-152: the folded workspace icon sha (undefined = no icon → glyph). */
  workspaceIconSha?: string | undefined
}>()
const emit = defineEmits<{ logout: [] }>()

const sync = useSyncStore()
const { tone, label } = storeToRefs(sync)

// ENG-152: the workspace icon image (worker-fetched by sha). Null until loaded,
// on a 404, or when no icon is set — the initials glyph shows in that case, and
// a load error (img @error) falls back to the glyph too.
const { url: iconUrl } = useWorkspaceIconUrl(() => toRef(props, 'workspaceIconSha').value)
const iconFailed = ref(false)
// A new icon (new url) gets a fresh chance to render before any error fallback.
watch(iconUrl, () => {
  iconFailed.value = false
})
const showIcon = computed(() => iconUrl.value !== null && !iconFailed.value)

/** Map the sync store's coarse tone → the StatusBadge token tone. */
const badgeTone = computed<'online' | 'syncing' | 'offline'>(() => {
  if (tone.value === 'live') return 'online'
  if (tone.value === 'offline') return 'offline'
  return 'syncing'
})

/** The settings gear popover (holds sign-out). */
const menuOpen = ref(false)
function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
}
function onLogout(): void {
  menuOpen.value = false
  emit('logout')
}
</script>

<template>
  <nav
    role="navigation"
    aria-label="Workspaces"
    class="flex h-full w-14 shrink-0 flex-col items-center gap-3 border-r border-subtle bg-surface py-3"
  >
    <!-- Brand logo (the "Ranin" mark). -->
    <div
      class="grid h-9 w-9 select-none place-items-center rounded-md bg-accent font-semibold text-accent-fg"
      aria-label="Ranin"
      role="img"
    >
      R
    </div>

    <!-- Workspace stack: the ONE real workspace, active + indicator dot. -->
    <div class="flex flex-col items-center gap-2">
      <div class="relative">
        <button
          type="button"
          class="grid h-9 w-9 select-none place-items-center overflow-hidden rounded-md bg-strong text-[13px] font-semibold text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          :title="workspaceName"
          :aria-label="workspaceName"
          aria-current="true"
          data-testid="workspace-icon"
          :data-has-icon="showIcon ? 'true' : 'false'"
        >
          <img
            v-if="showIcon && iconUrl"
            :src="iconUrl"
            alt=""
            class="h-full w-full rounded-[inherit] object-cover"
            @error="iconFailed = true"
          />
          <template v-else>{{ workspaceInitials }}</template>
        </button>
        <span
          aria-hidden="true"
          class="absolute -right-1.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-accent"
        />
      </div>
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

    <!-- Theme cycle (light/dark/system), keyboard-operable, in the rail. -->
    <ThemeToggle />

    <!-- Settings gear → popover with sign-out (keeps the `logout` test-id reachable). -->
    <div class="relative">
      <IconButton
        label="Settings"
        title="Settings"
        data-testid="open-settings"
        :aria-expanded="menuOpen"
        @click="toggleMenu"
      >
        <Icon name="settings" :size="18" />
      </IconButton>
      <div
        v-if="menuOpen"
        class="absolute bottom-0 left-full z-20 ml-2 w-40 rounded-md border border-subtle bg-surface-elevated p-1 shadow-xl"
        role="menu"
      >
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-secondary transition-colors hover:bg-surface-hover hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          data-testid="logout"
          @click="onLogout"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            class="h-4 w-4 shrink-0"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6" />
            <path d="M10.5 11 14 8l-3.5-3M14 8H6" />
          </svg>
          Sign out
        </button>
      </div>
    </div>
  </nav>
</template>
