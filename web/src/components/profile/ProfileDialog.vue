<script setup lang="ts">
// ProfileDialog — the current user's own profile (view + edit).
//
// Reachable from the sidebar footer UserCard (the `open-profile` affordance). It
// reads/writes ONLY through the `client.me.*` worker RPCs (the worker owns the
// token; nothing here touches HTTP or an API path — `no-http-in-ui` stays
// green). The authoritative email/role come from `me.get`; presence is the live
// ephemeral store snapshot. ENG-164 widens the editable surface: display name,
// title (≤100), description (≤500), and a custom status — an emoji (a plain
// one-emoji input + quick-pick presets; deliberately no heavy picker dep), a
// status text (≤100) and a "clear after" duration the SERVER converts to an
// absolute expiry (lazy expiry: an expired status reads as cleared everywhere).
//
// SAVE is a SUBSET PATCH: only the fields the user actually changed are sent
// (`me.update` omits untouched keys), so a rename-only save still sends exactly
// `{ display_name }`. Clearing title/description sends an explicit `null`;
// emptying both status halves sends `status: null` (clears the whole status).
//
// After a successful save the server appends `user.profile_updated` to
// workspace-meta, which the sync engine folds into the local directory — so the
// UserCard + author names pick up the change. We nudge that along by refreshing
// the workspace directory once the save resolves (best-effort; the fold is the
// source of truth either way).
//
// SECURITY: every profile field is user-controlled — rendered via text
// interpolation only.
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'

import { resolveWorkerClient } from '../../composables/useWorkerClient'
import { usePresenceStore } from '../../stores/presence'
import { useWorkspaceStore } from '../../stores/workspace'
import Button from '../ui/Button.vue'
import PresenceDot from '../ui/PresenceDot.vue'

import type { MeProfile, MeUpdateParams } from '../../worker'

const emit = defineEmits<{ close: [] }>()

const presence = usePresenceStore()
const workspace = useWorkspaceStore()
const { myStatus } = storeToRefs(presence)

/** The loaded profile (email/role/is_bot are read-only; the rest is edited). */
const profile = ref<MeProfile | null>(null)
/** Editable drafts, seeded from the loaded profile. */
const draft = ref('')
const titleDraft = ref('')
const descriptionDraft = ref('')
const statusEmojiDraft = ref('')
const statusTextDraft = ref('')
/** '' = "Don't clear"; otherwise the closed server vocabulary. */
const clearAfterDraft = ref<'' | '30m' | '1h' | 'today'>('')
const loading = ref(true)
/** A failed initial LOAD (renders a retryable error state). */
const loadError = ref<string | null>(null)
/** A failed SAVE (inline error under the fields). */
const saveError = ref<string | null>(null)
/** True while a save RPC is in flight. */
const saving = ref(false)
/** True briefly after a successful save (the "Saved" confirmation). */
const saved = ref(false)

/** Quick-pick status presets (a lightweight stand-in for an emoji picker). */
const EMOJI_PRESETS = ['📅', '🎧', '🌴', '🤒', '🏠'] as const

/** The "clear after" choices — the server converts each to an absolute expiry. */
const CLEAR_AFTER_OPTIONS = [
  { value: '', label: "Don't clear" },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: 'today', label: 'Today' },
] as const

/** problem `code` → field-level copy; unmapped codes fall back to a generic line. */
const SAVE_MESSAGES: Record<string, string> = {
  'validation-error':
    'Enter a name between 1 and 200 characters (title up to 100, description up to 500, status up to 100 and a single emoji).',
  unauthenticated: 'Your session has expired. Please sign in again.',
  network: 'Could not reach the server. Check your connection and try again.',
}

/** The coded slug off an RPC rejection (worker `RpcCodedError` → tab `RpcCallError`). */
function errorCode(err: unknown): string | null {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const { code } = err
    if (typeof code === 'string') return code
  }
  return null
}

function saveErrorCopy(err: unknown): string {
  const code = errorCode(err)
  return (
    (code !== null ? SAVE_MESSAGES[code] : undefined) ??
    'Could not save your profile. Please try again.'
  )
}

const initial = computed(() => (draft.value.trim()[0] ?? '?').toUpperCase())
const statusLabel = computed(() => (myStatus.value === 'online' ? 'Online' : 'Offline'))

// -- dirty tracking (per field, so the PATCH stays a SUBSET) -----------------

const nameDirty = computed(() => draft.value.trim() !== (profile.value?.display_name ?? ''))
const titleDirty = computed(() => titleDraft.value.trim() !== (profile.value?.title ?? ''))
const descriptionDirty = computed(
  () => descriptionDraft.value.trim() !== (profile.value?.description ?? ''),
)
const statusDirty = computed(
  () =>
    statusEmojiDraft.value.trim() !== (profile.value?.status_emoji ?? '') ||
    statusTextDraft.value.trim() !== (profile.value?.status_text ?? '') ||
    clearAfterDraft.value !== '',
)
const anyDirty = computed(
  () => nameDirty.value || titleDirty.value || descriptionDirty.value || statusDirty.value,
)

/** Save is offered only for an in-bounds CHANGED profile (name stays required). */
const canSave = computed(() => {
  const trimmed = draft.value.trim()
  return !saving.value && trimmed.length > 0 && trimmed.length <= 200 && anyDirty.value
})

function seedDrafts(me: MeProfile): void {
  draft.value = me.display_name
  titleDraft.value = me.title ?? ''
  descriptionDraft.value = me.description ?? ''
  statusEmojiDraft.value = me.status_emoji ?? ''
  statusTextDraft.value = me.status_text ?? ''
  // `clear_after` is a write-only duration (the server stores the absolute
  // expiry), so the select always reseeds to "Don't clear".
  clearAfterDraft.value = ''
}

/** The SUBSET params for `me.update` — only the fields the user changed. */
function buildParams(): MeUpdateParams {
  const params: MeUpdateParams = {}
  if (nameDirty.value) params.display_name = draft.value.trim()
  if (titleDirty.value) params.title = titleDraft.value.trim() || null
  if (descriptionDirty.value) params.description = descriptionDraft.value.trim() || null
  if (statusDirty.value) {
    const emoji = statusEmojiDraft.value.trim()
    const text = statusTextDraft.value.trim()
    if (emoji === '' && text === '') {
      params.status = null // both halves emptied → clear the whole status
    } else {
      params.status = {
        emoji: emoji || null,
        text: text || null,
        ...(clearAfterDraft.value !== '' ? { clear_after: clearAfterDraft.value } : {}),
      }
    }
  }
  return params
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const client = await resolveWorkerClient()
    const me = await client.me.get()
    profile.value = me
    seedDrafts(me)
  } catch {
    loadError.value = 'Could not load your profile.'
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
    const updated = await client.me.update(buildParams())
    profile.value = updated
    seedDrafts(updated)
    saved.value = true
    // Nudge the directory fold so the footer UserCard reflects the change once
    // the `user.profile_updated` event has synced (best-effort; not load-bearing).
    void workspace.refresh()
  } catch (err) {
    saveError.value = saveErrorCopy(err)
  } finally {
    saving.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Your profile"
    data-testid="profile-dialog"
    @click.self="emit('close')"
  >
    <div
      class="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-lg border border-subtle bg-surface-elevated p-5 shadow-xl"
    >
      <h2 class="mb-4 text-sm font-semibold text-primary">Your profile</h2>

      <p
        v-if="loading"
        class="py-6 text-center text-[13px] text-muted"
        data-testid="profile-loading"
      >
        Loading your profile…
      </p>

      <div v-else-if="loadError" data-testid="profile-load-error">
        <p class="mb-3 text-[13px] text-danger">{{ loadError }}</p>
        <Button variant="ghost" size="sm" data-testid="profile-retry" @click="load">Retry</Button>
      </div>

      <template v-else-if="profile">
        <!-- Identity header: initials avatar + presence dot + status label. -->
        <div class="mb-4 flex items-center gap-3">
          <span class="relative shrink-0">
            <span
              aria-hidden="true"
              class="grid h-12 w-12 place-items-center rounded-full bg-accent-subtle text-lg font-semibold text-accent"
              >{{ initial }}</span
            >
            <PresenceDot
              :status="myStatus"
              class="absolute -bottom-0.5 -right-0.5 border-2 border-surface-elevated"
            />
          </span>
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-primary" data-testid="profile-name-preview">
              {{ draft.trim() || profile.display_name }}
            </p>
            <p v-if="titleDraft.trim()" class="truncate text-xs text-secondary">
              {{ titleDraft.trim() }}
            </p>
            <p class="text-xs text-muted" data-testid="profile-presence">{{ statusLabel }}</p>
          </div>
        </div>

        <!-- Editable display name. -->
        <label class="mb-1 block text-xs font-medium text-secondary" for="profile-name-input"
          >Display name</label
        >
        <input
          id="profile-name-input"
          v-model="draft"
          type="text"
          maxlength="200"
          class="mb-3 w-full rounded-md border border-strong bg-transparent px-2 py-1.5 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-testid="profile-display-name"
          autocomplete="off"
          @keydown.enter.prevent="save"
        />

        <!-- Title (ENG-164). -->
        <label class="mb-1 block text-xs font-medium text-secondary" for="profile-title-input"
          >Title</label
        >
        <input
          id="profile-title-input"
          v-model="titleDraft"
          type="text"
          maxlength="100"
          placeholder="e.g. Staff Engineer"
          class="mb-3 w-full rounded-md border border-strong bg-transparent px-2 py-1.5 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-testid="profile-title"
          autocomplete="off"
        />

        <!-- Description (ENG-164). -->
        <label class="mb-1 block text-xs font-medium text-secondary" for="profile-description-input"
          >About you</label
        >
        <textarea
          id="profile-description-input"
          v-model="descriptionDraft"
          rows="3"
          maxlength="500"
          placeholder="A few words about yourself"
          class="mb-3 w-full resize-y rounded-md border border-strong bg-transparent px-2 py-1.5 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-testid="profile-description"
        ></textarea>

        <!-- Custom status (ENG-164): emoji + text + clear-after. -->
        <fieldset class="mb-1">
          <legend class="mb-1 block text-xs font-medium text-secondary">Status</legend>
          <div class="mb-2 flex gap-2">
            <input
              v-model="statusEmojiDraft"
              type="text"
              maxlength="16"
              placeholder="😀"
              aria-label="Status emoji"
              class="w-14 rounded-md border border-strong bg-transparent px-2 py-1.5 text-center text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-testid="profile-status-emoji"
              autocomplete="off"
            />
            <input
              v-model="statusTextDraft"
              type="text"
              maxlength="100"
              placeholder="What's happening?"
              aria-label="Status text"
              class="min-w-0 flex-1 rounded-md border border-strong bg-transparent px-2 py-1.5 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-testid="profile-status-text"
              autocomplete="off"
            />
          </div>
          <!-- Quick-pick presets — a lightweight emoji picker stand-in. -->
          <div class="mb-2 flex gap-1">
            <button
              v-for="preset in EMOJI_PRESETS"
              :key="preset"
              type="button"
              class="grid h-7 w-7 place-items-center rounded-md border border-subtle text-sm transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              :aria-label="`Set status emoji ${preset}`"
              data-testid="profile-status-preset"
              @click="statusEmojiDraft = preset"
            >
              {{ preset }}
            </button>
          </div>
          <label class="mb-1 block text-xs font-medium text-secondary" for="profile-clear-after"
            >Clear after</label
          >
          <select
            id="profile-clear-after"
            v-model="clearAfterDraft"
            class="w-full rounded-md border border-strong bg-surface-elevated px-2 py-1.5 text-sm text-primary focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            data-testid="profile-status-clear-after"
          >
            <option v-for="opt in CLEAR_AFTER_OPTIONS" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </fieldset>

        <p v-if="saveError" class="mb-2 text-xs text-danger" data-testid="profile-error">
          {{ saveError }}
        </p>
        <p v-else-if="saved" class="mb-2 text-xs text-success" data-testid="profile-saved">
          Saved.
        </p>
        <div class="mb-4" />

        <!-- Read-only: email + role. -->
        <dl class="mb-5 space-y-2">
          <div class="flex items-center justify-between gap-3">
            <dt class="text-xs font-medium text-secondary">Email</dt>
            <dd class="truncate text-[13px] text-primary" data-testid="profile-email">
              {{ profile.email }}
            </dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-xs font-medium text-secondary">Role</dt>
            <dd>
              <span
                class="rounded-full border border-subtle px-1.5 text-[11px] font-medium capitalize text-secondary"
                data-testid="profile-role"
                >{{ profile.role }}</span
              >
            </dd>
          </div>
        </dl>

        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" data-testid="profile-close" @click="emit('close')">
            Close
          </Button>
          <Button
            variant="primary"
            size="sm"
            :disabled="!canSave"
            data-testid="profile-save"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </Button>
        </div>
      </template>
    </div>
  </div>
</template>
