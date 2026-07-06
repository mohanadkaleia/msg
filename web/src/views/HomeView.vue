<script setup lang="ts">
// Placeholder authed landing (ENG-78). The real app shell is ENG-82; this only
// proves the authenticated entry works and offers a way back out (logout).
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const { myUserId, workspaceId, role } = storeToRefs(auth)

const loggingOut = ref(false)

async function onLogout(): Promise<void> {
  loggingOut.value = true
  try {
    await auth.logout()
    await router.push('/login')
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <main class="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 p-8">
    <div
      class="w-full max-w-md space-y-3 rounded-xl border border-slate-200 bg-white p-8 shadow-sm"
    >
      <h1 class="text-xl font-semibold text-slate-900">You're signed in</h1>
      <dl class="space-y-1 text-sm text-slate-600">
        <div class="flex justify-between gap-4">
          <dt class="text-slate-400">User</dt>
          <dd class="font-mono">{{ myUserId ?? '—' }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-slate-400">Workspace</dt>
          <dd class="font-mono">{{ workspaceId ?? '—' }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-slate-400">Role</dt>
          <dd class="font-mono">{{ role ?? '—' }}</dd>
        </div>
      </dl>
      <p class="text-xs text-slate-400">
        The full app shell arrives in a later milestone (ENG-82).
      </p>
      <button
        type="button"
        :disabled="loggingOut"
        class="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        data-test="logout"
        @click="onLogout"
      >
        {{ loggingOut ? 'Signing out…' : 'Sign out' }}
      </button>
    </div>
  </main>
</template>
