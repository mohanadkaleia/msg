<script setup lang="ts">
// AppSidebar — channel list + DMs (ENG-82). A DUMB view over the workspace store
// (streams + badges from the ENG-80 projection). Unread → bold name; mention → a
// red count badge. Clicking selects a stream; selection is a local flip (the
// message load is a separate ZERO-network projection read). SECURITY: stream
// names are other users' input — rendered via text interpolation only.
import { storeToRefs } from 'pinia'

import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'
import SyncIndicator from './SyncIndicator.vue'

const workspace = useWorkspaceStore()
const { channels, dms, selectedStreamId } = storeToRefs(workspace)

const emit = defineEmits<{ openSwitcher: [] }>()

function select(stream: SidebarStream): void {
  workspace.selectStream(stream.stream_id)
}

/** Display label: channel name with a leading '#', DM/other by name or id. */
function labelFor(stream: SidebarStream): string {
  const name = stream.name ?? stream.stream_id
  return stream.kind === 'dm' ? name : `# ${name}`
}
</script>

<template>
  <aside class="flex h-full w-64 flex-col border-r border-slate-200 bg-slate-50">
    <div class="flex items-center justify-between px-3 py-3">
      <span class="text-sm font-semibold text-slate-800">msg</span>
      <button
        type="button"
        class="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500 hover:text-slate-800"
        data-testid="open-switcher"
        title="Quick switch (⌘K)"
        @click="emit('openSwitcher')"
      >
        ⌘K
      </button>
    </div>

    <nav class="flex-1 overflow-y-auto px-2 pb-3">
      <p class="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Channels
      </p>
      <ul>
        <li v-for="stream in channels" :key="stream.stream_id">
          <button
            type="button"
            class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-200/60"
            :class="[
              stream.stream_id === selectedStreamId
                ? 'bg-slate-200 text-slate-900'
                : 'text-slate-600',
              stream.unread > 0 ? 'font-semibold text-slate-900' : '',
            ]"
            data-testid="sidebar-channel"
            :data-stream-id="stream.stream_id"
            :data-unread="stream.unread"
            @click="select(stream)"
          >
            <span class="truncate">{{ labelFor(stream) }}</span>
            <span
              v-if="stream.mention"
              class="ml-2 shrink-0 rounded-full bg-red-500 px-1.5 text-xs font-semibold text-white"
              data-testid="mention-badge"
              >{{ stream.unread }}</span
            >
          </button>
        </li>
      </ul>

      <template v-if="dms.length > 0">
        <p class="px-2 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Direct Messages
        </p>
        <ul>
          <li v-for="stream in dms" :key="stream.stream_id">
            <button
              type="button"
              class="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-200/60"
              :class="[
                stream.stream_id === selectedStreamId
                  ? 'bg-slate-200 text-slate-900'
                  : 'text-slate-600',
                stream.unread > 0 ? 'font-semibold text-slate-900' : '',
              ]"
              data-testid="sidebar-dm"
              :data-stream-id="stream.stream_id"
              :data-unread="stream.unread"
              @click="select(stream)"
            >
              <span class="truncate">{{ labelFor(stream) }}</span>
              <span
                v-if="stream.mention"
                class="ml-2 shrink-0 rounded-full bg-red-500 px-1.5 text-xs font-semibold text-white"
                data-testid="mention-badge"
                >{{ stream.unread }}</span
              >
            </button>
          </li>
        </ul>
      </template>
    </nav>

    <div class="border-t border-slate-200 px-3 py-2">
      <SyncIndicator />
    </div>
  </aside>
</template>
