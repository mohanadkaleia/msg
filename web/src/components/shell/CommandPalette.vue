<script setup lang="ts">
// CommandPalette — the Cmd/Ctrl+K fuzzy quick-switcher (ENG-82). Fed from the
// workspace-meta projection (channels + DMs) as plain `QuickItem`s, it is the
// surface that defines the "fast feel" (§5.4): keyboard-first, fuzzy, instant.
// Open → focus, type → fuzzy-rank, ↑/↓ move, Enter navigates, Esc closes.
// SECURITY: item labels are other users' input — text interpolation only.
import { computed, nextTick, ref, watch } from 'vue'

import { fuzzyFilter } from '../../lib/fuzzy'

/** One switchable target: a channel or DM. */
export interface QuickItem {
  id: string
  label: string
  kind: string
  unread: number
}

const props = defineProps<{ open: boolean; items: QuickItem[] }>()
const emit = defineEmits<{ select: [id: string]; close: [] }>()

const query = ref('')
const activeIndex = ref(0)
const input = ref<HTMLInputElement | null>(null)

const results = computed(() =>
  fuzzyFilter(props.items, query.value, (i) => i.label).map((m) => m.item),
)

// Reset + focus each time the palette opens.
watch(
  () => props.open,
  (open) => {
    if (open) {
      query.value = ''
      activeIndex.value = 0
      void nextTick(() => input.value?.focus())
    }
  },
)

// Keep the highlight within the (shrinking) result set as the query narrows.
watch(results, (r) => {
  if (activeIndex.value >= r.length) activeIndex.value = Math.max(0, r.length - 1)
})

function move(delta: number): void {
  const n = results.value.length
  if (n === 0) return
  activeIndex.value = (activeIndex.value + delta + n) % n
}

function choose(index: number): void {
  const item = results.value[index]
  if (item) emit('select', item.id)
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Enter':
      event.preventDefault()
      choose(activeIndex.value)
      break
    case 'Escape':
      event.preventDefault()
      emit('close')
      break
  }
}

function labelFor(item: QuickItem): string {
  return item.kind === 'dm' ? item.label : `# ${item.label}`
}
</script>

<template>
  <div
    v-if="props.open"
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]"
    data-testid="command-palette"
    @click.self="emit('close')"
  >
    <div
      class="w-full max-w-lg overflow-hidden rounded-lg border border-subtle bg-surface-elevated shadow-xl"
    >
      <input
        ref="input"
        v-model="query"
        type="text"
        placeholder="Jump to a channel or person…"
        class="w-full border-b border-subtle bg-transparent px-4 py-3 text-sm text-primary outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        data-testid="command-palette-input"
        @keydown="onKeydown"
      />
      <ul class="max-h-80 overflow-y-auto py-1">
        <li v-if="results.length === 0" class="px-4 py-3 text-sm text-muted">No matches</li>
        <li
          v-for="(item, index) in results"
          :key="item.id"
          class="flex cursor-pointer items-center justify-between px-4 py-2 text-sm"
          :class="index === activeIndex ? 'bg-accent-subtle text-primary' : 'text-secondary'"
          data-testid="command-palette-item"
          :data-active="index === activeIndex"
          @click="choose(index)"
          @mousemove="activeIndex = index"
        >
          <span class="truncate">{{ labelFor(item) }}</span>
          <span
            v-if="item.unread > 0"
            class="ml-2 shrink-0 rounded-full bg-strong px-1.5 text-xs text-secondary"
            >{{ item.unread }}</span
          >
        </li>
      </ul>
    </div>
  </div>
</template>
