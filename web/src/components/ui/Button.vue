<script setup lang="ts">
// ui/Button.vue — ENG-136 "Ranin" primitive (PR-A, token-styled, not yet mounted).
// Variants: primary (accent fill), ghost (transparent, hover surface), danger
// (danger text + border). Sizes sm/md. Accent focus-visible ring; disabled state;
// passes through type / disabled / aria-* via $attrs (inheritAttrs default true).
import { computed } from 'vue'

type Variant = 'primary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    size?: Size
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
  }>(),
  { variant: 'primary', size: 'md', type: 'button', disabled: false },
)

const base =
  'inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ' +
  'focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50'

const sizeClasses: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12px]',
  md: 'h-8 px-3 text-[13px]',
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent/90',
  ghost: 'bg-transparent text-secondary hover:bg-surface-hover hover:text-primary',
  danger: 'border border-danger bg-transparent text-danger hover:bg-danger/10',
}

const classes = computed(() => [base, sizeClasses[props.size], variantClasses[props.variant]])
</script>

<template>
  <button :type="type" :disabled="disabled" :class="classes">
    <slot />
  </button>
</template>
