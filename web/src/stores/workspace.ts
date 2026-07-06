// stores/workspace.ts — the sidebar's cache of the workspace projection (ENG-82).
//
// Reads streams + unread/mention badges over the worker `streams.list` query
// (ENG-80) — a LOCAL projection read, never the HTTP API. Selection lives here so
// switching channels is a pure in-memory flip (the message load is a separate
// projection read in the messages store). Fed by `{kind:'stream'}` push
// subscriptions: when any stream's projection changes, we re-query badges so the
// sidebar re-renders. The store holds no sync/outbox logic — the worker owns that.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { resolveWorkerClient } from '../composables/useWorkerClient'
import type { StreamBadge, StreamRow, Unsubscribe } from '../worker'

/** A sidebar row: a projected stream merged with its live badge. */
export type SidebarStream = StreamRow & StreamBadge

/** Kinds that are surfaced in the sidebar (workspace-meta is infrastructure). */
const HIDDEN_KINDS = new Set(['workspace-meta'])

export const useWorkspaceStore = defineStore('workspace', () => {
  const streams = ref<SidebarStream[]>([])
  const selectedStreamId = ref<string | null>(null)
  const loaded = ref(false)

  /** Per-stream push unsubscribes, so we can diff + tear down cleanly. */
  const subs = new Map<string, Unsubscribe>()
  /** One `{kind:'sync'}` subscription so the sidebar re-queries as sync progresses. */
  let syncSub: Unsubscribe | undefined
  let refreshQueued = false

  const visibleStreams = computed(() =>
    streams.value.filter((s) => s.member && !HIDDEN_KINDS.has(s.kind)),
  )
  const channels = computed(() => visibleStreams.value.filter((s) => s.kind !== 'dm').sort(byName))
  const dms = computed(() => visibleStreams.value.filter((s) => s.kind === 'dm').sort(byName))
  const selectedStream = computed(
    () => streams.value.find((s) => s.stream_id === selectedStreamId.value) ?? null,
  )

  /** Load the sidebar + wire per-stream badge subscriptions. */
  async function load(): Promise<void> {
    const client = await resolveWorkerClient()
    // On first login the projection is empty at mount; streams arrive only once
    // the sync engine's catch-up pull lands. The per-stream `{kind:'stream'}`
    // subscriptions in refresh() cannot cover a stream that does not exist yet,
    // so also re-query on every sync push — that is exactly when a NEW stream
    // (e.g. `general`) appears. Without this the sidebar stays empty until reload.
    if (syncSub === undefined) {
      syncSub = client.subscribe({ kind: 'sync' }, () => scheduleRefresh())
    }
    await refresh()
    loaded.value = true
    // Default selection: first channel, else first DM (only on first load).
    if (selectedStreamId.value === null) {
      const first = channels.value[0] ?? dms.value[0]
      if (first) selectedStreamId.value = first.stream_id
    }
  }

  /** Re-query `streams.list` and reconcile push subscriptions. */
  async function refresh(): Promise<void> {
    const client = await resolveWorkerClient()
    const res = await client.query({ q: 'streams.list' })
    streams.value = res.streams
    reconcileSubscriptions(client)
  }

  /** Subscribe to any new stream; drop subscriptions for streams that vanished. */
  function reconcileSubscriptions(client: Awaited<ReturnType<typeof resolveWorkerClient>>): void {
    const live = new Set(streams.value.map((s) => s.stream_id))
    for (const [id, unsub] of subs) {
      if (!live.has(id)) {
        unsub()
        subs.delete(id)
      }
    }
    for (const s of streams.value) {
      if (subs.has(s.stream_id)) continue
      subs.set(
        s.stream_id,
        client.subscribe({ kind: 'stream', stream_id: s.stream_id }, () => scheduleRefresh()),
      )
    }
  }

  /** Coalesce a burst of stream pushes into a single badge re-query. */
  function scheduleRefresh(): void {
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      void refresh()
    })
  }

  function selectStream(streamId: string): void {
    selectedStreamId.value = streamId
  }

  function dispose(): void {
    for (const unsub of subs.values()) unsub()
    subs.clear()
    syncSub?.()
    syncSub = undefined
  }

  return {
    streams,
    selectedStreamId,
    selectedStream,
    loaded,
    channels,
    dms,
    visibleStreams,
    load,
    refresh,
    selectStream,
    dispose,
  }
})

function byName(a: SidebarStream, b: SidebarStream): number {
  return (a.name ?? a.stream_id).localeCompare(b.name ?? b.stream_id)
}
