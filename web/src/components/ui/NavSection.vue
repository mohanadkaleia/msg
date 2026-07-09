<script setup lang="ts">
// ui/NavSection.vue — ENG-136 "Ranin" primitive (PR-A; PR-3 `#icon` slot). A
// collapsible sidebar section: an 11px uppercase tracking-wide header (bumped to
// text-secondary in ENG-152 PR-c — the muted grey read too flat) with a
// chevron toggling the body (v-show), an optional leading `#icon` slot (a 16px
// outline glyph before the title — ADDITIVE), an optional trailing action slot
// (e.g. a `+` IconButton), and the default slot for the section's items.
import { ref } from 'vue'

const props = withDefaults(defineProps<{ title: string; defaultOpen?: boolean }>(), {
  defaultOpen: true,
})

const open = ref(props.defaultOpen)
function toggle(): void {
  open.value = !open.value
}
</script>

<template>
  <section>
    <div class="flex items-center gap-1 px-2">
      <button
        type="button"
        class="flex flex-1 items-center gap-1 rounded py-1 text-[11px] font-semibold uppercase tracking-wide text-secondary transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        :aria-expanded="open"
        @click="toggle"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          class="h-3 w-3 shrink-0 transition-transform"
          :class="open ? 'rotate-90' : ''"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4.5 3 8 6l-3.5 3" />
        </svg>
        <span v-if="$slots.icon" aria-hidden="true" class="flex shrink-0 items-center">
          <slot name="icon" />
        </span>
        <span class="truncate">{{ title }}</span>
      </button>
      <span v-if="$slots.action" class="shrink-0">
        <slot name="action" />
      </span>
    </div>
    <div v-show="open" class="mt-0.5 space-y-px">
      <slot />
    </div>
  </section>
</template>
