// worker/search.ts — message search (ENG-126, ENG-122 server FTS).
//
// The ONE read that is an HTTP call rather than a local projection query: the
// full-text index is Postgres-side (readable-scoped by the server), so the tab
// cannot answer it from the local `messages` cache. Everything token-ish stays
// worker-side — the tab passes only filters + an opaque `cursor` (the RPC caller
// never sees a URL, a bearer, or a `/v1/` path). Pagination is EXPLICIT and
// stateless: the search tab re-calls with the returned `next_cursor`.

import { RpcCodedError, type SearchParams, type SearchResult } from './types'

import type { HttpClient } from './http'

/**
 * Run `GET /v1/search`, URL-encoding only the DEFINED params (`q` is always sent;
 * `in`/`from`/`before`/`after`/`limit`/`cursor` are omitted when undefined). `before`
 * and `after` are integer `created_seq` bounds; `limit` is 1..50 (the server
 * clamps). Returns the hit page + `next_cursor` (normalized to `null` when absent).
 * A non-2xx folds into a coded RPC error (`handle` frames it) — never a throw that
 * would leak past the boundary.
 */
export async function searchMessages(
  http: HttpClient,
  params: SearchParams,
): Promise<SearchResult> {
  const qs = new URLSearchParams()
  qs.set('q', params.q)
  if (params.in !== undefined) qs.set('in', params.in)
  if (params.from !== undefined) qs.set('from', params.from)
  if (params.before !== undefined) qs.set('before', String(params.before))
  if (params.after !== undefined) qs.set('after', String(params.after))
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  if (params.cursor !== undefined) qs.set('cursor', params.cursor)

  const res = await http.get<SearchResult>(`/v1/search?${qs.toString()}`)
  if (!res.ok) {
    throw new RpcCodedError(res.error.code, res.error.title)
  }
  return {
    hits: Array.isArray(res.value.hits) ? res.value.hits : [],
    next_cursor: res.value.next_cursor ?? null,
  }
}
