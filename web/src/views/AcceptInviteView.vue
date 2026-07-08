<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

// The invite token is the path param (route /join/:token), never re-entered.
const inviteToken = computed(() =>
  typeof route.params.token === 'string' ? route.params.token : '',
)

// ENG-112: an already-signed-in user landing on /join/:token must NOT see the
// create-account form (they'd be creating a second, unrelated account). The route
// is public (the guard lets authenticated users stay), so we branch here on
// auth.phase and offer "go to app" or "log out to accept as a new user".
const isAuthenticated = computed(() => auth.phase === 'authenticated')
// AuthStatus carries no display_name (worker/types.ts), so surface the stable
// user id as the best-available identity for the "signed in as" line.
const signedInAs = computed(() => auth.myUserId ?? 'your account')
const loggingOut = ref(false)

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
    inviteToken.value.length > 0 &&
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
    const result = await auth.acceptInvite({
      token: inviteToken.value,
      display_name: displayName.value.trim(),
      email: email.value.trim(),
      password: password.value,
    })
    if (result.ok) {
      await router.push('/')
      return
    }
    errorMessage.value = result.message ?? 'Could not accept this invite.'
  } finally {
    submitting.value = false
  }
}

function goToApp(): void {
  void router.push('/')
}

// Log out in place so the create-account form appears for this SAME /join/:token
// — letting the current user accept the invite as a different, new account.
async function logoutToSwitch(): Promise<void> {
  loggingOut.value = true
  try {
    await auth.logout()
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-background p-4">
    <!-- ENG-112: already-signed-in state — never the create-account form. -->
    <section
      v-if="isAuthenticated"
      class="w-full max-w-sm space-y-5 rounded-lg border border-subtle bg-surface-elevated p-8 shadow-sm"
      data-test="already-signed-in"
    >
      <div class="space-y-1">
        <h1 class="text-xl font-semibold text-primary">You're already signed in</h1>
        <p class="text-sm text-secondary">
          You're already signed in as
          <span class="font-medium text-primary" data-test="signed-in-as">{{ signedInAs }}</span
          >.
        </p>
      </div>

      <button
        type="button"
        class="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        data-test="go-to-app"
        @click="goToApp"
      >
        Go to app
      </button>

      <button
        type="button"
        :disabled="loggingOut"
        class="w-full rounded-md border border-strong px-3 py-2 text-sm font-medium text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        data-test="logout"
        @click="logoutToSwitch"
      >
        {{ loggingOut ? 'Logging out…' : 'Log out to accept this invite as a new user' }}
      </button>
    </section>

    <form
      v-else
      class="w-full max-w-sm space-y-5 rounded-lg border border-subtle bg-surface-elevated p-8 shadow-sm"
      @submit.prevent="onSubmit"
    >
      <div class="space-y-1">
        <h1 class="text-xl font-semibold text-primary">Accept your invite</h1>
        <p class="text-sm text-secondary">Create your account to join the workspace.</p>
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
        {{ submitting ? 'Joining…' : 'Join workspace' }}
      </button>
    </form>
  </main>
</template>
