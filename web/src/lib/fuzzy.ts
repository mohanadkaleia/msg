// lib/fuzzy.ts — a tiny, dependency-free subsequence fuzzy matcher for the Cmd+K
// switcher (ENG-82). Pure + synchronous so it runs on every keystroke with no
// allocation storms and is trivially unit-testable. NOT a general fuzzy library:
// it scores an ordered-subsequence match (each query char appears in order),
// rewarding contiguous runs, word-boundary starts, and a prefix/exact hit — good
// enough to make "gen" jump to "#general" and feel instant.

/** A ranked candidate: the item plus its score (higher = better). */
export interface FuzzyMatch<T> {
  item: T
  score: number
}

/**
 * Score `query` against `text`. Returns `null` when `query` is not an ordered
 * subsequence of `text` (no match). An empty query matches everything (score 0)
 * so the palette shows the full list before the user types. Case-insensitive.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return 0
  const t = text.toLowerCase()

  let score = 0
  let qi = 0
  let prevMatchIndex = -1
  let runLength = 0

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue

    // Base point for a matched char.
    score += 1
    // Contiguous-run bonus (adjacent matches read as a "word").
    if (prevMatchIndex === ti - 1) {
      runLength += 1
      score += runLength * 2
    } else {
      runLength = 0
    }
    // Word-boundary bonus: match at start, or after a separator.
    const before = ti > 0 ? t[ti - 1] : ''
    if (ti === 0 || before === ' ' || before === '-' || before === '_' || before === '#') {
      score += 5
    }
    prevMatchIndex = ti
    qi += 1
  }

  if (qi < q.length) return null // not all query chars consumed → no match

  // Prefix / exact bonuses reward the most direct hits.
  if (t.startsWith(q)) score += 8
  if (t === q) score += 12
  // Gently prefer shorter targets on ties (a query is "more of" a short name).
  score -= t.length * 0.01

  return score
}

/**
 * Rank `items` against `query` by their `keyOf` text, dropping non-matches.
 * Stable within equal scores (preserves the input order — already meaningful,
 * e.g. unread-first). Empty query returns every item in input order.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  keyOf: (item: T) => string,
): FuzzyMatch<T>[] {
  const matches: Array<FuzzyMatch<T> & { index: number }> = []
  items.forEach((item, index) => {
    const score = fuzzyScore(query, keyOf(item))
    if (score !== null) matches.push({ item, score, index })
  })
  matches.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
  return matches.map(({ item, score }) => ({ item, score }))
}
