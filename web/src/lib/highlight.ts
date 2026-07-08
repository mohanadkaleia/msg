// lib/highlight.ts — XSS-safe matched-term segmentation for search results (ENG-127).
//
// SECURITY (critical): a search hit's text is OTHER USERS' input and the query is
// arbitrary local input — neither may ever reach an HTML sink. This helper does the
// only safe thing: it splits the raw text into plain-string segments tagged
// match / no-match, and the view renders EACH segment through Vue text
// interpolation ({{ }}) — matches inside a <mark>, the rest as bare text nodes.
// No HTML string is ever built from the text or the terms, here or in the view.

/** One run of a search hit's text: `match` marks a matched query term. */
export interface HighlightSegment {
  text: string
  match: boolean
}

/** Escape a term so it matches LITERALLY inside a RegExp (never as a pattern). */
function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split `text` into segments around case-insensitive matches of `terms`.
 *
 * - Terms are matched literally (regex metacharacters escaped), case-insensitive.
 * - Empty/whitespace-only terms are dropped; no terms ⇒ one unmatched segment.
 * - Overlapping terms: longest term wins at any position (alternation is ordered
 *   longest-first), and matching resumes AFTER a match — no nested/overlapping
 *   segments, so concatenating the segments always reproduces `text` exactly.
 */
export function highlightSegments(text: string, terms: string[]): HighlightSegment[] {
  if (text.length === 0) return []
  const cleaned = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 0))]
  if (cleaned.length === 0) return [{ text, match: false }]
  const pattern = cleaned
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  const re = new RegExp(pattern, 'gi')
  const out: HighlightSegment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const start = m.index
    const matched = m[0]
    if (matched.length === 0) continue
    if (start > last) out.push({ text: text.slice(last, start), match: false })
    out.push({ text: matched, match: true })
    last = start + matched.length
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false })
  return out
}
