// useInbox — ENG-136 "Ranin" Inbox triage assembly.
//
// The Inbox is the SINGLE triage surface (the former "Feeds" section folded into
// it): one activity row per channel/DM that has any locally-projected messages,
// filterable by tab (All / Unread / Mentions / DMs / Channels) and grouped by day.
//
// Everything here is REAL and ZERO-network: streams + unread/mention badges come
// from the workspace store (the same `streams.list` projection the sidebar
// renders), and each stream's latest message is a LOCAL `messages.list` projection
// read (`limit: 1`) through the existing WorkerClient query — no new worker RPCs,
// no HTTP. The workspace store already re-queries on every stream push, which
// replaces its `streams` array; we watch that and re-read the previews, so a new
// message anywhere refreshes the Inbox live.
//
// HONESTY: a stream with NO locally-projected message is OMITTED (we will not
// fabricate a preview for it); there are no fake GitHub/Calendar/app rows — those
// need a backend that doesn't exist.
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'

import { resolveWorkerClient } from './useWorkerClient'
import { dmDisplayName } from '../lib/dm'
import { messageTimestamp, dayKey } from '../lib/time'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore, type SidebarStream } from '../stores/workspace'
import type { MessageRow } from '../worker'

/** The Inbox filter tabs, in display order. */
export type InboxTab = 'all' | 'unread' | 'mentions' | 'dms' | 'channels'

/** One triage row: a stream's latest activity merged with its badge. */
export interface InboxEntry {
  stream_id: string
  kind: 'channel' | 'dm'
  /** "# {name}" for a channel; the other participant's name for a DM. */
  title: string
  /** "{author}: {latest message text}" (or an honest attachment/deleted stand-in). */
  preview: string
  /** ms-epoch of the latest message (decoded from its ULID id). */
  lastActivityTs: number
  unread: number
  mention: boolean
}

/** A day bucket of triage rows ("Today" / "Yesterday" / "Earlier"). */
export interface InboxGroup {
  label: 'Today' | 'Yesterday' | 'Earlier'
  entries: InboxEntry[]
}

const GROUP_ORDER = ['Today', 'Yesterday', 'Earlier'] as const
const DAY_MS = 24 * 60 * 60 * 1000

/** Honest preview text for a latest message (never fabricates content). */
function previewText(m: MessageRow): string {
  if (m.deleted === true) return 'Message deleted'
  if (m.text.length > 0) return m.text
  if (m.file_ids.length > 0) return 'Sent an attachment'
  return ''
}

export interface UseInbox {
  activeTab: Ref<InboxTab>
  /** Every assembled entry (the "All" tab), newest activity first. */
  entries: ComputedRef<InboxEntry[]>
  /** The active tab's subset, newest activity first. */
  filtered: ComputedRef<InboxEntry[]>
  /** Day buckets of `filtered` (Today / Yesterday / Earlier; empty buckets dropped). */
  groups: ComputedRef<InboxGroup[]>
  /** Per-tab counts (All = total entries; Unread/Mentions/DMs/Channels = subset sizes). */
  counts: ComputedRef<Record<InboxTab, number>>
  /** True while the initial preview read is in flight (suppresses the empty state). */
  loading: Ref<boolean>
  /** Re-read every stream's latest message from the local projection. */
  refresh: () => Promise<void>
}

export function useInbox(): UseInbox {
  const workspace = useWorkspaceStore()
  const auth = useAuthStore()
  const { channels, dms, directory } = storeToRefs(workspace)

  const activeTab = ref<InboxTab>('all')
  /** `stream_id → latest projected message` (absent = no local messages). */
  const latest = ref<Map<string, MessageRow>>(new Map())
  const loading = ref(true)
  /** Drops a stale in-flight preview read when a newer one starts. */
  let generation = 0

  /** The sidebar's stream set (channels + DMs), badges included. */
  const streams = computed<SidebarStream[]>(() => [...channels.value, ...dms.value])

  /** Re-read each stream's newest message — a LOCAL `messages.list` read, limit 1. */
  async function refresh(): Promise<void> {
    const list = streams.value
    const gen = ++generation
    const client = await resolveWorkerClient()
    const pairs = await Promise.all(
      list.map(async (s) => {
        const res = await client.query({ q: 'messages.list', stream_id: s.stream_id, limit: 1 })
        return [s.stream_id, res.messages[0]] as const
      }),
    )
    if (gen !== generation) return // a newer refresh superseded this one
    const next = new Map<string, MessageRow>()
    for (const [id, m] of pairs) if (m !== undefined) next.set(id, m)
    latest.value = next
    loading.value = false
  }

  // The workspace store re-queries `streams.list` on every stream push, replacing
  // its array — so this watch re-reads previews whenever anything changes anywhere.
  watch(streams, () => void refresh(), { immediate: true })

  /** Directory-backed `user_id → display_name` (falls back to the raw id). */
  const names = computed<ReadonlyMap<string, string>>(
    () => new Map(directory.value.users.map((u) => [u.user_id, u.display_name])),
  )

  const entries = computed<InboxEntry[]>(() =>
    streams.value
      .flatMap((s): InboxEntry[] => {
        const m = latest.value.get(s.stream_id)
        if (m === undefined) return [] // no local messages — omitted, never fabricated
        const kind = s.kind === 'dm' ? ('dm' as const) : ('channel' as const)
        const name = s.name ?? s.stream_id
        // ENG-149: a DM is titled by the OTHER participant's display name
        // (resolved from `dm_user_ids`); unresolvable → the name/id fallback.
        const dmTitle = dmDisplayName(s.dm_user_ids, auth.myUserId, names.value) ?? name
        const author = names.value.get(m.author_user_id) ?? m.author_user_id
        const text = previewText(m)
        return [
          {
            stream_id: s.stream_id,
            kind,
            title: kind === 'dm' ? dmTitle : `# ${name}`,
            preview: m.deleted === true ? text : `${author}: ${text}`,
            lastActivityTs: messageTimestamp(m),
            unread: s.unread,
            mention: s.mention,
          },
        ]
      })
      .sort((a, b) => b.lastActivityTs - a.lastActivityTs),
  )

  const counts = computed<Record<InboxTab, number>>(() => ({
    all: entries.value.length,
    unread: entries.value.filter((e) => e.unread > 0).length,
    mentions: entries.value.filter((e) => e.mention).length,
    dms: entries.value.filter((e) => e.kind === 'dm').length,
    channels: entries.value.filter((e) => e.kind === 'channel').length,
  }))

  const filtered = computed<InboxEntry[]>(() => {
    const tab = activeTab.value
    if (tab === 'unread') return entries.value.filter((e) => e.unread > 0)
    if (tab === 'mentions') return entries.value.filter((e) => e.mention)
    if (tab === 'dms') return entries.value.filter((e) => e.kind === 'dm')
    if (tab === 'channels') return entries.value.filter((e) => e.kind === 'channel')
    return entries.value
  })

  const groups = computed<InboxGroup[]>(() => {
    const now = Date.now()
    const today = dayKey(now)
    const yesterday = dayKey(now - DAY_MS)
    const buckets: Record<InboxGroup['label'], InboxEntry[]> = {
      Today: [],
      Yesterday: [],
      Earlier: [],
    }
    for (const e of filtered.value) {
      const key = dayKey(e.lastActivityTs)
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : 'Earlier'
      buckets[label].push(e)
    }
    return GROUP_ORDER.filter((label) => buckets[label].length > 0).map((label) => ({
      label,
      entries: buckets[label],
    }))
  })

  return { activeTab, entries, filtered, groups, counts, loading, refresh }
}
