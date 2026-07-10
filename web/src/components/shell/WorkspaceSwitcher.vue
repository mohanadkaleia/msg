<script setup lang="ts">
// WorkspaceSwitcher — ENG-136 "Ranin" workspace selector pill (PR-3; ENG-152
// PR-b hierarchy; ENG-152 nav cleanup). A single row under the sidebar header:
// a leading rounded workspace glyph (the same initials as the rail square —
// they ARE the same workspace) + the REAL workspace name over a muted "Local
// workspace" sub-label, + a `chevron-down`.
//
// ENG-152 nav cleanup (user feedback): clicking the pill previously opened the
// Cmd+K palette — a leftover from the palette's quick-switcher days that read
// as crossed wiring ("Switch workspace" ≠ a command launcher). The pill now
// opens a REAL workspace menu listing the workspaces this client knows about:
// exactly one (the local-first workspace), shown as current — honest, no
// invented workspaces. Popover mechanics mirror NewButton (toggle, Escape and
// outside click close). The `open-switcher` test-id stays on the pill.
import { computed, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'

import { useWorkspaceIconUrl } from '../../composables/useWorkspaceIconUrl'
import Icon from '../ui/Icon.vue'

const props = defineProps<{
  workspaceName: string
  workspaceInitials: string
  /** ENG-152: the folded workspace icon sha (undefined = no icon → glyph). */
  workspaceIconSha?: string | undefined
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

// ENG-152: the workspace icon image (worker-fetched by sha) shown in the pill +
// menu glyphs. Falls back to the initials glyph when absent, on a 404, or on a
// load error (img @error).
const { url: iconUrl } = useWorkspaceIconUrl(() => toRef(props, 'workspaceIconSha').value)
const iconFailed = ref(false)
watch(iconUrl, () => {
  iconFailed.value = false
})
const showIcon = computed(() => iconUrl.value !== null && !iconFailed.value)

/** Close on a click anywhere outside the pill + menu. */
function onDocumentClick(event: MouseEvent): void {
  if (!open.value) return
  const el = root.value
  if (el && event.target instanceof Node && !el.contains(event.target)) open.value = false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<template>
  <div ref="root" class="relative px-2">
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      data-testid="open-switcher"
      title="Switch workspace"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span
        aria-hidden="true"
        class="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-md bg-accent-subtle text-[11px] font-semibold text-accent"
      >
        <img
          v-if="showIcon && iconUrl"
          :src="iconUrl"
          alt=""
          class="h-full w-full rounded-[inherit] object-cover"
          @error="iconFailed = true"
        />
        <template v-else>{{ workspaceInitials }}</template>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[13px] font-semibold text-primary">{{
          workspaceName
        }}</span>
        <span class="block truncate text-[11px] text-muted">Local workspace</span>
      </span>
      <Icon name="chevron-down" :size="16" class="shrink-0 text-muted" />
    </button>

    <!-- The workspace menu: the one local workspace, marked current. -->
    <div
      v-if="open"
      role="menu"
      aria-label="Workspaces"
      data-testid="workspace-menu"
      class="absolute left-2 right-2 top-full z-30 mt-1 rounded-md border border-subtle bg-surface-elevated p-1 shadow-md"
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked="true"
        data-testid="workspace-menu-current"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-primary transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        @click="open = false"
      >
        <span
          aria-hidden="true"
          class="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-md bg-accent-subtle text-[10px] font-semibold text-accent"
        >
          <img
            v-if="showIcon && iconUrl"
            :src="iconUrl"
            alt=""
            class="h-full w-full rounded-[inherit] object-cover"
            @error="iconFailed = true"
          />
          <template v-else>{{ workspaceInitials }}</template>
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium">{{ workspaceName }}</span>
          <span class="block truncate text-[11px] text-muted">Local workspace</span>
        </span>
        <Icon name="check" :size="16" class="shrink-0 text-accent" />
      </button>
      <p class="px-2 pb-1 pt-1.5 text-[11px] text-muted">This device hosts one local workspace.</p>
    </div>
  </div>
</template>
