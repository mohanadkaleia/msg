<script setup lang="ts">
// SearchOverlay — the ENG-127 message-search surface (Ranin), opened from the
// top-bar search field. DISTINCT from the Cmd+K CommandPalette quick-switcher:
// this searches MESSAGE TEXT through the worker's `search` RPC (ENG-126 → the
// server's readable-scoped Postgres FTS endpoint, ENG-122). That is the ONE read
// that is an HTTP call — made worker-side, so the token never reaches this tab.
//
// Filter grammar (client-side, lib/searchFilters): `in:#channel` resolves to a
// stream_id against the workspace streams; `from:@name` resolves to a user_id
// against the directory; the leftover words are the free-text `q`. An unresolved
// filter shows a hint and does NOT search (never a silently dropped filter).
// `before:`/`after:` map to server `created_seq` ints (not calendar dates), so
// they are unsupported for MVP — stripped and surfaced honestly, never faked.
//
// SECURITY (critical): hit text, the query, and every name are OTHER USERS' /
// arbitrary input. All of it renders ONLY through Vue text interpolation — the
// matched-term highlight goes through highlightSegments() (plain segments) with
// <mark>{{ }}</mark> around matches. NO v-html, no HTML string building, anywhere.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'

import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { highlightSegments, type HighlightSegment } from '../../lib/highlight'
import { parseSearchInput, resolveStreamName, resolveUserName } from '../../lib/searchFilters'
import { decodeUlidTime, formatActivityTime } from '../../lib/time'
import { useWorkspaceStore } from '../../stores/workspace'
import type { SearchHit, SearchParams } from '../../worker'
import Icon from '../ui/Icon.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; jump: [streamId: string, messageId: string] }>()

/** Debounce between the last keystroke and the worker `search` call. */
const DEBOUNCE_MS = 250
/** Page size (server clamps to 1..50). */
const PAGE = 20

const workspace = useWorkspaceStore()
const { streams, directory } = storeToRefs(workspace)

const input = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
const hits = ref<SearchHit[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref<string | null>(null)
/** True once a search for the CURRENT input has settled (gates the empty state). */
const searched = ref(false)

let timer: ReturnType<typeof setTimeout> | undefined
/** Monotonic request token: a newer search/reset invalidates in-flight results. */
let requestSeq = 0

const parsed = computed(() => parseSearchInput(input.value))

/** `in:` resolution: undefined = no filter, null = filter present but unknown. */
const resolvedIn = computed<string | null | undefined>(() => {
  const name = parsed.value.inName
  if (name === null) return undefined
  return resolveStreamName(name, streams.value)
})

/** `from:` resolution: undefined = no filter, null = filter present but unknown. */
const resolvedFrom = computed<string | null | undefined>(() => {
  const name = parsed.value.fromName
  if (name === null) return undefined
  return resolveUserName(name, directory.value.users)
})

/** Hint for a filter that names nothing (blocks the search — honesty over guessing). */
const filterHint = computed<string | null>(() => {
  if (resolvedIn.value === null) return `Unknown channel: #${parsed.value.inName}`
  if (resolvedFrom.value === null) return `Unknown person: @${parsed.value.fromName}`
  return null
})

/** `before:`/`after:` notice (parsed out of `q`, never sent — see lib/searchFilters). */
const unsupportedHint = computed<string | null>(() =>
  parsed.value.unsupported.length > 0
    ? `${parsed.value.unsupported.join(' ')} isn't supported yet — filters by date aren't available.`
    : null,
)

const hasQuery = computed(() => parsed.value.q.trim().length > 0)

/** The `client.search` params for the current input, or null when not searchable. */
const searchParams = computed<SearchParams | null>(() => {
  const q = parsed.value.q.trim()
  if (q.length === 0 || filterHint.value !== null) return null
  const params: SearchParams = { q, limit: PAGE }
  if (typeof resolvedIn.value === 'string') params.in = resolvedIn.value
  if (typeof resolvedFrom.value === 'string') params.from = resolvedFrom.value
  return params
})

/** Query words, highlighted in each hit's snippet (best-effort literal match). */
const terms = computed(() => parsed.value.q.split(/\s+/).filter((w) => w.length > 0))

/** Directory `user_id → display_name` (raw id fallback in the view). */
const names = computed<ReadonlyMap<string, string>>(() => {
  const map = new Map<string, string>()
  for (const u of directory.value.users) map.set(u.user_id, u.display_name)
  return map
})

// Reset + focus each time the overlay opens (CommandPalette parity).
watch(
  () => props.open,
  (open) => {
    if (open) {
      input.value = ''
      resetResults()
      void nextTick(() => inputEl.value?.focus())
    }
  },
)

// Typing → debounce → search (a change during the debounce restarts the window).
watch(input, () => {
  if (timer !== undefined) clearTimeout(timer)
  searched.value = false
  error.value = null
  const params = searchParams.value
  if (params === null) {
    resetResults()
    return
  }
  loading.value = true
  timer = setTimeout(() => void runSearch(params), DEBOUNCE_MS)
})

function resetResults(): void {
  requestSeq++
  hits.value = []
  nextCursor.value = null
  loading.value = false
  loadingMore.value = false
  searched.value = false
  error.value = null
}

/** Fresh first page for `params` (replaces the current hits). */
async function runSearch(params: SearchParams): Promise<void> {
  const seq = ++requestSeq
  loading.value = true
  try {
    const client = await resolveWorkerClient()
    const res = await client.search(params)
    if (seq !== requestSeq) return
    hits.value = res.hits
    nextCursor.value = res.next_cursor
    searched.value = true
  } catch {
    if (seq === requestSeq) error.value = 'Search failed. Try again.'
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/** Next page via the server's opaque cursor (appended in server rank order). */
async function loadMore(): Promise<void> {
  const params = searchParams.value
  const cursor = nextCursor.value
  if (params === null || cursor === null || loadingMore.value) return
  const seq = requestSeq
  loadingMore.value = true
  try {
    const client = await resolveWorkerClient()
    const res = await client.search({ ...params, cursor })
    if (seq !== requestSeq) return
    hits.value = [...hits.value, ...res.hits]
    nextCursor.value = res.next_cursor
  } catch {
    if (seq === requestSeq) error.value = 'Could not load more results.'
  } finally {
    loadingMore.value = false
  }
}

/** Channel/DM label for a hit (`# name` for channels; raw id when unknown). */
function streamLabel(streamId: string): string {
  const stream = streams.value.find((s) => s.stream_id === streamId)
  if (!stream) return streamId
  const name = stream.name ?? stream.stream_id
  return stream.kind === 'dm' ? name : `# ${name}`
}

/** Relative timestamp recovered from the hit's ULID id (blank when undecodable). */
function timeLabel(hit: SearchHit): string {
  const ms = decodeUlidTime(hit.message_id)
  return ms !== null && ms > 0 ? formatActivityTime(ms) : ''
}

/** Plain match/no-match segments for the snippet (see the SECURITY note above). */
function segmentsFor(hit: SearchHit): HighlightSegment[] {
  return highlightSegments(hit.text, terms.value)
}

function jump(hit: SearchHit): void {
  emit('jump', hit.stream_id, hit.message_id)
}

onBeforeUnmount(() => {
  if (timer !== undefined) clearTimeout(timer)
})
</script>

<template>
  <div
    v-if="props.open"
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[10vh]"
    data-testid="search-overlay"
    @click.self="emit('close')"
    @keydown.escape="emit('close')"
  >
    <div
      class="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-subtle bg-surface-elevated shadow-xl"
    >
      <!-- Query input + filter grammar. -->
      <div class="flex items-center gap-2 border-b border-subtle px-4">
        <Icon name="search" :size="16" class="shrink-0 text-muted" />
        <input
          ref="inputEl"
          v-model="input"
          type="text"
          placeholder="Search messages…"
          class="w-full bg-transparent py-3 text-sm text-primary outline-none placeholder:text-muted"
          data-testid="search-input"
          autocomplete="off"
        />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <!-- An unresolved in:/from: filter blocks the search — say so. -->
        <p
          v-if="filterHint"
          class="px-4 py-3 text-sm text-warning"
          data-testid="search-filter-hint"
        >
          {{ filterHint }}
        </p>

        <!-- Prompt: no free text yet (filters alone don't search). -->
        <div v-else-if="!hasQuery" class="px-4 py-6 text-center" data-testid="search-prompt">
          <p class="text-sm font-medium text-primary">Search messages</p>
          <p class="mt-1 text-xs text-muted">
            Type to search. Narrow with in:#channel or from:@name.
          </p>
        </div>

        <p v-else-if="error" class="px-4 py-3 text-sm text-danger" data-testid="search-error">
          {{ error }}
        </p>

        <p
          v-else-if="loading && hits.length === 0"
          class="px-4 py-3 text-sm text-muted"
          data-testid="search-loading"
        >
          Searching…
        </p>

        <p
          v-else-if="searched && hits.length === 0"
          class="px-4 py-3 text-sm text-muted"
          data-testid="search-empty"
        >
          No messages match your search.
        </p>

        <template v-else>
          <p
            v-if="unsupportedHint"
            class="border-b border-subtle px-4 py-2 text-xs text-warning"
            data-testid="search-unsupported-hint"
          >
            {{ unsupportedHint }}
          </p>

          <!-- Hits, in the SERVER's rank order (never re-sorted tab-side). -->
          <ul class="py-1">
            <li v-for="hit in hits" :key="hit.message_id" data-testid="search-result">
              <button
                type="button"
                class="w-full px-4 py-2 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                data-testid="search-jump"
                @click="jump(hit)"
              >
                <span class="flex items-baseline gap-2">
                  <span class="shrink-0 text-xs font-medium text-accent">
                    {{ streamLabel(hit.stream_id) }}
                  </span>
                  <span class="truncate text-sm font-semibold text-primary">
                    {{ names.get(hit.author_user_id) ?? hit.author_user_id }}
                  </span>
                  <span class="shrink-0 text-xs text-muted">{{ timeLabel(hit) }}</span>
                </span>
                <!-- SECURITY: segments render via {{ }} ONLY — never v-html. -->
                <span class="mt-0.5 line-clamp-2 block text-sm text-secondary">
                  <template v-for="(seg, i) in segmentsFor(hit)" :key="i">
                    <mark v-if="seg.match" class="rounded-sm bg-accent-subtle px-0.5 text-accent">{{
                      seg.text
                    }}</mark>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
              </button>
            </li>
          </ul>

          <div v-if="nextCursor" class="border-t border-subtle p-2">
            <button
              type="button"
              class="w-full rounded-md px-3 py-1.5 text-sm text-secondary hover:bg-surface-hover hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              data-testid="search-load-more"
              :disabled="loadingMore"
              @click="loadMore"
            >
              {{ loadingMore ? 'Loading…' : 'Load more' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
