// lib/adminPolicy.ts — ENG-151 PR-3: a PURE client-side mirror of the server's
// member-update policy (`server/msgd/api/routers/admin.py::check_member_update`
// plus the endpoint's field-dependent bot rule). Used ONLY to hide/disable
// controls for good UX — the SERVER stays authoritative: even when this mirror
// permits an action, the UI must still surface a server 403 cleanly (a stale
// client is always possible).
//
// Mirrored rules, IN ORDER (first match wins), exactly as the server applies
// them:
//   1. actor is not owner/admin        → nothing (server `require_role`)
//   2. target is the actor (self)      → nothing (no self-modification, ever)
//   3. target is the owner             → nothing (the owner row is immutable)
//   4. admin actor + admin target      → nothing (only the owner manages admins)
//   5. target is a bot                 → deactivate/reactivate only (bot roles
//                                        are fixed at provisioning)
//   6. otherwise                       → role ∈ {admin, member, guest} + the
//                                        active toggle

import type { AdminAssignableRole, AdminMember } from '../worker'

/** The roles the admin PATCH can assign — `owner` is structurally excluded. */
export const ASSIGNABLE_ROLES: readonly AdminAssignableRole[] = ['admin', 'member', 'guest']

/** Which member-row controls the actor may use (both false ⇒ read-only row). */
export interface AdminMemberActions {
  /** May the actor change the target's role (the role dropdown)? */
  changeRole: boolean
  /** May the actor deactivate/reactivate the target? */
  toggleActive: boolean
}

/** The slice of a roster row the policy depends on. */
export type AdminPolicyTarget = Pick<AdminMember, 'user_id' | 'role' | 'is_bot'>

const NONE: AdminMemberActions = Object.freeze({ changeRole: false, toggleActive: false })

/**
 * The actions `actorRole`/`actorUserId` may take on `target` — the client's
 * mirror of the server matrix (see the module comment). An unknown actor
 * (missing role or user id) gets NO controls: without an identity the
 * self-edit rule cannot be checked, so fail closed.
 */
export function permittedMemberActions(
  actorRole: string | undefined,
  actorUserId: string | undefined,
  target: AdminPolicyTarget,
): AdminMemberActions {
  if (actorRole !== 'owner' && actorRole !== 'admin') return NONE
  if (!actorUserId || target.user_id === actorUserId) return NONE
  if (target.role === 'owner') return NONE
  if (actorRole === 'admin' && target.role === 'admin') return NONE
  if (target.is_bot) return { changeRole: false, toggleActive: true }
  return { changeRole: true, toggleActive: true }
}

// ---------------------------------------------------------------------------
// Coded-error copy — the admin RPCs reject with an error carrying the server's
// problem-type slug as `code` (worker `RpcCodedError` → tab `RpcCallError`).
// ---------------------------------------------------------------------------

const ERROR_COPY: Record<string, string> = {
  forbidden: 'You do not have permission to do that.',
  'not-found': 'That no longer exists.',
  'validation-error': 'That change was not valid.',
  network: 'Could not reach the server. Check your connection and try again.',
}

/** The coded-error slug off an admin RPC rejection, or null for a plain error. */
export function adminErrorCode(err: unknown): string | null {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const { code } = err
    if (typeof code === 'string') return code
  }
  return null
}

/** User-facing copy for an admin RPC failure (unknown codes get a safe fallback). */
export function adminErrorCopy(err: unknown): string {
  const code = adminErrorCode(err)
  return (code !== null ? ERROR_COPY[code] : undefined) ?? 'Something went wrong. Please try again.'
}
