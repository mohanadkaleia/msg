<script setup lang="ts">
// ui/IconButton.vue — ENG-136 "Ranin" primitive (PR-A; `label` rename in PR-C).
// A square, icon-only button. A `label` is REQUIRED (icon-only controls are
// otherwise unlabeled) and bound to the native `aria-label`; we fail loudly in dev
// if it's missing/blank. Naming the prop `label` (not `ariaLabel`) avoids shadowing
// the native `aria-label` attribute — the mismatch `vue-tsc`/`vue/attribute-
// hyphenation` fought over. Focus-visible accent ring; hover surface. Icon goes in
// the default slot (inline SVG, currentColor).
import { computed } from 'vue'

type Size = 'sm' | 'md'

const props = withDefaults(
  defineProps<{
    /** REQUIRED accessible name — icon-only buttons have no text. Bound to `aria-label`. */
    label: string
    size?: Size
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
  }>(),
  { size: 'md', type: 'button', disabled: false },
)

// Dev-only guard: an icon button with no accessible name is a bug, not a warning.
if (import.meta.env.DEV && (!props.label || props.label.trim() === '')) {
  throw new Error('[ui/IconButton] `label` is required for an icon-only button.')
}

const base =
  'inline-flex items-center justify-center rounded text-secondary transition-colors ' +
  'hover:bg-surface hover:text-primary focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

const sizeClasses: Record<Size, string> = {
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
}

const classes = computed(() => [base, sizeClasses[props.size]])
</script>

<template>
  <button :type="type" :disabled="disabled" :aria-label="label" :class="classes">
    <slot />
  </button>
</template>
