<script setup lang="ts">
// UserCard — ENG-136 "Ranin" sidebar footer (PR-3). The signed-in user's card:
// an avatar (initial) with a presence dot, the REAL display name, a presence
// label, and a `chevron-down` (SCAFFOLD account menu — no-op for now).
//
// The presence dot color is REAL: it reflects the current user's status from the
// ENG-126 presence snapshot (via the presence store), `bg-success` when online and
// a muted dot when offline. `name` is resolved from the directory upstream.
//
// SECURITY: `name` is user-controlled — rendered via text interpolation only.
import { computed } from 'vue'

import type { PresenceStatus } from '../../worker'
import Icon from '../ui/Icon.vue'
import PresenceDot from '../ui/PresenceDot.vue'

const props = withDefaults(defineProps<{ name: string; status?: PresenceStatus }>(), {
  status: 'online',
})

const initial = computed(() => (props.name.trim()[0] ?? '?').toUpperCase())
const online = computed(() => props.status === 'online')
const statusLabel = computed(() => (online.value ? 'Online' : 'Offline'))
/** Narrowed for the dot (exactOptionalPropertyTypes: the default is 'online'). */
const dotStatus = computed<PresenceStatus>(() => props.status ?? 'online')
</script>

<template>
  <button
    type="button"
    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    data-testid="user-card"
  >
    <span class="relative shrink-0">
      <span
        aria-hidden="true"
        class="grid h-7 w-7 place-items-center rounded-full bg-accent-subtle text-[12px] font-semibold text-accent"
        >{{ initial }}</span
      >
      <PresenceDot
        :status="dotStatus"
        class="absolute -bottom-0.5 -right-0.5 border-2 border-surface"
      />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-[13px] font-medium text-primary">{{ name }}</span>
      <span class="block text-xs text-muted">{{ statusLabel }}</span>
    </span>
    <Icon name="chevron-down" :size="16" class="shrink-0 text-muted" />
  </button>
</template>
