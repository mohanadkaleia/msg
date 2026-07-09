// worker/admin.ts — the admin RPC arms (ENG-151): HTTP pass-through over
// `/v1/admin/*`, mirroring search.ts (the other non-projection read). The
// worker's authed HttpClient attaches the bearer; the tab passes only plain
// params and reads back plain data — no token, URL, or `/v1/` path ever
// crosses the RPC boundary (R1).
//
// DELIBERATELY NOT local-first: member/role/invite state is server-operational
// truth (the server appends no events for it — see routers/admin.py), so these
// calls persist NOTHING to the local DB — no projection, no synced-KV table.
// The future Admin UI (PR-3) re-queries on demand.
//
// Error mapping: a non-2xx folds through http.ts's problem+json parser into an
// `ApiError` whose `code` is the server's problem-type slug — `forbidden`
// (403, the policy matrix), `not-found` (404, uniform — no existence oracle),
// `validation-error` (422, e.g. an empty PATCH) — and is re-thrown as an
// RpcCodedError, so `WorkerCore.handle` frames it as a structured
// `{ ok:false, error:{ code } }` the UI can distinguish, never a bare throw.

import {
  RpcCodedError,
  type AdminInviteRevokeResult,
  type AdminInvitesResult,
  type AdminMember,
  type AdminMembersResult,
  type AdminMemberUpdateParams,
} from './types'

import type { ApiResult, HttpClient } from './http'

/** Fold an `ApiResult` failure into a coded RPC error (search.ts precedent). */
function unwrap<T>(res: ApiResult<T>): T {
  if (!res.ok) throw new RpcCodedError(res.error.code, res.error.title)
  return res.value
}

/** `admin.members.list` → `GET /v1/admin/members` (full roster: deactivated + bots too). */
export async function listAdminMembers(http: HttpClient): Promise<AdminMembersResult> {
  const value = unwrap(await http.get<AdminMembersResult>('/v1/admin/members'))
  return { members: Array.isArray(value.members) ? value.members : [] }
}

/**
 * `admin.members.update` → `PATCH /v1/admin/members/{user_id}`. The body
 * carries ONLY the defined fields (`role?`, `active?` — the server 422s an
 * empty PATCH); the response is the updated member row. A 403 policy denial
 * (self / owner / admin-on-admin / bot role) and the uniform 404 stay
 * distinguishable via their codes.
 */
export async function updateAdminMember(
  http: HttpClient,
  params: AdminMemberUpdateParams,
): Promise<AdminMember> {
  const body = {
    ...(params.role !== undefined ? { role: params.role } : {}),
    ...(params.active !== undefined ? { active: params.active } : {}),
  }
  return unwrap(
    await http.patch<AdminMember>(`/v1/admin/members/${encodeURIComponent(params.user_id)}`, body),
  )
}

/** `admin.invites.list` → `GET /v1/admin/invites` (pending only; `id` = sha256 token_hash). */
export async function listAdminInvites(http: HttpClient): Promise<AdminInvitesResult> {
  const value = unwrap(await http.get<AdminInvitesResult>('/v1/admin/invites'))
  return { invites: Array.isArray(value.invites) ? value.invites : [] }
}

/** `admin.invites.revoke` → `DELETE /v1/admin/invites/{id}` (204 → ack; uniform 404). */
export async function revokeAdminInvite(
  http: HttpClient,
  params: { id: string },
): Promise<AdminInviteRevokeResult> {
  unwrap(await http.del(`/v1/admin/invites/${encodeURIComponent(params.id)}`))
  return { ok: true }
}
