// stores/auth.ts — the tab-side auth state (ENG-78, R9). Fed by the worker
// client's `auth` namespace; HOLDS NO TOKEN — only identity. The worker owns the
// token (R1); this store issues intent and reflects status.

import { defineStore } from 'pinia'
import { ref } from 'vue'

import {
  getWorkerClient,
  type AcceptInviteCredentials,
  type ApiError,
  type AuthStatus,
  type LoginCredentials,
  type SetupCredentials,
} from '../worker'

/** 'unknown' until the first status() resolves; then anonymous / authenticated. */
export type AuthPhase = 'unknown' | 'anonymous' | 'authenticated'

/** The outcome an auth action reports to a view: success, or a display message. */
export interface AuthActionResult {
  ok: boolean
  message?: string
}

/** problem `code` → user-facing copy. Unmapped codes fall back to the title. */
const MESSAGES: Record<string, string> = {
  'invalid-credentials': 'Incorrect email or password.',
  unauthenticated: 'Your session has expired. Please sign in again.',
  'already-initialized': 'This workspace is already set up.',
  'invalid-device': 'This device could not be verified. Please try signing in again.',
  'invite-used': 'This invite has already been used.',
  'invite-expired': 'This invite has expired.',
  'invalid-invite': 'This invite link is not valid.',
  'account-conflict': 'An account for this email already exists.',
  'validation-error': 'Please check the details you entered.',
  network: 'Could not reach the server. Check your connection and try again.',
}

export function messageForError(error: ApiError): string {
  if (error.code === 'rate-limited') {
    return error.retryAfter
      ? `Too many attempts. Try again in ${error.retryAfter}s.`
      : 'Too many attempts. Please wait a moment and try again.'
  }
  return MESSAGES[error.code] ?? error.title ?? 'Something went wrong. Please try again.'
}

export const useAuthStore = defineStore('auth', () => {
  const phase = ref<AuthPhase>('unknown')
  const myUserId = ref<string | undefined>(undefined)
  const workspaceId = ref<string | undefined>(undefined)
  const role = ref<string | undefined>(undefined)

  function applyStatus(status: AuthStatus): void {
    if (status.authenticated) {
      phase.value = 'authenticated'
      myUserId.value = status.my_user_id
      workspaceId.value = status.workspace_id
      role.value = status.role
    } else {
      phase.value = 'anonymous'
      myUserId.value = undefined
      workspaceId.value = undefined
      role.value = undefined
    }
  }

  /** Resolve the initial phase from the worker (called by the router guard). */
  async function init(): Promise<void> {
    const client = await getWorkerClient()
    await client.ready()
    applyStatus(await client.auth.status())
  }

  async function login(credentials: LoginCredentials): Promise<AuthActionResult> {
    const client = await getWorkerClient()
    const res = await client.auth.login(credentials)
    if (res.ok) {
      applyStatus(res.status)
      return { ok: true }
    }
    return { ok: false, message: messageForError(res.error) }
  }

  async function setup(credentials: SetupCredentials): Promise<AuthActionResult> {
    const client = await getWorkerClient()
    const res = await client.auth.setup(credentials)
    if (res.ok) {
      applyStatus(res.status)
      return { ok: true }
    }
    return { ok: false, message: messageForError(res.error) }
  }

  async function acceptInvite(credentials: AcceptInviteCredentials): Promise<AuthActionResult> {
    const client = await getWorkerClient()
    const res = await client.auth.acceptInvite(credentials)
    if (res.ok) {
      applyStatus(res.status)
      return { ok: true }
    }
    return { ok: false, message: messageForError(res.error) }
  }

  async function logout(): Promise<void> {
    const client = await getWorkerClient()
    await client.auth.logout()
    applyStatus({ authenticated: false })
  }

  return { phase, myUserId, workspaceId, role, init, login, setup, acceptInvite, logout }
})
