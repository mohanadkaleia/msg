<script setup lang="ts">
// AppSidebar — channel list + DMs (ENG-82) + channel/member management + DM
// creation (ENG-104). A DUMB view over the workspace store (streams + badges from
// the ENG-80 projection). Unread → bold name; mention → a red count badge. Clicking
// selects a stream; selection is a local flip (the message load is a separate
// ZERO-network projection read). The "+"/browse buttons open dialogs that author
// workspace-meta events worker-side. SECURITY: stream names are other users' input
// — rendered via text interpolation only.
import { ref } from 'vue'
import { storeToRefs } from 'pinia'

import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'
import ChannelBrowser from './ChannelBrowser.vue'
import ChannelSettingsDialog from './ChannelSettingsDialog.vue'
import CreateChannelDialog from './CreateChannelDialog.vue'
import NewDmDialog from './NewDmDialog.vue'
import SyncIndicator from './SyncIndicator.vue'

const workspace = useWorkspaceStore()
const { channels, dms, selectedStreamId } = storeToRefs(workspace)

const emit = defineEmits<{ openSwitcher: [] }>()

/** Which modal is open (ENG-104). `settings` also carries the target channel. */
const showCreateChannel = ref(false)
const showChannelBrowser = ref(false)
const showNewDm = ref(false)
const settingsFor = ref<SidebarStream | null>(null)

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
      <div class="flex items-center justify-between px-2 pb-1 pt-2">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Channels</p>
        <span class="flex gap-1">
          <button
            type="button"
            class="rounded px-1 text-sm leading-none text-slate-400 hover:text-slate-700"
            title="Browse channels"
            data-testid="open-channel-browser"
            @click="showChannelBrowser = true"
          >
            ⌕
          </button>
          <button
            type="button"
            class="rounded px-1 text-sm leading-none text-slate-400 hover:text-slate-700"
            title="Create a channel"
            data-testid="open-create-channel"
            @click="showCreateChannel = true"
          >
            +
          </button>
        </span>
      </div>
      <ul>
        <li v-for="stream in channels" :key="stream.stream_id" class="group relative">
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
          <button
            type="button"
            class="absolute right-1 top-1.5 hidden rounded px-1 text-xs text-slate-400 hover:text-slate-700 group-hover:block"
            title="Channel settings"
            data-testid="open-channel-settings"
            :data-stream-id="stream.stream_id"
            @click.stop="settingsFor = stream"
          >
            ⚙
          </button>
        </li>
      </ul>

      <div class="flex items-center justify-between px-2 pb-1 pt-4">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Direct Messages</p>
        <button
          type="button"
          class="rounded px-1 text-sm leading-none text-slate-400 hover:text-slate-700"
          title="New direct message"
          data-testid="open-new-dm"
          @click="showNewDm = true"
        >
          +
        </button>
      </div>
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
    </nav>

    <div class="border-t border-slate-200 px-3 py-2">
      <SyncIndicator />
    </div>
  </aside>

  <CreateChannelDialog v-if="showCreateChannel" @close="showCreateChannel = false" />
  <ChannelBrowser v-if="showChannelBrowser" @close="showChannelBrowser = false" />
  <NewDmDialog v-if="showNewDm" @close="showNewDm = false" />
  <ChannelSettingsDialog v-if="settingsFor" :stream="settingsFor" @close="settingsFor = null" />
</template>
