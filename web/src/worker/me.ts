// worker/me.ts — the self-profile RPC arms: HTTP pass-through over `/v1/me`,
// mirroring admin.ts (the ENG-151 precedent). The worker's authed HttpClient
// attaches the bearer; the tab passes only plain params and reads back plain
// data — no token, URL, or `/v1/` path ever crosses the RPC boundary (R1).
//
// DELIBERATELY NOT local-first for the READ: email/role are server-operational
// truth (the users row), so `me.get` re-queries on demand and persists nothing.
// The WRITE (`me.update`) also appends a server-authored `user.profile_updated`
// meta event SERVER-side — that event arrives back over the normal sync path
// and renames the member in the local directory fold (projection.ts), which is
// how the UserCard / author names pick up the new display name.
//
// Error mapping: a non-2xx folds through http.ts's problem+json parser into an
// `ApiError` whose `code` is the server's problem-type slug — `unauthenticated`
// (401), `validation-error` (422, empty/oversized name) — and is re-thrown as
// an RpcCodedError, so `WorkerCore.handle` frames it as a structured
// `{ ok:false, error:{ code } }` the UI can distinguish, never a bare throw.

import { RpcCodedError, type MeProfile, type MeUpdateParams } from './types'

import type { ApiResult, HttpClient } from './http'

/** Fold an `ApiResult` failure into a coded RPC error (admin.ts precedent). */
function unwrap<T>(res: ApiResult<T>): T {
  if (!res.ok) throw new RpcCodedError(res.error.code, res.error.title)
  return res.value
}

/** `me.get` → `GET /v1/me` (the caller's own profile, live server truth). */
export async function getMe(http: HttpClient): Promise<MeProfile> {
  return unwrap(await http.get<MeProfile>('/v1/me'))
}

/**
 * `me.update` → `PATCH /v1/me`. Structurally self-only (no user_id exists on
 * this surface); the response is the updated profile. SUBSET semantics
 * (ENG-164): the body carries ONLY the params the caller actually set —
 * `undefined` fields are omitted (untouched server-side) while an explicit
 * `null` is sent (it CLEARS title/description/status). A 422 (out-of-bounds
 * field) surfaces as `validation-error`.
 */
export async function updateMe(http: HttpClient, params: MeUpdateParams): Promise<MeProfile> {
  const body: Record<string, unknown> = {}
  if (params.display_name !== undefined) body['display_name'] = params.display_name
  if (params.title !== undefined) body['title'] = params.title
  if (params.description !== undefined) body['description'] = params.description
  if (params.status !== undefined) body['status'] = params.status
  return unwrap(await http.patch<MeProfile>('/v1/me', body))
}
