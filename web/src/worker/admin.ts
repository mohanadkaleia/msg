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
  type AdminInviteCreateParams,
  type AdminInviteCreateResult,
  type AdminInviteRevokeResult,
  type AdminInvitesResult,
  type AdminMember,
  type AdminMembersResult,
  type AdminMemberUpdateParams,
  type AdminWorkspace,
  type AdminWorkspaceUpdateParams,
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

/**
 * `admin.invites.create` → `POST /v1/admin/invites`. The body carries the
 * assignable `role` (`owner` is structurally excluded by the type, mirroring
 * the server Literal — a 422 if forged) and, only when given, `ttl_seconds`
 * (the server defaults + clamps it). The 201 body is the join URL with the
 * RAW single-use token embedded — the ONE time it ever exists client-side; the
 * server stores only its sha256, so the facade must show it now or never.
 * A 403 (member/guest caller) / 422 (bad role or ttl) folds to the coded error.
 */
export async function createAdminInvite(
  http: HttpClient,
  params: AdminInviteCreateParams,
): Promise<AdminInviteCreateResult> {
  const body = {
    role: params.role,
    ...(params.ttl_seconds !== undefined ? { ttl_seconds: params.ttl_seconds } : {}),
  }
  return unwrap(await http.post<AdminInviteCreateResult>('/v1/admin/invites', body))
}

/** `admin.invites.revoke` → `DELETE /v1/admin/invites/{id}` (204 → ack; uniform 404). */
export async function revokeAdminInvite(
  http: HttpClient,
  params: { id: string },
): Promise<AdminInviteRevokeResult> {
  unwrap(await http.del(`/v1/admin/invites/${encodeURIComponent(params.id)}`))
  return { ok: true }
}

/** `admin.workspace.get` → `GET /v1/admin/workspace` (the settings row; ENG-152). */
export async function getAdminWorkspace(http: HttpClient): Promise<AdminWorkspace> {
  return unwrap(await http.get<AdminWorkspace>('/v1/admin/workspace'))
}

/**
 * `admin.workspace.update` → `PATCH /v1/admin/workspace`. The body carries
 * ONLY the defined fields (`name?`, `description?` — the server 422s an empty
 * PATCH; `description: ''` explicitly CLEARS it, so the empty string is sent,
 * not stripped). The response is the updated settings row. Server-side the
 * PATCH also emits the server-authored `workspace.updated` meta event the
 * local `workspace.info` fold renames the switcher/header from — the tab
 * needs no extra wiring beyond its normal sync subscription.
 */
export async function updateAdminWorkspace(
  http: HttpClient,
  params: AdminWorkspaceUpdateParams,
): Promise<AdminWorkspace> {
  const body = {
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
  }
  return unwrap(await http.patch<AdminWorkspace>('/v1/admin/workspace', body))
}
