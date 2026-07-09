<script setup lang="ts">
// ChannelSettingsDialog — rename / archive a channel and add/remove members
// (ENG-104). All actions author workspace-meta events worker-side (owner/admin
// only server-side; a member's attempt is rejected and surfaced here). Members are
// picked from the local `directory` projection (zero-network). Each row carries a
// REAL presence dot (ENG-128, ephemeral worker snapshot — unknown ⇒ offline).
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'

import { usePresenceStore } from '../../stores/presence'
import { useWorkspaceStore, type SidebarStream } from '../../stores/workspace'
import PresenceDot from '../ui/PresenceDot.vue'

const props = defineProps<{ stream: SidebarStream }>()
const emit = defineEmits<{ close: [] }>()

const workspace = useWorkspaceStore()
const presence = usePresenceStore()
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
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    data-testid="channel-settings"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-sm rounded-lg border border-subtle bg-surface-elevated p-5 shadow-xl">
      <h2 class="mb-3 text-sm font-semibold text-primary">
        Channel settings — # {{ stream.name ?? stream.stream_id }}
      </h2>

      <label class="mb-1 block text-xs font-medium text-secondary" for="rename-input">Rename</label>
      <div class="mb-4 flex gap-2">
        <input
          id="rename-input"
          v-model="newName"
          type="text"
          class="w-full rounded-md border border-strong bg-transparent px-2 py-1.5 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-testid="channel-rename-input"
          autocomplete="off"
        />
        <button
          type="button"
          class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
          :disabled="busy || newName.trim() === '' || newName.trim() === stream.name"
          data-testid="channel-rename-submit"
          @click="rename"
        >
          Save
        </button>
      </div>

      <div class="mb-4">
        <p class="mb-1 text-xs font-medium text-secondary">Members</p>
        <ul class="max-h-48 overflow-y-auto">
          <li
            v-for="user in members"
            :key="user.user_id"
            class="flex items-center justify-between rounded-md px-2 py-1 hover:bg-surface-hover"
          >
            <span class="flex min-w-0 items-center gap-2">
              <PresenceDot :status="presence.statusOf(user.user_id)" size="sm" class="shrink-0" />
              <span class="truncate text-sm text-primary">{{ user.display_name }}</span>
            </span>
            <span class="flex gap-1">
              <button
                type="button"
                class="rounded border border-strong px-1.5 py-0.5 text-xs text-secondary hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                data-testid="channel-add-member"
                :data-user-id="user.user_id"
                :disabled="busy"
                @click="addMember(user.user_id)"
              >
                Add
              </button>
              <button
                type="button"
                class="rounded border border-strong px-1.5 py-0.5 text-xs text-secondary hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
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

      <p v-if="error" class="mb-3 text-xs text-danger" data-testid="channel-settings-error">
        {{ error }}
      </p>

      <div class="flex justify-between">
        <button
          type="button"
          class="rounded-md border border-danger px-3 py-1.5 text-sm font-medium text-danger hover:bg-danger/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
          :disabled="busy"
          data-testid="channel-archive"
          @click="archive"
        >
          Archive channel
        </button>
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
