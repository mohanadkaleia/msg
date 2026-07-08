<script setup lang="ts">
// ui/StatusBadge.vue — ENG-136 "Ranin" primitive (PR-A). A small status dot with
// an optional label. `tone` maps to a token color; used later for sync + presence.
// `syncing` animates (pulse); `online`/`success` share the success token; `offline`
// reads as urgent (danger, PR-B review #3) rather than a muted grey.
import { computed } from 'vue'

type Tone = 'online' | 'success' | 'syncing' | 'sync-pending' | 'offline' | 'danger' | 'muted'

const props = withDefaults(defineProps<{ tone?: Tone; label?: string }>(), {
  tone: 'muted',
  label: '',
})

const dotColor: Record<Tone, string> = {
  online: 'bg-success',
  success: 'bg-success',
  syncing: 'bg-accent',
  'sync-pending': 'bg-sync-pending',
  offline: 'bg-danger',
  danger: 'bg-danger',
  muted: 'bg-muted',
}

const dotClasses = computed(() => [
  'h-2 w-2 shrink-0 rounded-full',
  dotColor[props.tone],
  props.tone === 'syncing' ? 'animate-pulse' : '',
])
</script>

<template>
  <span class="inline-flex items-center gap-1.5 text-[12px] text-secondary">
    <span :class="dotClasses" aria-hidden="true" />
    <span v-if="label">{{ label }}</span>
  </span>
</template>
