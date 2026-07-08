<script setup lang="ts">
// NewDmDialog — pick a workspace member → `dm.create` (ENG-104). Members come from
// the local `directory` projection (zero-network). On success the store switches to
// the new DM stream. 1:1 for M3 (group DM deferred).
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'

import { useWorkspaceStore } from '../../stores/workspace'

const emit = defineEmits<{ close: [] }>()

const workspace = useWorkspaceStore()
const { directory } = storeToRefs(workspace)
const filter = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

const candidates = computed(() => {
  const q = filter.value.trim().toLowerCase()
  const users = directory.value.users
  return q === '' ? users : users.filter((u) => u.display_name.toLowerCase().includes(q))
})

async function start(userId: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  try {
    await workspace.createDm(userId)
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not start the DM.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    data-testid="new-dm"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-sm rounded-lg border border-subtle bg-surface-elevated p-5 shadow-xl">
      <h2 class="mb-3 text-sm font-semibold text-primary">New direct message</h2>

      <input
        v-model="filter"
        type="text"
        class="mb-3 w-full rounded-md border border-strong bg-transparent px-2 py-1.5 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        placeholder="Search people…"
        data-testid="new-dm-filter"
        autocomplete="off"
      />

      <p v-if="error" class="mb-2 text-xs text-danger" data-testid="new-dm-error">{{ error }}</p>

      <p v-if="candidates.length === 0" class="text-xs text-secondary" data-testid="new-dm-empty">
        No people found.
      </p>

      <ul class="max-h-72 overflow-y-auto">
        <li v-for="user in candidates" :key="user.user_id">
          <button
            type="button"
            class="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-secondary hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
            data-testid="new-dm-user"
            :data-user-id="user.user_id"
            :disabled="busy"
            @click="start(user.user_id)"
          >
            {{ user.display_name }}
          </button>
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
