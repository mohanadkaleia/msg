<script setup lang="ts">
// CreateChannelDialog — name + public/private → `channel.create` (ENG-104). The
// event is AUTHORED worker-side (the token never leaves the worker); on success
// the store switches to the new channel. A rejection surfaces inline.
import { ref } from 'vue'

import { useWorkspaceStore } from '../../stores/workspace'

const emit = defineEmits<{ close: [] }>()

const workspace = useWorkspaceStore()
const name = ref('')
const visibility = ref<'public' | 'private'>('public')
const busy = ref(false)
const error = ref<string | null>(null)

async function submit(): Promise<void> {
  const trimmed = name.value.trim()
  if (trimmed === '' || busy.value) return
  busy.value = true
  error.value = null
  try {
    await workspace.createChannel(trimmed, visibility.value)
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Could not create the channel.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    data-testid="create-channel"
    @click.self="emit('close')"
  >
    <form
      class="w-full max-w-sm rounded-lg border border-subtle bg-surface-elevated p-5 shadow-xl"
      @submit.prevent="submit"
    >
      <h2 class="mb-3 text-sm font-semibold text-primary">Create a channel</h2>

      <label class="mb-1 block text-xs font-medium text-secondary" for="channel-name">Name</label>
      <input
        id="channel-name"
        v-model="name"
        type="text"
        class="mb-3 w-full rounded-md border border-strong bg-transparent px-2 py-1.5 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        placeholder="general"
        data-testid="create-channel-name"
        autocomplete="off"
      />

      <fieldset class="mb-4">
        <legend class="mb-1 text-xs font-medium text-secondary">Visibility</legend>
        <label class="mr-4 inline-flex items-center gap-1 text-sm text-secondary">
          <input
            v-model="visibility"
            type="radio"
            value="public"
            data-testid="create-channel-public"
          />
          Public
        </label>
        <label class="inline-flex items-center gap-1 text-sm text-secondary">
          <input
            v-model="visibility"
            type="radio"
            value="private"
            data-testid="create-channel-private"
          />
          Private
        </label>
      </fieldset>

      <p v-if="error" class="mb-3 text-xs text-danger" data-testid="create-channel-error">
        {{ error }}
      </p>

      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm text-secondary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
          :disabled="busy || name.trim() === ''"
          data-testid="create-channel-submit"
        >
          Create
        </button>
      </div>
    </form>
  </div>
</template>
