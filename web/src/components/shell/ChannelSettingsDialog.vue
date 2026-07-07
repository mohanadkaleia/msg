<script setup lang="ts">
// ChannelSettingsDialog — rename / archive a channel and add/remove members
// (ENG-104). All actions author workspace-meta events worker-side (owner/admin
// only server-side; a member's attempt is rejected and surfaced here). Members are
// picked from the local `directory` projection (zero-network).
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'

import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'

const props = defineProps<{ stream: SidebarStream }>()
const emit = defineEmits<{ close: [] }>()

const workspace = useWorkspaceStore()
const { directory } = storeToRefs(workspace)

const newName = ref(props.stream.name ?? '')
const busy = ref(false)
const error = ref<string | null>(null)

const members = computed(() => directory.value.users)

async function run(fn: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    await fn()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Action failed.'
  } finally {
    busy.value = false
  }
}

function rename(): void {
  const trimmed = newName.value.trim()
  if (trimmed === '' || trimmed === props.stream.name) return
  void run(() => workspace.renameChannel(props.stream.stream_id, trimmed))
}

function archive(): void {
  void run(async () => {
    await workspace.archiveChannel(props.stream.stream_id)
    emit('close')
  })
}

function addMember(userId: string): void {
  void run(() => workspace.addMember(props.stream.stream_id, userId))
}

function removeMember(userId: string): void {
  void run(() => workspace.removeMember(props.stream.stream_id, userId))
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
    data-testid="channel-settings"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
      <h2 class="mb-3 text-sm font-semibold text-slate-800">
        Channel settings — # {{ stream.name ?? stream.stream_id }}
      </h2>

      <label class="mb-1 block text-xs font-medium text-slate-500" for="rename-input">Rename</label>
      <div class="mb-4 flex gap-2">
        <input
          id="rename-input"
          v-model="newName"
          type="text"
          class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          data-testid="channel-rename-input"
          autocomplete="off"
        />
        <button
          type="button"
          class="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          :disabled="busy || newName.trim() === '' || newName.trim() === stream.name"
          data-testid="channel-rename-submit"
          @click="rename"
        >
          Save
        </button>
      </div>

      <div class="mb-4">
        <p class="mb-1 text-xs font-medium text-slate-500">Members</p>
        <ul class="max-h-48 overflow-y-auto">
          <li
            v-for="user in members"
            :key="user.user_id"
            class="flex items-center justify-between rounded-md px-2 py-1 hover:bg-slate-100"
          >
            <span class="truncate text-sm text-slate-700">{{ user.display_name }}</span>
            <span class="flex gap-1">
              <button
                type="button"
                class="rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                data-testid="channel-add-member"
                :data-user-id="user.user_id"
                :disabled="busy"
                @click="addMember(user.user_id)"
              >
                Add
              </button>
              <button
                type="button"
                class="rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-200 disabled:opacity-50"
                data-testid="channel-remove-member"
                :data-user-id="user.user_id"
                :disabled="busy"
                @click="removeMember(user.user_id)"
              >
                Remove
              </button>
            </span>
          </li>
        </ul>
      </div>

      <p v-if="error" class="mb-3 text-xs text-red-600" data-testid="channel-settings-error">
        {{ error }}
      </p>

      <div class="flex justify-between">
        <button
          type="button"
          class="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          :disabled="busy"
          data-testid="channel-archive"
          @click="archive"
        >
          Archive channel
        </button>
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:text-slate-800"
          @click="emit('close')"
        >
          Close
        </button>
      </div>
    </div>
  </div>
</template>
