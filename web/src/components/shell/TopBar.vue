<script setup lang="ts">
// TopBar — ENG-136 "Ranin" top bar (PR-3; ENG-152 nav cleanup). A full-width row
// above the main + drawer region: a centered search "input" (a button — the shell
// opens the unified search modal from it; the `⌘/` hint chip matches the global
// search shortcut, while `⌘K` belongs to the command palette) and a right-aligned
// `more` menu (SCAFFOLD — no items wired yet).
//
// ENG-152 nav cleanup (user feedback): the compose (`square-pen`) button was
// REMOVED — the sidebar's "+ New" button is the shell's ONE primary create
// action, so a second top-bar compose affordance was redundant. The scaffold
// notifications bell was REMOVED too — new-message indication lives on the
// Inbox nav item's REAL unread badge (`inbox-unread`), the triage surface.
//
// ENG-152 PR-b: an EXPLICIT sync-state pill sits on the right (`topbar-sync`) —
// the local-first identity signal. It is a pure read of the ENG-82 sync store
// (`tone` + `label`); the worker stays the single source of truth. The store's
// `SyncStatus` exposes no pending-outbox count, so the pill renders exactly
// Synced / Syncing… / Offline — no invented data.
import { computed } from 'vue'
import { storeToRefs } from 'pinia'

import { useSyncStore } from '../../stores/sync'
import Icon from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'

const emit = defineEmits<{ search: [] }>()

const sync = useSyncStore()
const { tone, label } = storeToRefs(sync)

/** Pill copy: local-first framing — "Synced" when live, the store label otherwise. */
const syncText = computed(() => {
  if (tone.value === 'live') return 'Synced'
  if (tone.value === 'offline') return 'Offline'
  return label.value // 'Syncing…' / 'Connecting…' / 'Idle'
})
</script>

<template>
  <div class="flex items-center gap-3 border-b border-subtle px-4 py-2">
    <!-- Centered search — opens the unified search modal (ENG-127/ENG-152). -->
    <div class="mx-auto w-full max-w-xl">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-md border border-subtle bg-surface px-3 py-1.5 text-left text-secondary transition-colors hover:border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        data-testid="topbar-search"
        @click="emit('search')"
      >
        <Icon name="search" :size="16" class="shrink-0 text-muted" />
        <span class="min-w-0 flex-1 truncate text-[13px] text-muted">Search anything…</span>
        <kbd
          class="shrink-0 rounded border border-subtle px-1.5 text-[11px] leading-tight text-muted"
          >⌘/</kbd
        >
      </button>
    </div>

    <!-- Explicit sync-state pill (ENG-152) — the local-first signal in the bar. -->
    <div
      class="flex shrink-0 items-center gap-1.5 rounded-full border border-subtle px-2.5 py-1 text-[11px] text-secondary"
      data-testid="topbar-sync"
      :data-tone="tone"
      :title="label"
    >
      <Icon
        v-if="tone === 'syncing'"
        name="refresh"
        :size="12"
        class="shrink-0 animate-spin text-accent"
        aria-hidden="true"
      />
      <span
        v-else
        aria-hidden="true"
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :class="tone === 'live' ? 'bg-success' : 'bg-danger'"
      />
      <span>{{ syncText }}</span>
    </div>

    <!-- Right-aligned actions. SCAFFOLD: overflow menu (no items wired). -->
    <div class="flex shrink-0 items-center gap-1">
      <IconButton label="More" title="More">
        <Icon name="more-horizontal" :size="18" />
      </IconButton>
    </div>
  </div>
</template>
