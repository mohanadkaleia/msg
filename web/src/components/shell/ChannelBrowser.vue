<script setup lang="ts">
// ChannelBrowser — PUBLIC channels the user has not joined (`member:false` rows
// from the streams projection, ENG-104). Joining opens the channel instantly; a
// public channel is readable without a membership event (§3.6), so "join" is a
// local open + switch (a self-join membership event is not in the M3 write matrix).
import { storeToRefs } from 'pinia'

import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'

const emit = defineEmits<{ close: [] }>()

const workspace = useWorkspaceStore()
const { browsableChannels } = storeToRefs(workspace)

function join(stream: SidebarStream): void {
  workspace.joinChannel(stream.stream_id)
  emit('close')
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    data-testid="channel-browser"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-sm rounded-lg border border-subtle bg-surface-elevated p-5 shadow-xl">
      <h2 class="mb-3 text-sm font-semibold text-primary">Browse channels</h2>

      <p
        v-if="browsableChannels.length === 0"
        class="text-xs text-secondary"
        data-testid="channel-browser-empty"
      >
        No public channels to join.
      </p>

      <ul class="max-h-72 overflow-y-auto">
        <li v-for="stream in browsableChannels" :key="stream.stream_id">
          <div class="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-surface">
            <span class="truncate text-sm text-primary"
              ># {{ stream.name ?? stream.stream_id }}</span
            >
            <button
              type="button"
              class="rounded-md border border-strong px-2 py-0.5 text-xs font-medium text-secondary hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-testid="join-channel"
              :data-stream-id="stream.stream_id"
              @click="join(stream)"
            >
              Join
            </button>
          </div>
        </li>
      </ul>

      <div class="mt-4 flex justify-end">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm text-secondary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          @click="emit('close')"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>
