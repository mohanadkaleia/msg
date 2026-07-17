<script setup lang="ts">
// MessageList — the virtualized/windowed message scroller (ENG-82).
//
// VIRTUALIZATION (required, §14): only the visible window + a small overscan is
// rendered, so a channel with tens of thousands of messages stays smooth. Top/
// bottom spacer padding stands in for the off-screen rows.
//
// DYNAMIC ROW HEIGHT (ENG-88): rows are NOT a fixed height — a wrapped long
// message, a failed-row retry/delete affordance, attachments, and ~28px day
// dividers all differ. Each rendered row is MEASURED (a ResizeObserver catches
// late layout: images loading, edits, reactions) into a `key → height` cache;
// a cumulative-offset prefix-sum over the cache drives the window + spacer pads
// via binary search. Unmeasured rows (never yet on screen) and environments
// without layout/ResizeObserver (jsdom) fall back to the `rowHeight` estimate,
// so the fixed-height behavior is exactly the estimate case. DAY DIVIDERS are
// inserted at local-calendar-day boundaries (time recovered from the ULID id).
// SCROLL-TOP BACKFILL: nearing the top calls `loadOlder()` (which runs the ENG-79
// `sync.backfill` pull + prepend); scroll position is preserved by re-anchoring
// scrollTop to the REAL `scrollHeight` delta the prepended page added (never the
// estimate), so backfill re-anchoring is unaffected by measurement.
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue'

import type { DisplayMessage } from '../../stores/messages'
import { dayKey, formatDayDivider } from '../../lib/time'
import MessageItem from './MessageItem.vue'

const props = withDefaults(
  defineProps<{
    messages: DisplayMessage[]
    hasMore?: boolean
    /** Estimated row height (px) — the fallback for rows not yet measured. */
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
     * Directory `user_id → avatar_sha256` map (ENG-152), threaded to each row so
     * the leading chip renders the author's avatar IMAGE when set (else initials).
     */
    avatars?: ReadonlyMap<string, string> | undefined
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
    avatars: undefined,
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

// -- dynamic row heights (ENG-88) -------------------------------------------
//
// `heights` caches each row's REAL vertical footprint (border-box height + its
// top margin — rows carry only top margins, so summing them never double-counts
// a collapsed margin). It is a plain (non-reactive) Map; `heightVersion` is the
// single reactive trigger, bumped once per animation frame after a measurement
// changes, so the offset/window computeds recompute without per-row reactivity.
const heights = new Map<string, number>()
const heightVersion = ref(0)
/** element → its row key, for the ResizeObserver callback (mount/unmount safe). */
const elToKey = new WeakMap<Element, string>()
/** row key → its live element, so unmount can `unobserve` the exact node. */
const keyToEl = new Map<string, Element>()
let ro: ResizeObserver | undefined
let bumpQueued = false

function resolveEl(r: Element | ComponentPublicInstance | null): Element | null {
  if (r === null) return null
  if (r instanceof Element) return r
  const el: unknown = r.$el // a component ref → its (single) root element
  return el instanceof Element ? el : null
}

/** A row's total vertical space: border-box height + its (top-only) margin. */
function measureRow(el: Element): number {
  const rect = el.getBoundingClientRect()
  const mt = parseFloat(getComputedStyle(el).marginTop) || 0
  return rect.height + mt
}

/** Record a measured height; schedule ONE coalesced recompute if it changed. */
function applyMeasure(key: string, h: number): void {
  if (h <= 0 || heights.get(key) === h) return // 0 = no layout (jsdom) → keep estimate
  heights.set(key, h)
  if (bumpQueued || typeof requestAnimationFrame === 'undefined') {
    if (!bumpQueued) heightVersion.value++ // no rAF (SSR) → bump inline
    return
  }
  bumpQueued = true
  requestAnimationFrame(() => {
    bumpQueued = false
    heightVersion.value++
    // Keep the tail pinned while heights settle from estimate → real (opening a
    // channel measures its newest rows just after the initial scroll-to-bottom).
    if (atBottom && !prepending && !loadingOlder) scrollToBottom()
  })
}

/** v-for row ref: (un)observe + measure. Vue calls with the element on mount and
 *  `null` (via the same key-bound closure) on unmount. */
function setRow(r: Element | ComponentPublicInstance | null, key: string): void {
  const el = resolveEl(r)
  if (el) {
    keyToEl.set(key, el)
    elToKey.set(el, key)
    ro?.observe(el)
    applyMeasure(key, measureRow(el)) // immediate: covers first paint + no-RO envs
    return
  }
  const old = keyToEl.get(key)
  if (old) {
    ro?.unobserve(old)
    keyToEl.delete(key)
  }
}

/** First index `i` with `arr[i] >= x` (arr is ascending). */
function lowerBound(arr: readonly number[], x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]! < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

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

/** Prefix-sum of row heights: `offsets[i]` = the top of item `i` (bottom of the
 *  list at `offsets[total]`). Uses the measured height per key, else the estimate.
 *  Reads `heightVersion` so a new measurement re-derives the layout. */
const offsets = computed<number[]>(() => {
  void heightVersion.value
  const its = items.value
  const arr = new Array<number>(its.length + 1)
  arr[0] = 0
  for (let i = 0; i < its.length; i++) {
    const h = heights.get(its[i]!.key)
    arr[i + 1] = arr[i]! + (h && h > 0 ? h : props.rowHeight)
  }
  return arr
})
const totalHeight = computed(() => offsets.value[offsets.value.length - 1] ?? 0)

const windowRange = computed(() => {
  const total = items.value.length
  if (total === 0) return { start: 0, end: 0 }
  const offs = offsets.value
  const top = scrollTop.value
  // start = the row containing `top` (last offset ≤ top), pulled back by overscan.
  const start = Math.max(0, lowerBound(offs, top + 1) - 1 - props.overscan)
  // end = the first row starting at/after the viewport bottom, plus overscan.
  const end = Math.min(total, lowerBound(offs, top + viewport.value) + props.overscan)
  return { start, end: Math.max(start, end) }
})

const visibleItems = computed(() =>
  items.value.slice(windowRange.value.start, windowRange.value.end),
)
const topPad = computed(() => offsets.value[windowRange.value.start] ?? 0)
const bottomPad = computed(() => totalHeight.value - (offsets.value[windowRange.value.end] ?? 0))

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
    el.scrollTop = Math.max(0, (offsets.value[index] ?? 0) - viewport.value / 2)
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

// Stream change → drop the measurement cache (a different channel's rows) and
// jump to the newest message.
watch(
  () => props.streamKey,
  () => {
    heights.clear()
    heightVersion.value++
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
  // Dynamic row heights (ENG-88): one observer for all rows — an entry fires on
  // observe and whenever a row's box changes (image load, edit, reactions). Absent
  // in jsdom → measurement is skipped and the estimate stands (tests unaffected).
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = elToKey.get(entry.target)
        if (key !== undefined) applyMeasure(key, measureRow(entry.target))
      }
    })
  }
  measure()
  scrollToBottom()
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  ro?.disconnect()
  ro = undefined
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
          :ref="(r) => setRow(r as Element | ComponentPublicInstance | null, item.key)"
          class="sticky top-0 z-10 mt-2 flex items-center justify-center"
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
        <div
          v-else-if="item.type === 'new'"
          :ref="(r) => setRow(r as Element | ComponentPublicInstance | null, item.key)"
          class="relative mt-2"
          data-testid="new-divider"
        >
          <hr class="border-subtle" />
          <span
            class="absolute -top-2 right-4 bg-background px-2 text-[11px] font-medium text-accent"
          >
            New
          </span>
        </div>
        <MessageItem
          v-else
          :ref="(r) => setRow(r as Element | ComponentPublicInstance | null, item.key)"
          :message="item.message"
          :show-header="item.showHeader"
          :names="props.names"
          :avatars="props.avatars"
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
