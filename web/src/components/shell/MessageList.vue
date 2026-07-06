<script setup lang="ts">
// MessageList — the virtualized/windowed message scroller (ENG-82).
//
// VIRTUALIZATION (required, §14): only the visible window + a small overscan is
// rendered, so a channel with tens of thousands of messages stays smooth. Items
// (day dividers + messages) are laid out at a fixed estimated row height; top/
// bottom spacer padding stands in for the off-screen rows. DAY DIVIDERS are
// inserted at local-calendar-day boundaries (time recovered from the ULID id).
// SCROLL-TOP BACKFILL: nearing the top calls `loadOlder()` (which runs the ENG-79
// `sync.backfill` pull + prepend); scroll position is preserved by re-anchoring
// scrollTop to the height the prepended page added.
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'

import type { DisplayMessage } from '../../stores/messages'
import { dayKey, formatDayDivider } from '../../lib/time'
import MessageItem from './MessageItem.vue'

const props = withDefaults(
  defineProps<{
    messages: DisplayMessage[]
    hasMore?: boolean
    /** Estimated row height (px) for the windowing math. */
    rowHeight?: number
    /** Extra rows rendered above/below the viewport to hide fast-scroll gaps. */
    overscan?: number
    /** Explicit viewport height (px) — test override; else measured from the DOM. */
    // eslint-disable-next-line vue/require-default-prop -- optional; falls back to measured height
    viewportHeight?: number
    /** Stream id — a change resets the scroll to the newest message. */
    streamKey?: string | null
    /** Pull the previous page; resolves to the number of rows prepended. */
    loadOlder?: () => Promise<number>
  }>(),
  {
    hasMore: false,
    rowHeight: 64,
    overscan: 6,
    streamKey: null,
    loadOlder: () => Promise.resolve(0),
  },
)

const emit = defineEmits<{ retry: [messageId: string]; discard: [messageId: string] }>()

/** A flat render item: a day divider or a message. */
type RenderItem =
  | { type: 'divider'; key: string; label: string }
  | { type: 'message'; key: string; message: DisplayMessage }

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const measuredHeight = ref(0)
let atBottom = true
let prepending = false
let loadingOlder = false

/** Interleave day dividers between messages that cross a calendar-day boundary. */
const items = computed<RenderItem[]>(() => {
  const out: RenderItem[] = []
  let lastDay: string | null = null
  for (const message of props.messages) {
    const key = dayKey(message.ts)
    if (key !== lastDay) {
      out.push({ type: 'divider', key: `d:${key}`, label: formatDayDivider(message.ts) })
      lastDay = key
    }
    out.push({ type: 'message', key: message.message_id, message })
  }
  return out
})

const viewport = computed(() => props.viewportHeight ?? (measuredHeight.value || 600))

const windowRange = computed(() => {
  const total = items.value.length
  const perView = Math.ceil(viewport.value / props.rowHeight)
  const start = Math.max(0, Math.floor(scrollTop.value / props.rowHeight) - props.overscan)
  const end = Math.min(total, start + perView + props.overscan * 2)
  return { start, end }
})

const visibleItems = computed(() =>
  items.value.slice(windowRange.value.start, windowRange.value.end),
)
const topPad = computed(() => windowRange.value.start * props.rowHeight)
const bottomPad = computed(() => (items.value.length - windowRange.value.end) * props.rowHeight)

function measure(): void {
  if (scroller.value) measuredHeight.value = scroller.value.clientHeight
}

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  scrollTop.value = el.scrollTop
  atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < props.rowHeight
  if (el.scrollTop <= props.rowHeight * 2) void onReachTop()
}

/** Scroll-top: pull older history and re-anchor so the viewport does not jump. */
async function onReachTop(): Promise<void> {
  const el = scroller.value
  if (!el || !props.loadOlder || !props.hasMore || loadingOlder) return
  loadingOlder = true
  prepending = true
  const beforeHeight = el.scrollHeight
  const beforeTop = el.scrollTop
  try {
    const added = await props.loadOlder()
    await nextTick()
    if (added > 0) {
      el.scrollTop = beforeTop + (el.scrollHeight - beforeHeight)
      scrollTop.value = el.scrollTop
    }
  } finally {
    loadingOlder = false
  }
}

function scrollToBottom(): void {
  const el = scroller.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  scrollTop.value = el.scrollTop
  atBottom = true
}

// Stream change → jump to the newest message.
watch(
  () => props.streamKey,
  () => {
    void nextTick(scrollToBottom)
  },
)

// New messages: follow the tail only if the user was already at the bottom; a
// prepend (scrollback) re-anchors itself and must not yank to the bottom.
watch(
  () => props.messages.length,
  () => {
    if (prepending) {
      prepending = false
      return
    }
    if (atBottom) void nextTick(scrollToBottom)
  },
)

onMounted(() => {
  measure()
  scrollToBottom()
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
})
</script>

<template>
  <div
    ref="scroller"
    class="flex-1 overflow-y-auto bg-white"
    data-testid="message-list"
    @scroll="onScroll"
  >
    <div :style="{ paddingTop: `${topPad}px`, paddingBottom: `${bottomPad}px` }">
      <template v-for="item in visibleItems" :key="item.key">
        <div
          v-if="item.type === 'divider'"
          class="sticky top-0 z-10 my-2 flex items-center justify-center"
          data-testid="day-divider"
        >
          <span
            class="rounded-full border border-slate-200 bg-white px-3 py-0.5 text-xs font-medium text-slate-500 shadow-sm"
          >
            {{ item.label }}
          </span>
        </div>
        <MessageItem
          v-else
          :message="item.message"
          @retry="emit('retry', $event)"
          @discard="emit('discard', $event)"
        />
      </template>
    </div>
  </div>
</template>
