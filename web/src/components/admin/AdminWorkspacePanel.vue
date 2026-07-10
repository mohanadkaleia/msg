<script setup lang="ts">
// AdminWorkspacePanel — ENG-152: the workspace settings form (name +
// description) for an owner/admin. Everything flows through the
// `client.admin.workspace.*` worker RPCs — this panel never touches HTTP or
// the token. The server persists the row AND emits the server-authored
// `workspace.updated` meta event, so every member's switcher/header renames
// through normal sync; for the saving admin we ALSO apply the PATCH response
// to the workspace store so their own shell renames instantly.
//
// The workspace ICON uploader (ENG-152) reuses the avatar image-upload seam
// (`client.admin.workspace.uploadIcon` / `clearIcon`) — the server does the
// safe decode + re-encode; this panel is just pick → preview → upload → remove.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import Button from '../ui/Button.vue'
import EmptyState from '../ui/EmptyState.vue'
import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { useWorkspaceIconUrl } from '../../composables/useWorkspaceIconUrl'
import { adminErrorCopy } from '../../lib/adminPolicy'
import { useWorkspaceStore } from '../../stores/workspace'

/** The coded slug off an RPC rejection (worker `RpcCodedError` → tab `RpcCallError`). */
function errorCode(err: unknown): string | null {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const { code } = err
    if (typeof code === 'string') return code
  }
  return null
}

/** Inline copy for the icon-upload failure modes (server 400/413 is the truth). */
const ICON_MESSAGES: Record<string, string> = {
  'invalid-image': 'That file could not be read as an image. Try a PNG or JPEG.',
  'file-too-large': 'That image is too large — pick one under 5 MB.',
  forbidden: 'Only an owner or admin can change the workspace icon.',
  network: 'Could not reach the server. Check your connection and try again.',
}

/** Server bounds mirrored for inline UX (the server 422s beyond them). */
const NAME_MAX = 200
const DESCRIPTION_MAX = 1000
/** Client-side pre-checks mirror the server caps (its 400/413 stays the truth). */
const ICON_MAX_BYTES = 5 * 1024 * 1024

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

// -- icon (ENG-152): pick → client-side preview → upload via the seam ---------
/** The server truth for the icon ref (null = no icon); mirrors the store fold. */
const savedIconSha = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
/** True while an icon upload/remove RPC is in flight. */
const iconBusy = ref(false)
/** A failed icon upload/remove — inline error under the icon block. */
const iconError = ref<string | null>(null)
/** Local object URL of the just-picked file — instant preview while (and after)
 * the upload runs; revoked on replace/unmount. */
const previewUrl = ref<string | null>(null)
/** True when the current server icon image failed to load (fall back to glyph). */
const iconFailed = ref(false)

const hasIcon = computed(() => savedIconSha.value !== null)
/** The server icon image (worker-fetched by sha), shown when no fresh preview. */
const { url: serverIconUrl } = useWorkspaceIconUrl(() => savedIconSha.value ?? undefined)
/** The two-letter workspace glyph — the fallback when there is no icon. */
const initials = computed(() => (savedName.value || 'W').slice(0, 2).toUpperCase())

function clearPreview(): void {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = null
}

function iconErrorCopy(err: unknown): string {
  const code = errorCode(err)
  return (
    (code !== null ? ICON_MESSAGES[code] : undefined) ??
    'Could not update the workspace icon. Please try again.'
  )
}

async function onIconPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // re-picking the same file must re-fire `change`
  if (!file) return
  iconError.value = null
  if (!file.type.startsWith('image/')) {
    iconError.value = ICON_MESSAGES['invalid-image'] ?? 'Not an image.'
    return
  }
  if (file.size > ICON_MAX_BYTES) {
    iconError.value = ICON_MESSAGES['file-too-large'] ?? 'Image too large.'
    return
  }
  clearPreview()
  previewUrl.value = URL.createObjectURL(file)
  iconBusy.value = true
  try {
    const client = await resolveWorkerClient()
    const info = await client.admin.workspace.uploadIcon(file)
    savedIconSha.value = info.icon_sha256
    iconFailed.value = false
    // The saving admin's own rail updates NOW; everyone else's follows via the
    // `workspace.updated` meta event through normal sync.
    workspace.applyWorkspaceUpdate({
      name: info.name,
      description: info.description,
      icon_sha256: info.icon_sha256,
    })
  } catch (err) {
    clearPreview() // the upload failed — don't show an icon the server rejected
    iconError.value = iconErrorCopy(err)
  } finally {
    iconBusy.value = false
  }
}

async function removeIcon(): Promise<void> {
  iconError.value = null
  iconBusy.value = true
  try {
    const client = await resolveWorkerClient()
    const info = await client.admin.workspace.clearIcon()
    savedIconSha.value = info.icon_sha256
    clearPreview()
    workspace.applyWorkspaceUpdate({
      name: info.name,
      description: info.description,
      icon_sha256: info.icon_sha256,
    })
  } catch (err) {
    iconError.value = iconErrorCopy(err)
  } finally {
    iconBusy.value = false
  }
}

onBeforeUnmount(clearPreview)

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
    savedIconSha.value = info.icon_sha256
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
    workspace.applyWorkspaceUpdate({
      name: info.name,
      description: info.description,
      icon_sha256: info.icon_sha256,
    })
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
      <!-- Workspace icon (ENG-152): current icon or the initials glyph, a hidden
           file picker, an instant local preview, and Remove. The server does the
           crop/resize/normalize; this is a plain pick + preview + upload. -->
      <div class="flex items-center gap-3">
        <span
          aria-hidden="true"
          class="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-md bg-accent-subtle text-lg font-semibold text-accent"
          data-testid="workspace-icon"
          :data-has-icon="previewUrl !== null || (hasIcon && !iconFailed) ? 'true' : 'false'"
        >
          <img
            v-if="previewUrl"
            :src="previewUrl"
            alt=""
            class="h-full w-full rounded-[inherit] object-cover"
          />
          <img
            v-else-if="hasIcon && serverIconUrl && !iconFailed"
            :src="serverIconUrl"
            alt=""
            class="h-full w-full rounded-[inherit] object-cover"
            @error="iconFailed = true"
          />
          <template v-else>{{ initials }}</template>
        </span>
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              class="hidden"
              data-testid="workspace-icon-upload"
              @change="onIconPicked"
            />
            <Button variant="ghost" size="sm" :disabled="iconBusy" @click="fileInput?.click()">
              {{ iconBusy ? 'Uploading…' : hasIcon || previewUrl ? 'Change icon' : 'Upload icon' }}
            </Button>
            <Button
              v-if="hasIcon"
              variant="ghost"
              size="sm"
              :disabled="iconBusy"
              data-testid="workspace-icon-remove"
              @click="removeIcon"
            >
              Remove
            </Button>
          </div>
          <p
            v-if="iconError"
            class="text-[11px] text-danger"
            data-testid="workspace-icon-error"
            role="alert"
          >
            {{ iconError }}
          </p>
        </div>
      </div>

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
    </form>
  </section>
</template>
