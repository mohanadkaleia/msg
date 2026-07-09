<script setup lang="ts">
// ui/SidebarItem.vue — ENG-136 "Ranin" primitive (PR-A; PR-3 `#leading` slot).
// States: default (text-secondary), hover (surface), active (accent-subtle bg +
// text-primary + a subtle left accent marker), unread (text-primary + medium).
// Renders as <button> by default, or <a> when `href` is given. Optional `#leading`
// slot renders a 16–18px icon/avatar before the label (ADDITIVE — call-sites
// without it are unchanged); `#trailing` slot for a badge/count. `data-testid`
// passes through via $attrs.
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    active?: boolean
    unread?: boolean
    href?: string
  }>(),
  { active: false, unread: false, href: '' },
)

const tag = computed(() => (props.href ? 'a' : 'button'))

const base =
  'group relative flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[13px] ' +
  'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-background'

const stateClasses = computed(() => {
  if (props.active) return 'bg-accent-subtle text-primary'
  if (props.unread) return 'text-primary hover:bg-surface-hover'
  return 'text-secondary hover:bg-surface-hover hover:text-primary'
})

const weightClass = computed(() => (props.unread && !props.active ? 'font-medium' : 'font-normal'))
</script>

<template>
  <component :is="tag" :href="href || undefined" :class="[base, stateClasses, weightClass]">
    <!-- Left accent marker for the active row (calm, not a full bar). -->
    <span
      v-if="active"
      aria-hidden="true"
      class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent"
    />
    <!-- Optional leading icon/avatar (16–18px), muted until active/hover. -->
    <span
      v-if="$slots.leading"
      aria-hidden="true"
      class="flex shrink-0 items-center justify-center text-muted group-hover:text-secondary"
      :class="{ 'text-secondary': active }"
    >
      <slot name="leading" />
    </span>
    <span class="min-w-0 flex-1 truncate"><slot /></span>
    <span v-if="$slots.trailing" class="ml-auto flex shrink-0 items-center">
      <slot name="trailing" />
    </span>
  </component>
</template>
