<script setup lang="ts">
// SyncIndicator — the reconnect/offline status pill (ENG-82), driven entirely by
// the ENG-79 sync engine status mirrored in the sync store. A coloured dot +
// label: green = live, amber pulsing = connecting/syncing, red = offline/degraded.
import { storeToRefs } from 'pinia'

import { useSyncStore } from '../../stores/sync'

const sync = useSyncStore()
const { tone, label } = storeToRefs(sync)

const DOT: Record<string, string> = {
  live: 'bg-emerald-500',
  syncing: 'bg-amber-500 animate-pulse',
  offline: 'bg-red-500',
}
</script>

<template>
  <div
    class="flex items-center gap-2 text-xs text-slate-500"
    data-testid="sync-indicator"
    :data-tone="tone"
  >
    <span class="h-2 w-2 rounded-full" :class="DOT[tone]" aria-hidden="true" />
    <span>{{ label }}</span>
  </div>
</template>
