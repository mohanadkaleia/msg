// lib/searchFilters.ts — the ENG-127 search-input filter grammar (pure, tab-side).
//
// Parses `in:#channel` / `from:@name` tokens out of the raw input; the leftover
// words are the free-text `q`. Resolution (name → stream_id / user_id) is a pure
// lookup against the workspace streams / directory the caller already holds —
// zero network, and the resolved ids are what `client.search` receives.
//
// `before:` / `after:` are RECOGNIZED but UNSUPPORTED for the MVP: the server
// bounds them by `created_seq` (an opaque sequence int, NOT a calendar date), so
// there is no honest date→seq mapping tab-side. The tokens are stripped from `q`
// and surfaced in `unsupported` so the UI can say so, rather than silently
// mis-filtering or faking a date conversion.

/** The parsed pieces of the search input (names still unresolved). */
export interface ParsedSearchInput {
  /** Free-text query left after stripping filter tokens. */
  q: string
  /** `in:` value with any leading '#' stripped (last occurrence wins), or null. */
  inName: string | null
  /** `from:` value with any leading '@' stripped (last occurrence wins), or null. */
  fromName: string | null
  /** Recognized-but-unsupported filter tokens (`before:`/`after:`), verbatim. */
  unsupported: string[]
}

/** Tokenize the raw input into free text + `in:`/`from:` filters. */
export function parseSearchInput(raw: string): ParsedSearchInput {
  const words: string[] = []
  let inName: string | null = null
  let fromName: string | null = null
  const unsupported: string[] = []
  for (const token of raw.split(/\s+/)) {
    if (token.length === 0) continue
    const lower = token.toLowerCase()
    if (lower.startsWith('in:')) {
      const value = token.slice('in:'.length).replace(/^#/, '')
      if (value.length > 0) inName = value
      continue
    }
    if (lower.startsWith('from:')) {
      const value = token.slice('from:'.length).replace(/^@/, '')
      if (value.length > 0) fromName = value
      continue
    }
    if (lower.startsWith('before:') || lower.startsWith('after:')) {
      unsupported.push(token)
      continue
    }
    words.push(token)
  }
  return { q: words.join(' '), inName, fromName, unsupported }
}

/**
 * Resolve an `in:` name to a stream_id: exact case-insensitive match on the
 * stream name. Returns null when nothing matches (the UI surfaces the miss and
 * does NOT search — never a silently dropped filter).
 */
export function resolveStreamName(
  name: string,
  streams: ReadonlyArray<{ stream_id: string; name?: string | null }>,
): string | null {
  const lower = name.toLowerCase()
  return streams.find((s) => (s.name ?? '').toLowerCase() === lower)?.stream_id ?? null
}

/**
 * Resolve a `from:` name to a user_id against the directory: an exact
 * case-insensitive display-name match wins; otherwise a UNIQUE case-insensitive
 * prefix match (so `from:@sara` finds "Sara Chen"). Ambiguous or unknown ⇒ null.
 */
export function resolveUserName(
  name: string,
  users: ReadonlyArray<{ user_id: string; display_name: string }>,
): string | null {
  const lower = name.toLowerCase()
  const exact = users.filter((u) => u.display_name.toLowerCase() === lower)
  if (exact.length === 1) return exact[0]!.user_id
  if (exact.length > 1) return null
  const prefix = users.filter((u) => u.display_name.toLowerCase().startsWith(lower))
  return prefix.length === 1 ? prefix[0]!.user_id : null
}
