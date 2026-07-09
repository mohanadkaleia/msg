<script setup lang="ts">
// InboxView — ENG-136 "Ranin" Inbox triage page; ENG-152 turns it into a TWO-PANE
// triage surface: the feed list (constrained width) + a PREVIEW pane.
//
// Layout: a ~520px feed column (the "Inbox" header + a REAL refresh action, the
// filter tabs — All / Unread / Mentions / DMs / Channels — and the day-grouped
// activity list, so items and their timestamps sit together without a full-width
// empty middle), then the preview pane taking the remaining space (InboxPreview:
// the selected stream's recent messages + a quick-reply composer).
//
// Selection model (ENG-152): CLICKING a row SELECTS it for the preview (the
// accent-subtle active state) — it does NOT navigate. The preview header's
// "Open" button (or a double-click on the row) emits `open-stream` — the shell
// then selects that stream and flips the main panel to the conversation.
//
// All data is REAL, assembled by `useInbox` from the workspace store's streams +
// badges and each stream's latest locally-projected message — zero network, no
// fabricated app rows. A fresh workspace shows a friendly EmptyState.
import { computed } from 'vue'

import EmptyState from '../ui/EmptyState.vue'
import Icon from '../ui/Icon.vue'
import IconButton from '../ui/IconButton.vue'
import InboxItem from './InboxItem.vue'
import InboxPreview from './InboxPreview.vue'
import { useInbox, type InboxTab } from '../../composables/useInbox'

const emit = defineEmits<{ 'open-stream': [streamId: string] }>()

const { activeTab, selectedStreamId, selectedEntry, entries, groups, counts, loading, refresh } =
  useInbox()

/** The tab row, in display order. Counts only where meaningful (All/Unread/Mentions). */
const TABS: ReadonlyArray<{ key: InboxTab; label: string; counted: boolean }> = [
  { key: 'all', label: 'All', counted: true },
  { key: 'unread', label: 'Unread', counted: true },
  { key: 'mentions', label: 'Mentions', counted: true },
  { key: 'dms', label: 'DMs', counted: false },
  { key: 'channels', label: 'Channels', counted: false },
]

/** Empty copy: no activity at all vs an empty filter over a non-empty list. */
const empty = computed(() =>
  entries.value.length === 0
    ? { title: "You're all caught up", body: 'New channel and DM activity will show up here.' }
    : { title: 'Nothing here', body: 'No conversations match this filter.' },
)
</script>

<template>
  <section data-testid="inbox-view" class="flex min-h-0 min-w-0 flex-1">
    <!-- Feed list column (ENG-152): constrained to ~520px so rows read compact. -->
    <div class="flex w-[520px] min-w-0 shrink-0 flex-col border-r border-subtle">
      <!-- Header: title + a REAL refresh (re-reads the local projection). -->
      <header class="flex items-center justify-between px-4 pb-2 pt-3">
        <h1 class="text-[15px] font-semibold text-primary">Inbox</h1>
        <IconButton size="sm" label="Refresh inbox" data-testid="inbox-refresh" @click="refresh()">
          <Icon name="refresh" :size="16" />
        </IconButton>
      </header>

      <!-- Filter tabs: accent underline + text-primary on the active tab. -->
      <div
        role="tablist"
        aria-label="Inbox filters"
        class="flex items-end gap-1 border-b border-subtle px-4"
      >
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          :data-testid="`inbox-tab-${tab.key}`"
          class="-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          :class="
            activeTab === tab.key
              ? 'border-accent font-medium text-primary'
              : 'border-transparent text-muted hover:text-primary'
          "
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
          <span
            v-if="tab.counted && counts[tab.key] > 0"
            class="rounded-full bg-accent-subtle px-1.5 text-[11px] font-medium text-accent"
            >{{ counts[tab.key] }}</span
          >
        </button>
      </div>

      <!-- Day-grouped activity list. Click = select for preview; dblclick = open. -->
      <div class="flex-1 overflow-y-auto">
        <template v-if="groups.length > 0">
          <section v-for="group in groups" :key="group.label">
            <p
              class="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted"
              data-testid="inbox-group"
            >
              {{ group.label }}
            </p>
            <InboxItem
              v-for="entry in group.entries"
              :key="entry.stream_id"
              :entry="entry"
              :selected="entry.stream_id === selectedStreamId"
              @select="selectedStreamId = entry.stream_id"
              @open="emit('open-stream', entry.stream_id)"
            />
          </section>
        </template>
        <div v-else-if="!loading" class="flex h-full items-center justify-center">
          <EmptyState :title="empty.title" :description="empty.body">
            <template #icon><Icon name="mail" :size="24" /></template>
          </EmptyState>
        </div>
      </div>
    </div>

    <!-- Preview pane (ENG-152): the selected stream's recent messages + a
         quick-reply composer; "Open" does the full jump to the conversation. -->
    <InboxPreview :entry="selectedEntry" @open="emit('open-stream', $event)" />
  </section>
</template>
