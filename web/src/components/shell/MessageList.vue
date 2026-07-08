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
import type { PresenceStatus } from '../../worker'
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
    /** The message currently in inline-edit (ENG-102); null = none. */
    editingMessageId?: string | null
    /**
     * Directory `user_id → display_name` map, threaded to each row for the author
     * name + avatar initial. Falls back to the raw id when a name is absent.
     */
    names?: ReadonlyMap<string, string> | undefined
    /**
     * Live presence `user_id → status` map (ENG-128), threaded to each row for the
     * author avatar's presence dot. Absent ⇒ rows render no dot.
     */
    presence?: ReadonlyMap<string, PresenceStatus> | undefined
    /**
     * INTERIM unread count for the "New" divider (ENG-136). There is no
     * `readState.get` RPC exposed to the tab yet, so the divider is placed before
     * the last `unreadCount` messages — a VISUAL APPROXIMATION. Exact placement
     * needs a real read-state query (a later follow-up).
     */
    unreadCount?: number
  }>(),
  {
    hasMore: false,
    rowHeight: 64,
    overscan: 6,
    streamKey: null,
    loadOlder: () => Promise.resolve(0),
    editingMessageId: null,
    names: undefined,
    presence: undefined,
    unreadCount: 0,
  },
)

const emit = defineEmits<{
  retry: [messageId: string]
  discard: [messageId: string]
  react: [messageId: string, emoji: string, remove: boolean]
  'edit-start': [messageId: string]
  'edit-submit': [messageId: string, text: string]
  'edit-cancel': []
  delete: [messageId: string]
  'open-thread': [rootMessageId: string]
}>()

/** Consecutive messages from the same author within this window are grouped. */
const GROUP_WINDOW_MS = 5 * 60 * 1000

/** A flat render item: a day divider, the "New" unread divider, or a message. */
type RenderItem =
  | { type: 'divider'; key: string; label: string }
  | { type: 'new'; key: string }
  | { type: 'message'; key: string; message: DisplayMessage; showHeader: boolean }

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const measuredHeight = ref(0)
let atBottom = true
let prepending = false
let loadingOlder = false

/**
 * Interleave day dividers (calendar-day boundaries), the "New" unread divider, and
 * messages — computing `showHeader` per message so consecutive messages from the
 * same author within GROUP_WINDOW_MS render grouped (avatar/name/time hidden).
 */
const items = computed<RenderItem[]>(() => {
  const out: RenderItem[] = []
  let lastDay: string | null = null
  let prev: DisplayMessage | null = null
  const total = props.messages.length
  // INTERIM: place the divider before the last `unreadCount` messages (clamped).
  const unread = Math.min(Math.max(props.unreadCount, 0), total)
  const firstUnreadIndex = unread > 0 ? total - unread : -1
  props.messages.forEach((message, index) => {
    const key = dayKey(message.ts)
    const dayBoundary = key !== lastDay
    if (dayBoundary) {
      out.push({ type: 'divider', key: `d:${key}`, label: formatDayDivider(message.ts) })
      lastDay = key
    }
    const isFirstUnread = index === firstUnreadIndex
    if (isFirstUnread) out.push({ type: 'new', key: `new:${message.message_id}` })
    // A day boundary or the "New" divider always starts a fresh group.
    const showHeader =
      dayBoundary ||
      isFirstUnread ||
      prev === null ||
      prev.author_user_id !== message.author_user_id ||
      message.ts - prev.ts > GROUP_WINDOW_MS
    out.push({ type: 'message', key: message.message_id, message, showHeader })
    prev = message
  })
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

/** The row briefly highlighted after a search jump (ENG-127); null = none. */
const flashId = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Jump-to-message (ENG-127 search): scroll the virtualized window to `messageId`
 * and briefly highlight the row. BEST-EFFORT: returns false when the message is
 * not in the LOADED window — deep-scrolling to an arbitrary historical hit would
 * need loading pages around it (a follow-up); the caller then simply leaves the
 * channel open at its tail.
 */
function scrollToMessage(messageId: string): boolean {
  const index = items.value.findIndex((i) => i.type === 'message' && i.key === messageId)
  if (index === -1) return false
  const el = scroller.value
  if (el) {
    // Land the row mid-viewport via the windowing math, then let the real DOM
    // node fine-tune (jsdom lacks scrollIntoView — guarded).
    el.scrollTop = Math.max(0, index * props.rowHeight - viewport.value / 2)
    scrollTop.value = el.scrollTop
    atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < props.rowHeight
  }
  void nextTick(() => {
    const row = el?.querySelector(`[data-message-id="${messageId}"]`)
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' })
  })
  flashId.value = messageId
  if (flashTimer !== undefined) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashId.value = null
  }, 1600)
  return true
}

defineExpose({ scrollToMessage })

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
  if (flashTimer !== undefined) clearTimeout(flashTimer)
})
</script>

<template>
  <div
    ref="scroller"
    class="flex-1 overflow-y-auto bg-background"
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
            class="rounded-full border border-subtle bg-surface-elevated px-3 py-0.5 text-xs font-medium text-secondary shadow-sm"
          >
            {{ item.label }}
          </span>
        </div>
        <!-- INTERIM "New" unread divider (ENG-136): a rule with a right-aligned
             accent "New" label. Placement is approximate until a readState.get RPC
             lands (see the `unreadCount` prop note). -->
        <div v-else-if="item.type === 'new'" class="relative my-2" data-testid="new-divider">
          <hr class="border-subtle" />
          <span
            class="absolute -top-2 right-4 bg-background px-2 text-[11px] font-medium text-accent"
          >
            New
          </span>
        </div>
        <MessageItem
          v-else
          :message="item.message"
          :show-header="item.showHeader"
          :names="props.names"
          :presence="props.presence"
          :editing="item.message.message_id === props.editingMessageId"
          :flash="item.message.message_id === flashId"
          @retry="emit('retry', $event)"
          @discard="emit('discard', $event)"
          @react="(id, emoji, remove) => emit('react', id, emoji, remove)"
          @edit-start="emit('edit-start', $event)"
          @edit-submit="(id, text) => emit('edit-submit', id, text)"
          @edit-cancel="emit('edit-cancel')"
          @delete="emit('delete', $event)"
          @open-thread="emit('open-thread', $event)"
        />
      </template>
    </div>
  </div>
</template>
