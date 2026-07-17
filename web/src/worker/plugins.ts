// worker/plugins.ts — the plugins RPC arms (ENG-176 over the M5 backend):
// HTTP pass-through over `/v1/plugins/*`, mirroring admin.ts verbatim. The
// worker's authed HttpClient attaches the bearer; the tab passes only plain
// params and reads back plain data — no session token, URL path, or `/v1/`
// string ever crosses the RPC boundary (R1).
//
// DELIBERATELY NOT local-first: bots + webhooks are server-operational truth
// (owner/admin-gated, `require_role("owner","admin")` — see
// routers/plugins.py), so these calls persist NOTHING to the local DB. The
// Apps UI re-queries on demand.
//
// CREDENTIAL BOUNDARY (the invite discipline, D2): `mintPluginBotToken`
// returns the RAW bot bearer token and `createPluginHook` the capability URL
// with the RAW path token embedded — each exactly ONCE, passed straight
// through to the facade for one-time display. Neither is persisted, cached,
// or logged anywhere in this realm; every listing carries only sha256 hash
// handles (revoke handles, never credentials).
//
// Error mapping: a non-2xx folds through http.ts's problem+json parser into
// an `ApiError` whose `code` is the server's problem-type slug — `forbidden`
// (403: member/guest caller, deactivated-bot mint), `not-found` (404, uniform
// — no existence oracle: unknown/cross-workspace/wrong-kind ids and
// already-revoked handles are indistinguishable), `validation-error` (422,
// e.g. a forged scope) — re-thrown as an RpcCodedError so `WorkerCore.handle`
// frames a structured `{ ok:false, error:{ code } }`, never a bare throw.

import {
  RpcCodedError,
  type PluginActionResult,
  type PluginBot,
  type PluginBotCreateParams,
  type PluginBotsResult,
  type PluginHookCreateParams,
  type PluginHookCreateResult,
  type PluginHooksResult,
  type PluginStreamGrantParams,
  type PluginTokenMintParams,
  type PluginTokenMintResult,
  type PluginTokenRevokeParams,
} from './types'

import { isOfflineError, type ApiResult, type HttpClient } from './http'

/**
 * Fold an `ApiResult` failure into a coded RPC error (the admin.ts/search.ts
 * precedent). An unreachable server (fetch reject) folds to the uniform
 * `offline` code — plugin state is live server truth with no local mirror, so
 * the UI renders "available when online", never a crash.
 */
function unwrap<T>(res: ApiResult<T>): T {
  if (!res.ok) {
    if (isOfflineError(res.error)) {
      throw new RpcCodedError('offline', 'available when online')
    }
    throw new RpcCodedError(res.error.code, res.error.title)
  }
  return res.value
}

/** `plugins.bots.list` → `GET /v1/plugins/bots` (grants + token HASH handles only). */
export async function listPluginBots(http: HttpClient): Promise<PluginBotsResult> {
  const value = unwrap(await http.get<PluginBotsResult>('/v1/plugins/bots'))
  return { bots: Array.isArray(value.bots) ? value.bots : [] }
}

/**
 * `plugins.bots.create` → `POST /v1/plugins/bots`. The body carries the name,
 * the INSTALL scopes (the closed server Literal — a forged value is a 422),
 * and the channel grants (`stream_ids`, always sent — `[]` when none, the
 * server default). The 201 echoes the bot row and NO credential — a token is
 * a separate, deliberate `mintPluginBotToken`.
 */
export async function createPluginBot(
  http: HttpClient,
  params: PluginBotCreateParams,
): Promise<PluginBot> {
  const body = {
    name: params.name,
    scopes: params.scopes,
    stream_ids: params.stream_ids ?? [],
  }
  return unwrap(await http.post<PluginBot>('/v1/plugins/bots', body))
}

/**
 * `plugins.bots.mintToken` → `POST /v1/plugins/bots/{bot_user_id}/tokens`.
 * `scopes` is sent only when given (omitted → the server defaults to the
 * bot's install scopes). The 201 carries the RAW token — the ONE time it ever
 * exists client-side (the server stores only its sha256); it is returned to
 * the facade verbatim for one-time display and never touched otherwise. A
 * deactivated bot is a server 403 (`forbidden`) — no fresh credentials for a
 * disabled principal.
 */
export async function mintPluginBotToken(
  http: HttpClient,
  params: PluginTokenMintParams,
): Promise<PluginTokenMintResult> {
  const body = params.scopes !== undefined ? { scopes: params.scopes } : {}
  return unwrap(
    await http.post<PluginTokenMintResult>(
      `/v1/plugins/bots/${encodeURIComponent(params.bot_user_id)}/tokens`,
      body,
    ),
  )
}

/** `plugins.bots.revokeToken` → `DELETE .../tokens/{token_id}` (204 → ack;
 * uniform 404 — unknown/cross-bot/already-revoked are indistinguishable). */
export async function revokePluginBotToken(
  http: HttpClient,
  params: PluginTokenRevokeParams,
): Promise<PluginActionResult> {
  unwrap(
    await http.del(
      `/v1/plugins/bots/${encodeURIComponent(params.bot_user_id)}/tokens/${encodeURIComponent(params.token_id)}`,
    ),
  )
  return { ok: true }
}

/** `plugins.bots.grantStream` → `PUT .../streams/{stream_id}` (204; idempotent;
 * only `kind='channel'` streams are grantable — a DM/meta id is the uniform 404). */
export async function grantPluginBotStream(
  http: HttpClient,
  params: PluginStreamGrantParams,
): Promise<PluginActionResult> {
  unwrap(
    await http.put(
      `/v1/plugins/bots/${encodeURIComponent(params.bot_user_id)}/streams/${encodeURIComponent(params.stream_id)}`,
      undefined,
    ),
  )
  return { ok: true }
}

/** `plugins.bots.revokeStream` → `DELETE .../streams/{stream_id}` (204;
 * removal is immediate — the bot's guest predicate cuts on its next query). */
export async function revokePluginBotStream(
  http: HttpClient,
  params: PluginStreamGrantParams,
): Promise<PluginActionResult> {
  unwrap(
    await http.del(
      `/v1/plugins/bots/${encodeURIComponent(params.bot_user_id)}/streams/${encodeURIComponent(params.stream_id)}`,
    ),
  )
  return { ok: true }
}

/** `plugins.hooks.list` → `GET /v1/plugins/hooks` (`id` = sha256 hash handle —
 * the capability URL is never listed again). */
export async function listPluginHooks(http: HttpClient): Promise<PluginHooksResult> {
  const value = unwrap(await http.get<PluginHooksResult>('/v1/plugins/hooks'))
  return { hooks: Array.isArray(value.hooks) ? value.hooks : [] }
}

/**
 * `plugins.hooks.create` → `POST /v1/plugins/hooks`. The body pins the ONE
 * target channel + the hook's name; `bot_user_id` is sent only when given
 * (omitted → the server auto-provisions a dedicated `events:write` bot named
 * for the hook). The 201 carries the capability URL with the RAW path token
 * embedded — the ONE time it ever exists client-side; passed through to the
 * facade for one-time display, never persisted or logged.
 */
export async function createPluginHook(
  http: HttpClient,
  params: PluginHookCreateParams,
): Promise<PluginHookCreateResult> {
  const body = {
    stream_id: params.stream_id,
    name: params.name,
    ...(params.bot_user_id !== undefined ? { bot_user_id: params.bot_user_id } : {}),
  }
  return unwrap(await http.post<PluginHookCreateResult>('/v1/plugins/hooks', body))
}

/** `plugins.hooks.revoke` → `DELETE /v1/plugins/hooks/{id}` (204 → ack; HARD
 * delete server-side; uniform 404 — revoked ≡ never-existed). */
export async function revokePluginHook(
  http: HttpClient,
  params: { id: string },
): Promise<PluginActionResult> {
  unwrap(await http.del(`/v1/plugins/hooks/${encodeURIComponent(params.id)}`))
  return { ok: true }
}
