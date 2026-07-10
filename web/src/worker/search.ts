// worker/search.ts — message search (ENG-126, ENG-122 server FTS; ENG-166
// local FTS5).
//
// Two implementations behind ONE `SearchParams → SearchResult` contract,
// routed by `MsgDb.capabilities.fts` in WorkerCore:
//
//  • `searchMessages` — the HTTP read (Dexie/Memory, fts:false): the full-text
//    index is Postgres-side (readable-scoped by the server), so the tab cannot
//    answer it from the local `messages` cache. Everything token-ish stays
//    worker-side — the tab passes only filters + an opaque `cursor` (the RPC
//    caller never sees a URL, a bearer, or a `/v1/` path).
//  • `searchLocalMessages` — the local read (SqliteDb, fts:true, M6-2): the
//    same params answered from the `messages_fts` FTS5 index, zero network.
//
// Pagination is EXPLICIT and stateless in both: the search tab re-calls with
// the returned `next_cursor` (opaque server keyset token vs. a local integer
// offset — same string-typed field either way).

import { RpcCodedError, type MsgDb, type SearchParams, type SearchResult } from './types'

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

// ---------------------------------------------------------------------------
// Local FTS5 search (ENG-166, M6-2) — SqliteDb's `messages_fts` index.
// ---------------------------------------------------------------------------

/** The server's limit contract, mirrored (server/msgd/api/schemas/search.py). */
const DEFAULT_LIMIT = 20
const MIN_LIMIT = 1
const MAX_LIMIT = 50

/** A `q` unit: a double-quoted phrase, or one whitespace-delimited term. */
const MATCH_UNIT = /"([^"]*)"|(\S+)/g

/**
 * Compile the raw user `q` into a SANITIZED FTS5 MATCH expression. Every unit
 * — each bare term, and each `"quoted phrase"` kept as one unit — is emitted
 * as an FTS5 STRING (double-quoted, embedded quotes doubled), so FTS operators
 * in user input (`OR`, `NOT`, `NEAR`, `*`, `^`, parens, `col:`) are neutral
 * literal text, never grammar: no injection and no parse crash. Units are
 * joined by a space — FTS5's implicit AND. Units with no letter/digit are
 * DROPPED (the unicode61 tokenizer yields no token for pure punctuation, and
 * an empty phrase matches nothing — ANDing it in would zero the whole query,
 * where the server's `websearch_to_tsquery` just drops the token). Returns ''
 * when nothing queryable remains — the caller short-circuits to an empty page,
 * mirroring the server's whitespace-only short-circuit (never an error).
 */
export function buildFtsMatch(q: string): string {
  const units: string[] = []
  for (const m of q.matchAll(MATCH_UNIT)) {
    const unit = (m[1] ?? m[2] ?? '').trim()
    if (!/[\p{L}\p{N}]/u.test(unit)) continue
    units.push(`"${unit.replace(/"/g, '""')}"`)
  }
  return units.join(' ')
}

/**
 * Decode the LOCAL pagination cursor — a non-negative integer offset rendered
 * as a decimal string (the local analogue of the server's opaque keyset token;
 * same string-typed `cursor`/`next_cursor` fields). Any other shape throws the
 * same `invalid-cursor` code the server's 422 folds into, so a tab handles a
 * malformed cursor identically on both paths.
 */
function decodeLocalCursor(cursor: string): number {
  if (!/^\d{1,15}$/.test(cursor)) {
    throw new RpcCodedError('invalid-cursor', 'Invalid cursor')
  }
  return Number(cursor)
}

/**
 * Run `SearchParams` against the LOCAL FTS5 index (`db.searchMessagesFts`,
 * present iff `capabilities.fts`) and return the identical `SearchResult`
 * shape `searchMessages` does. `q` compiles via {@link buildFtsMatch}
 * (sanitized units, implicit AND); `in`/`from`/`before`/`after` map to WHERE
 * clauses over the `messages` projection exactly as the server applies them
 * (the params already carry resolved stream/user ids — same contract as the
 * HTTP call). Ranking is `bm25` best-first with `created_seq DESC` tie-break;
 * pagination is an integer-offset cursor over that stable total order, with
 * one extra row fetched to decide `next_cursor` without a count query.
 */
export async function searchLocalMessages(db: MsgDb, params: SearchParams): Promise<SearchResult> {
  const searchFts = db.searchMessagesFts?.bind(db)
  if (searchFts === undefined) {
    // Routing is capability-gated, so this is a wiring bug, not a user error.
    throw new RpcCodedError('fts-unavailable', 'backend advertises no local full-text index')
  }
  const match = buildFtsMatch(params.q)
  if (match === '') {
    return { hits: [], next_cursor: null }
  }
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, MIN_LIMIT), MAX_LIMIT)
  const offset = params.cursor !== undefined ? decodeLocalCursor(params.cursor) : 0
  const rows = await searchFts({
    match,
    ...(params.in !== undefined ? { streamId: params.in } : {}),
    ...(params.from !== undefined ? { authorUserId: params.from } : {}),
    ...(params.before !== undefined ? { beforeSeq: params.before } : {}),
    ...(params.after !== undefined ? { afterSeq: params.after } : {}),
    limit: limit + 1, // probe row: decides next_cursor, never returned
    offset,
  })
  const hasMore = rows.length > limit
  return {
    hits: rows.slice(0, limit),
    next_cursor: hasMore ? String(offset + limit) : null,
  }
}
