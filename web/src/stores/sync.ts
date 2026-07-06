// stores/sync.ts — tab-side mirror of the ENG-79 sync engine status (ENG-82).
// A pure cache of worker state: the initial value comes from the `sync.status`
// RPC and every transition arrives on the `{kind:'sync'}` push. The store adds NO
// sync logic of its own — the worker stays the single source of truth.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { resolveWorkerClient } from '../composables/useWorkerClient'
import type { SyncStatus, Unsubscribe } from '../worker'

/** Coarse connection buckets the indicator renders (§5.4 reconnect/offline UX). */
export type ConnectionTone = 'live' | 'syncing' | 'offline'

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus>({ state: 'connecting', online: true })
  let unsub: Unsubscribe | undefined

  /** Subscribe to the sync push + seed from the current status. Idempotent. */
  async function start(): Promise<void> {
    const client = await resolveWorkerClient()
    if (!unsub) {
      unsub = client.subscribe({ kind: 'sync' }, (s) => {
        status.value = s
      })
    }
    status.value = await client.sync.status()
  }

  function stop(): void {
    unsub?.()
    unsub = undefined
  }

  /** Whether replication is caught up + a WS is live. */
  const isLive = computed(() => status.value.state === 'live')

  /** Bucketed tone for the indicator dot/label. */
  const tone = computed<ConnectionTone>(() => {
    if (!status.value.online || status.value.state === 'degraded') return 'offline'
    if (status.value.state === 'live') return 'live'
    return 'syncing'
  })

  /** Short user-facing label for the current state. */
  const label = computed(() => {
    if (!status.value.online) return 'Offline'
    switch (status.value.state) {
      case 'live':
        return 'Connected'
      case 'syncing':
        return 'Syncing…'
      case 'degraded':
        return 'Reconnecting…'
      case 'idle':
        return 'Idle'
      case 'connecting':
      default:
        return 'Connecting…'
    }
  })

  return { status, isLive, tone, label, start, stop }
})
