import { describe, expect, it } from 'vitest'

import { fuzzyFilter, fuzzyScore } from '../../../src/lib/fuzzy'

describe('fuzzyScore', () => {
  it('matches an ordered subsequence, case-insensitively', () => {
    expect(fuzzyScore('gen', 'general')).not.toBeNull()
    expect(fuzzyScore('GEN', 'general')).not.toBeNull()
    expect(fuzzyScore('grl', 'general')).not.toBeNull() // g..r..l in order
  })

  it('rejects a non-subsequence', () => {
    expect(fuzzyScore('xyz', 'general')).toBeNull()
    expect(fuzzyScore('nag', 'general')).toBeNull() // out of order
  })

  it('matches everything on an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
    expect(fuzzyScore('   ', 'anything')).toBe(0)
  })

  it('ranks a prefix/contiguous match above a scattered one', () => {
    const prefix = fuzzyScore('gen', 'general')!
    const scattered = fuzzyScore('gen', 'gardening')!
    expect(prefix).toBeGreaterThan(scattered)
  })
})

describe('fuzzyFilter', () => {
  const items = [
    { id: 's1', name: 'general' },
    { id: 's2', name: 'random' },
    { id: 's3', name: 'design' },
  ]

  it('drops non-matches and ranks best-first', () => {
    const out = fuzzyFilter(items, 'gen', (i) => i.name)
    expect(out.map((m) => m.item.id)).toEqual(['s1']) // only "general"
  })

  it('returns every item in order for an empty query', () => {
    const out = fuzzyFilter(items, '', (i) => i.name)
    expect(out.map((m) => m.item.id)).toEqual(['s1', 's2', 's3'])
  })
})
