// tests/unit/lib/adminPolicy.spec.ts — ENG-151 PR-3. The client's PURE mirror
// of the server member-update matrix (`routers/admin.py::check_member_update`
// + the endpoint bot rule). EXHAUSTIVE: every actor×target identity cell is
// asserted with the exact permitted-actions object, so dropping ANY rule from
// `permittedMemberActions` fails a cell here. The server stays authoritative —
// this mirror only drives control visibility.
import { describe, expect, it } from 'vitest'

import {
  ASSIGNABLE_ROLES,
  adminErrorCode,
  adminErrorCopy,
  permittedMemberActions,
  type AdminPolicyTarget,
} from '../../../src/lib/adminPolicy'

const NONE = { changeRole: false, toggleActive: false }
const FULL = { changeRole: true, toggleActive: true }
const DEACTIVATE_ONLY = { changeRole: false, toggleActive: true }

function target(role: string, over: Partial<AdminPolicyTarget> = {}): AdminPolicyTarget {
  return { user_id: `u_${role}`, role, is_bot: false, ...over }
}

describe('permittedMemberActions (ENG-151 policy mirror)', () => {
  it('excludes owner from the assignable roles', () => {
    expect(ASSIGNABLE_ROLES).toEqual(['admin', 'member', 'guest'])
    expect(ASSIGNABLE_ROLES).not.toContain('owner')
  })

  // Rule 1 — a non-privileged actor gets NO controls on ANY target (server
  // `require_role("owner","admin")` would 403 before the matrix even runs).
  it.each(['member', 'guest', 'unknown-role', undefined])(
    'actor role %s → no controls on any target',
    (actorRole) => {
      for (const t of [
        target('owner'),
        target('admin'),
        target('member'),
        target('guest'),
        target('member', { is_bot: true }),
      ]) {
        expect(permittedMemberActions(actorRole, 'u_actor', t)).toEqual(NONE)
      }
    },
  )

  // Rule 2 — self-edit is always denied (owner AND admin actors).
  it('owner on self → no controls', () => {
    expect(permittedMemberActions('owner', 'u_owner', target('owner'))).toEqual(NONE)
  })
  it('admin on self → no controls', () => {
    expect(permittedMemberActions('admin', 'u_admin', target('admin'))).toEqual(NONE)
  })
  it('missing actor id fails closed (self rule unverifiable)', () => {
    expect(permittedMemberActions('owner', undefined, target('member'))).toEqual(NONE)
    expect(permittedMemberActions('owner', '', target('member'))).toEqual(NONE)
  })

  // Rule 3 — the owner row is immutable for EVERY actor.
  it('admin on the owner → no controls', () => {
    expect(permittedMemberActions('admin', 'u_admin', target('owner'))).toEqual(NONE)
  })
  it('owner on another owner row → no controls', () => {
    // Single-owner is a server invariant, but the mirror stays safe regardless.
    expect(permittedMemberActions('owner', 'u_me', target('owner'))).toEqual(NONE)
  })

  // Rule 4 — only the owner manages admins: admin-on-admin is fully denied
  // (role AND active), while owner-on-admin is fully allowed.
  it('admin on a peer admin → no controls', () => {
    expect(permittedMemberActions('admin', 'u_me', target('admin'))).toEqual(NONE)
  })
  it('owner on an admin → full controls', () => {
    expect(permittedMemberActions('owner', 'u_owner', target('admin'))).toEqual(FULL)
  })

  // Rule 5 — bots: role fixed at provisioning, deactivate/reactivate allowed.
  it('owner on a bot → deactivate only', () => {
    expect(permittedMemberActions('owner', 'u_owner', target('member', { is_bot: true }))).toEqual(
      DEACTIVATE_ONLY,
    )
  })
  it('admin on a bot → deactivate only', () => {
    expect(permittedMemberActions('admin', 'u_admin', target('member', { is_bot: true }))).toEqual(
      DEACTIVATE_ONLY,
    )
  })
  it('admin on an ADMIN bot → no controls (identity rules run before the bot rule)', () => {
    expect(permittedMemberActions('admin', 'u_me', target('admin', { is_bot: true }))).toEqual(NONE)
  })

  // Rule 6 — the allowed cells: owner/admin on members + guests.
  it('owner on a member → full controls', () => {
    expect(permittedMemberActions('owner', 'u_owner', target('member'))).toEqual(FULL)
  })
  it('owner on a guest → full controls', () => {
    expect(permittedMemberActions('owner', 'u_owner', target('guest'))).toEqual(FULL)
  })
  it('admin on a member → full controls', () => {
    expect(permittedMemberActions('admin', 'u_admin', target('member'))).toEqual(FULL)
  })
  it('admin on a guest → full controls', () => {
    expect(permittedMemberActions('admin', 'u_admin', target('guest'))).toEqual(FULL)
  })
})

describe('admin coded-error copy', () => {
  it('extracts the code from a coded rejection and maps known slugs', () => {
    const err = Object.assign(new Error('RPC error: forbidden'), { code: 'forbidden' })
    expect(adminErrorCode(err)).toBe('forbidden')
    expect(adminErrorCopy(err)).toMatch(/permission/i)
    expect(adminErrorCopy(Object.assign(new Error('x'), { code: 'not-found' }))).toMatch(
      /no longer exists/i,
    )
  })

  it('falls back safely for plain errors and unknown codes', () => {
    expect(adminErrorCode(new Error('boom'))).toBeNull()
    expect(adminErrorCopy(new Error('boom'))).toMatch(/something went wrong/i)
    expect(adminErrorCopy(Object.assign(new Error('x'), { code: 'weird' }))).toMatch(
      /something went wrong/i,
    )
  })
})
