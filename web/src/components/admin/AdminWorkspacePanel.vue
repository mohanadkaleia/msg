<script setup lang="ts">
// AdminWorkspacePanel — ENG-152: the workspace settings form (name +
// description) for an owner/admin. Everything flows through the
// `client.admin.workspace.*` worker RPCs — this panel never touches HTTP or
// the token. The server persists the row AND emits the server-authored
// `workspace.updated` meta event, so every member's switcher/header renames
// through normal sync; for the saving admin we ALSO apply the PATCH response
// to the workspace store so their own shell renames instantly.
//
// The workspace ICON (image) is a deliberate follow-up — it shares the avatar
// image-upload work — so this panel is name + description only.
import { computed, onMounted, ref } from 'vue'

import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { adminErrorCopy } from '../../lib/adminPolicy'
import { useWorkspaceStore } from '../../stores/workspace'

/** Server bounds mirrored for inline UX (the server 422s beyond them). */
const NAME_MAX = 200
const DESCRIPTION_MAX = 1000

const workspace = useWorkspaceStore()

const loading = ref(true)
/** A failed LOAD (get) — renders the retryable error state. */
const loadError = ref<string | null>(null)
/** The server truth the form was last loaded/saved from. */
const savedName = ref('')
const savedDescription = ref('')
/** The editable form fields. */
const name = ref('')
const description = ref('')
/** A save RPC in flight (disables the form). */
const saving = ref(false)
/** A failed SAVE — inline error line. */
const saveError = ref<string | null>(null)
/** Brief "Saved" confirmation after a successful save. */
const saved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | undefined

/** Anything to save? (trimmed-name emptiness is blocked separately). */
const dirty = computed(
  () => name.value !== savedName.value || description.value !== savedDescription.value,
)
/** An empty (or whitespace) name can never be saved — the server 422s it. */
const nameInvalid = computed(() => name.value.trim().length === 0)
const canSave = computed(() => dirty.value && !nameInvalid.value && !saving.value)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const client = await resolveWorkerClient()
    const info = await client.admin.workspace.get()
    savedName.value = info.name
    savedDescription.value = info.description ?? ''
    name.value = savedName.value
    description.value = savedDescription.value
  } catch (err) {
    loadError.value = adminErrorCopy(err)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  saveError.value = null
  saved.value = false
  try {
    const client = await resolveWorkerClient()
    // PRESENCE-significant PATCH: send only what changed. A cleared
    // description is sent as '' (the explicit clear), never dropped.
    const info = await client.admin.workspace.update({
      ...(name.value !== savedName.value ? { name: name.value } : {}),
      ...(description.value !== savedDescription.value ? { description: description.value } : {}),
    })
    savedName.value = info.name
    savedDescription.value = info.description ?? ''
    name.value = savedName.value
    description.value = savedDescription.value
    // The saving admin's own switcher/header renames NOW; everyone else's
    // follows via the `workspace.updated` meta event through normal sync.
    workspace.applyWorkspaceUpdate({ name: info.name, description: info.description })
    saved.value = true
    if (savedTimer !== undefined) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => {
      saved.value = false
    }, 2000)
  } catch (err) {
    saveError.value = adminErrorCopy(err)
  } finally {
    saving.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <section data-testid="admin-workspace" aria-label="Workspace settings" class="flex flex-col">
    <p
      v-if="loading"
      class="px-1 py-4 text-[12px] text-muted"
      data-testid="admin-workspace-loading"
    >
      Loading workspace settings…
    </p>

    <EmptyState
      v-else-if="loadError"
      data-testid="admin-workspace-load-error"
      title="Couldn't load workspace settings"
      :description="loadError"
    >
      <template #action>
        <Button variant="ghost" size="sm" data-testid="admin-workspace-retry" @click="load">
          Retry
        </Button>
      </template>
    </EmptyState>

    <form v-else class="flex flex-col gap-3 px-1" @submit.prevent="save">
      <label class="flex flex-col gap-1 text-[12px] text-secondary">
        Workspace name
        <input
          v-model="name"
          type="text"
          :maxlength="NAME_MAX"
          :disabled="saving"
          data-testid="workspace-name"
          class="h-8 rounded border border-strong bg-transparent px-2 text-[13px] text-primary focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span v-if="nameInvalid" class="text-[11px] text-danger" data-testid="workspace-name-error">
          The workspace name can't be empty.
        </span>
      </label>

      <label class="flex flex-col gap-1 text-[12px] text-secondary">
        Description
        <textarea
          v-model="description"
          rows="3"
          :maxlength="DESCRIPTION_MAX"
          :disabled="saving"
          data-testid="workspace-description"
          placeholder="What is this workspace about?"
          class="resize-y rounded border border-strong bg-transparent px-2 py-1.5 text-[13px] text-primary focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        ></textarea>
      </label>

      <div class="flex items-center gap-2">
        <Button type="submit" size="sm" :disabled="!canSave" data-testid="workspace-save">
          {{ saving ? 'Saving…' : 'Save' }}
        </Button>
        <span
          v-if="saved"
          class="text-[12px] text-secondary"
          data-testid="workspace-saved"
          role="status"
        >
          Saved
        </span>
      </div>

      <p
        v-if="saveError"
        class="text-[12px] text-danger"
        data-testid="admin-workspace-error"
        role="alert"
      >
        {{ saveError }}
      </p>

      <p class="text-[11px] text-muted" data-testid="workspace-icon-note">
        A workspace icon is coming soon.
      </p>
    </form>
  </section>
</template>
