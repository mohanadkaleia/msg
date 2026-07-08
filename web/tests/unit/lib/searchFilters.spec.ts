// tests/unit/lib/searchFilters.spec.ts — ENG-127 filter-grammar parse + name
// resolution (pure; the component-level wiring is covered in SearchOverlay.spec).
import { describe, expect, it } from 'vitest'

import {
  parseSearchInput,
  resolveStreamName,
  resolveUserName,
} from '../../../src/lib/searchFilters'

describe('parseSearchInput (ENG-127)', () => {
  it('splits in:/from: filters from the free text', () => {
    expect(parseSearchInput('in:#eng from:@sara hello world')).toEqual({
      q: 'hello world',
      inName: 'eng',
      fromName: 'sara',
      unsupported: [],
    })
  })

  it('accepts the filters without # / @ prefixes and in any position', () => {
    expect(parseSearchInput('deploy in:general from:Bob notes')).toEqual({
      q: 'deploy notes',
      inName: 'general',
      fromName: 'Bob',
      unsupported: [],
    })
  })

  it('lets the LAST occurrence of a repeated filter win', () => {
    const parsed = parseSearchInput('in:#a in:#b hi')
    expect(parsed.inName).toBe('b')
    expect(parsed.q).toBe('hi')
  })

  it('drops an incomplete filter token (still being typed) without polluting q', () => {
    expect(parseSearchInput('in: hello')).toEqual({
      q: 'hello',
      inName: null,
      fromName: null,
      unsupported: [],
    })
  })

  it('strips before:/after: into `unsupported` — created_seq is not a date', () => {
    expect(parseSearchInput('before:2026-01-01 after:5 hello')).toEqual({
      q: 'hello',
      inName: null,
      fromName: null,
      unsupported: ['before:2026-01-01', 'after:5'],
    })
  })

  it('returns an empty q for a blank / filters-only input', () => {
    expect(parseSearchInput('').q).toBe('')
    expect(parseSearchInput('  in:#eng  ').q).toBe('')
  })
})

describe('resolveStreamName / resolveUserName (ENG-127)', () => {
  const streams = [
    { stream_id: 's_eng', name: 'eng' },
    { stream_id: 's_gen', name: 'general' },
  ]
  const users = [
    { user_id: 'u_sara', display_name: 'Sara Chen' },
    { user_id: 'u_sam', display_name: 'Sam' },
    { user_id: 'u_bob', display_name: 'Bob' },
  ]

  it('resolves a channel name case-insensitively; unknown → null', () => {
    expect(resolveStreamName('ENG', streams)).toBe('s_eng')
    expect(resolveStreamName('nope', streams)).toBeNull()
  })

  it('resolves an exact display name, else a UNIQUE prefix; ambiguous → null', () => {
    expect(resolveUserName('sara chen', users)).toBe('u_sara')
    expect(resolveUserName('sara', users)).toBe('u_sara') // unique prefix
    expect(resolveUserName('sam', users)).toBe('u_sam') // exact beats prefix-of-both
    expect(resolveUserName('sa', users)).toBeNull() // Sara/Sam — ambiguous
    expect(resolveUserName('zoe', users)).toBeNull()
  })
})
