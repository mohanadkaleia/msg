<script setup lang="ts">
// OnboardingView (ENG-170, M6-5) — the desktop first-run screen, gated to the
// Tauri env by the router (a browser navigation to /onboarding redirects
// home). Collects the msgd server URL + the local workspace folder, persists
// them via the Rust desktop-config commands, then full-document-navigates to
// the app root so a fresh page boots the worker client's desktop trim
// (SqliteDb + full mirror + keychain) against the fresh config. All
// Tauri-flavored imports are DYNAMIC and run only on user action — this view
// adds nothing to the web entry graph.
import { computed, ref } from 'vue'

const serverUrl = ref('')
const workspaceDir = ref('')
const submitting = ref(false)
const errorMessage = ref('')

const serverUrlValid = computed(() => {
  try {
    const url = new URL(serverUrl.value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
})
const canSubmit = computed(
  () => serverUrlValid.value && workspaceDir.value.length > 0 && !submitting.value,
)

async function pickFolder(): Promise<void> {
  errorMessage.value = ''
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({
      directory: true,
      multiple: false,
      title: 'Choose your msg workspace folder',
    })
    if (typeof picked === 'string' && picked.length > 0) workspaceDir.value = picked
  } catch {
    errorMessage.value = 'Could not open the folder picker. Please try again.'
  }
}

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  errorMessage.value = ''
  try {
    const { normalizeServerUrl, writeDesktopConfig } = await import('../worker/tauri/config')
    const normalized = normalizeServerUrl(serverUrl.value)
    if (!normalized) {
      errorMessage.value = 'Enter a valid http(s) server URL.'
      return
    }
    await writeDesktopConfig({ serverUrl: normalized, workspaceDir: workspaceDir.value })
    // Reboot the app on the fresh config: the worker-client singleton is
    // per-page, so a full-document navigation is the one clean way to re-run
    // the desktop boot. Navigate to the app ROOT (not a reload of the
    // /onboarding URL) so the fresh page lands on home → auth gate → login;
    // the router's bidirectional onboarding gate is the backstop either way.
    window.location.assign(import.meta.env.BASE_URL || '/')
  } catch {
    errorMessage.value = 'Saving the configuration failed. Please try again.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-background p-4">
    <form
      class="w-full max-w-md space-y-5 rounded-lg border border-subtle bg-surface-elevated p-8 shadow-sm"
      @submit.prevent="onSubmit"
    >
      <div class="space-y-1">
        <h1 class="text-xl font-semibold text-primary">Set up msg</h1>
        <p class="text-sm text-secondary">
          Point this app at your msg server and choose where your workspace lives on this computer.
        </p>
      </div>

      <p
        v-if="errorMessage"
        role="alert"
        class="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
        data-test="error"
      >
        {{ errorMessage }}
      </p>

      <label class="block space-y-1">
        <span class="text-sm font-medium text-secondary">Server URL</span>
        <input
          v-model="serverUrl"
          type="url"
          placeholder="https://msg.example.com"
          required
          class="w-full rounded-md border border-strong bg-transparent px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-test="server-url"
        />
      </label>

      <div class="space-y-1">
        <span class="text-sm font-medium text-secondary">Workspace folder</span>
        <div class="flex items-center gap-2">
          <p
            class="min-h-[2.25rem] flex-1 truncate rounded-md border border-strong px-3 py-2 text-sm"
            :class="workspaceDir ? 'text-primary' : 'text-muted'"
            data-test="workspace-dir"
          >
            {{ workspaceDir || 'No folder chosen yet' }}
          </p>
          <button
            type="button"
            class="shrink-0 rounded-md border border-strong px-3 py-2 text-sm font-medium text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            data-test="pick-folder"
            @click="pickFolder"
          >
            Choose folder…
          </button>
        </div>
        <p class="text-xs text-muted">
          Your messages sync into this folder as a portable, verifiable msg workspace.
        </p>
      </div>

      <button
        type="submit"
        :disabled="!canSubmit"
        class="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        data-test="submit"
      >
        {{ submitting ? 'Saving…' : 'Continue' }}
      </button>
    </form>
  </main>
</template>
