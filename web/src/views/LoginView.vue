<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { safeRedirectPath } from '../router/redirect'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')
const submitting = ref(false)
const errorMessage = ref('')

const PASSWORD_MIN = 12

const emailValid = computed(() => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim()))
const passwordValid = computed(() => password.value.length >= PASSWORD_MIN)
const canSubmit = computed(() => emailValid.value && passwordValid.value && !submitting.value)

async function onSubmit(): Promise<void> {
  if (!canSubmit.value) return
  submitting.value = true
  errorMessage.value = ''
  try {
    const result = await auth.login({ email: email.value.trim(), password: password.value })
    if (result.ok) {
      // Guard the attacker-influenceable ?redirect= against off-origin values.
      await router.push(safeRedirectPath(route.query.redirect))
      return
    }
    errorMessage.value = result.message ?? 'Sign in failed. Please try again.'
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
        <h1 class="text-xl font-semibold text-primary">Sign in</h1>
        <p class="text-sm text-secondary">Welcome back to Serin.</p>
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
          autocomplete="current-password"
          required
          class="w-full rounded-md border border-strong bg-transparent px-3 py-2 text-sm text-primary placeholder:text-muted outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          data-test="password"
        />
      </label>

      <button
        type="submit"
        :disabled="!canSubmit"
        class="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        data-test="submit"
      >
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </main>
</template>
