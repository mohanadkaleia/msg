<script setup lang="ts">
// ui/NavGroup.vue — ENG-152 sidebar-group restyle. A TOP-LEVEL collapsible nav
// group (DMs / Channels / Workspace): the former static 11px uppercase header
// becomes a toggle button — optional leading `#icon` slot, title, and a
// right-aligned chevron (down = expanded, right = collapsed) — over an INDENTED
// item block with a single thin connector rule (`border-l border-subtle`,
// tokens only) running down its left edge, visually tying the group's items to
// the header.
//
// Distinct from ui/NavSection (the smaller sub-sections, e.g. Admin, that nest
// INSIDE a group): only the group draws the connector line, so there is exactly
// one rule per group, never nested double rails.
//
// The optional trailing `#action` slot (ENG-152 sidebar restructure) renders
// OUTSIDE the toggle button — e.g. the DMs "+" / Channels "⌕ +" affordances —
// so clicking an action never collapses the group.
//
// Collapsed/expanded state persists per group in localStorage
// (`msg:nav-group:<storageKey>` — the same guarded read/write pattern as
// composables/useTheme). Default EXPANDED; absent/junk values fall back to
// expanded so a fresh profile (and every E2E run) sees the full nav.
//
// `data-testid` (and any other attrs) land on the HEADER BUTTON via $attrs —
// preserving `nav-group-dms` / `nav-group-channels` / `nav-group-workspace` as
// the addressable (interactive) header element.
import { ref } from 'vue'

import Icon from './Icon.vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  title: string
  /** Persistence id — suffix of the localStorage key (`msg:nav-group:<storageKey>`). */
  storageKey: string
}>()

const STORAGE_PREFIX = 'msg:nav-group:'

/** Read the persisted state, tolerating no-storage envs and junk values. */
function readStored(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + props.storageKey) !== 'collapsed'
  } catch {
    // localStorage can throw (private mode / disabled) — default expanded.
    return true
  }
}

const open = ref(readStored())

function toggle(): void {
  open.value = !open.value
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      STORAGE_PREFIX + props.storageKey,
      open.value ? 'expanded' : 'collapsed',
    )
  } catch {
    // Persisting is best-effort; the in-memory state still drives the UI.
  }
}
</script>

<template>
  <section>
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-secondary transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        :aria-expanded="open"
        v-bind="$attrs"
        @click="toggle"
      >
        <span v-if="$slots.icon" aria-hidden="true" class="flex shrink-0 items-center text-muted">
          <slot name="icon" />
        </span>
        <span class="truncate">{{ title }}</span>
        <span aria-hidden="true" class="ml-auto flex shrink-0 items-center text-muted">
          <Icon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
        </span>
      </button>
      <span v-if="$slots.action" class="shrink-0 pr-1">
        <slot name="action" />
      </span>
    </div>
    <!-- The indented item block: one thin token-styled connector rule down its
         left edge (subtle, not loud). v-show (not v-if) so collapse/expand never
         re-mounts stream rows. -->
    <div
      v-show="open"
      class="ml-3.5 mt-0.5 space-y-1 border-l border-subtle pl-2"
      data-testid="nav-group-items"
    >
      <slot />
    </div>
  </section>
</template>
