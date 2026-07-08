<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()

const workspaceName = ref('')
const displayName = ref('')
const email = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref('')

const PASSWORD_MIN = 12

const emailValid = computed(() => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim()))
const passwordValid = computed(() => password.value.length >= PASSWORD_MIN)
const canSubmit = computed(
  () =>
    workspaceName.value.trim().length > 0 &&
    displayName.value.trim().length > 0 &&
    emailValid.value &&
    passwordValid.value &&
    !submitting.value,
)

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  errorMessage.value = ''
  try {
    const result = await auth.setup({
      workspace_name: workspaceName.value.trim(),
      display_name: displayName.value.trim(),
      email: email.value.trim(),
      password: password.value,
    })
    if (result.ok) {
      await router.push('/')
      return
    }
    errorMessage.value = result.message ?? 'Setup failed. Please try again.'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-background p-4">
    <form
      class="w-full max-w-sm space-y-5 rounded-lg border border-subtle bg-surface-elevated p-8 shadow-sm"
      @submit.prevent="onSubmit"
    >
      <div class="space-y-1">
        <h1 class="text-xl font-semibold text-primary">Create your workspace</h1>
        <p class="text-sm text-secondary">First-run setup — you'll be the owner.</p>
      </div>

      <p
        v-if="errorMessage"
        role="alert"
        class="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
        data-test="error"
      >
        {{ errorMessage }}
        <RouterLink v-if="errorMessage.includes('already set up')" to="/login" class="underline">
          Sign in
        </RouterLink>
      </p>

      <label class="block space-y-1">
        <span class="text-sm font-medium text-secondary">Workspace name</span>
        <input
          v-model="workspaceName"
          type="text"
          required
          class="w-full rounded-md border border-strong bg-transparent px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-test="workspace"
        />
      </label>

      <label class="block space-y-1">
        <span class="text-sm font-medium text-secondary">Your name</span>
        <input
          v-model="displayName"
          type="text"
          autocomplete="name"
          required
          class="w-full rounded-md border border-strong bg-transparent px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-test="display-name"
        />
      </label>

      <label class="block space-y-1">
        <span class="text-sm font-medium text-secondary">Email</span>
        <input
          v-model="email"
          type="email"
          autocomplete="username"
          required
          class="w-full rounded-md border border-strong bg-transparent px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-test="email"
        />
      </label>

      <label class="block space-y-1">
        <span class="text-sm font-medium text-secondary">Password</span>
        <input
          v-model="password"
          type="password"
          autocomplete="new-password"
          required
          class="w-full rounded-md border border-strong bg-transparent px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-test="password"
        />
        <span class="text-xs text-muted">At least {{ PASSWORD_MIN }} characters.</span>
      </label>

      <button
        type="submit"
        :disabled="!canSubmit"
        class="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        data-test="submit"
      >
        {{ submitting ? 'Creating…' : 'Create workspace' }}
      </button>
    </form>
  </main>
</template>
