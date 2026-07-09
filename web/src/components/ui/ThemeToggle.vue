<script setup lang="ts">
// ui/ThemeToggle.vue — ENG-136 "Ranin" primitive. Cycles light -> dark -> system
// and reflects the current preference with an icon. BUILT IN PR-A, MOUNTED IN
// PR-D — until then useTheme is inert (index.html pins data-theme="light").
// A native <button> (keyboard-operable) with a dynamic aria-label.
import { computed } from 'vue'

import { useTheme } from '../../composables/useTheme'

const { theme, cycleTheme } = useTheme()

const label = computed(() => {
  switch (theme.value) {
    case 'light':
      return 'Theme: light. Switch to dark.'
    case 'dark':
      return 'Theme: dark. Switch to system.'
    default:
      return 'Theme: system. Switch to light.'
  }
})
</script>

<template>
  <button
    type="button"
    :aria-label="label"
    :title="label"
    class="inline-flex h-7 w-7 items-center justify-center rounded text-secondary transition-colors hover:bg-surface-hover hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    @click="cycleTheme"
  >
    <!-- light: sun -->
    <svg
      v-if="theme === 'light'"
      aria-hidden="true"
      viewBox="0 0 16 16"
      class="h-4 w-4"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M13 3l-1 1M4 12l-1 1" />
    </svg>
    <!-- dark: moon -->
    <svg
      v-else-if="theme === 'dark'"
      aria-hidden="true"
      viewBox="0 0 16 16"
      class="h-4 w-4"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
    </svg>
    <!-- system: monitor -->
    <svg
      v-else
      aria-hidden="true"
      viewBox="0 0 16 16"
      class="h-4 w-4"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" />
      <path d="M5.5 14h5M8 11v3" />
    </svg>
  </button>
</template>
