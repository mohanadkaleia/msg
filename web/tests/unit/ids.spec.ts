// @vitest-environment node
//
// Typed-ULID format, monotonicity, and validate/parse. Node env for a stable
// crypto.getRandomValues global (consistent with the other core specs).

import { describe, expect, it } from 'vitest'

import {
  ENTITY_PREFIXES,
  IdKind,
  isValidTypedId,
  isValidUlid,
  newEventId,
  newMessageId,
  newTypedId,
  newUlid,
  parseTypedId,
} from '../../src/core/ids'

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

describe('newUlid', () => {
  it('mints a 26-char Crockford ULID with a valid leading char', () => {
    const ulid = newUlid()
    expect(ulid).toHaveLength(26)
    expect(ulid).toMatch(ULID_RE)
    expect(isValidUlid(ulid)).toBe(true)
  })

  it('is strictly increasing across a same-millisecond burst (monotonic)', () => {
    const burst = Array.from({ length: 1000 }, () => newUlid())
    for (let i = 1; i < burst.length; i++) {
      // Strict lexicographic increase — no collisions, no reordering.
      expect(burst[i - 1]! < burst[i]!).toBe(true)
    }
    // A 1000-id burst almost certainly spans a single ms; sortedness must hold
    // regardless via the randomness increment.
    expect([...burst]).toEqual([...burst].sort())
  })
})

describe('newEventId', () => {
  it('is a bare ULID with no entity prefix', () => {
    const id = newEventId()
    expect(isValidUlid(id)).toBe(true)
    for (const prefix of ENTITY_PREFIXES) {
      expect(id.startsWith(prefix)).toBe(false)
    }
  })
})

describe('typed ids', () => {
  it('mints and validates each entity prefix', () => {
    for (const prefix of ENTITY_PREFIXES) {
      const id = newTypedId(prefix)
      expect(id.startsWith(prefix)).toBe(true)
      expect(isValidTypedId(id, prefix)).toBe(true)
      expect(isValidUlid(id.slice(prefix.length))).toBe(true)
    }
  })

  it('rejects an unknown prefix', () => {
    expect(() => newTypedId('z_' as unknown as IdKind)).toThrow()
  })

  it('parses a typed id into prefix + ulid', () => {
    const id = newMessageId()
    const parsed = parseTypedId(id, IdKind.MESSAGE)
    expect(parsed.prefix).toBe('m_')
    expect(parsed.ulid).toBe(id.slice(2))
    expect(isValidUlid(parsed.ulid)).toBe(true)
  })

  it('parses without an expected prefix by detecting a known one', () => {
    const id = newMessageId()
    expect(parseTypedId(id).prefix).toBe('m_')
  })

  it('throws on a wrong expected prefix', () => {
    expect(() => parseTypedId(newMessageId(), IdKind.USER)).toThrow()
  })

  it('throws on an id with no known prefix', () => {
    expect(() => parseTypedId(newUlid())).toThrow()
  })
})

describe('isValidUlid', () => {
  it('rejects wrong length', () => {
    expect(isValidUlid('01JZ7N6A4M6Y8W5K2H7DGKX4P')).toBe(false) // 25
    expect(isValidUlid('01JZ7N6A4M6Y8W5K2H7DGKX4PAB')).toBe(false) // 27
  })

  it('rejects non-Crockford characters (I, L, O, U)', () => {
    expect(isValidUlid('01JZ7N6A4M6Y8W5K2H7DGKX4PI')).toBe(false)
  })

  it('rejects a leading char above 7 (48-bit timestamp overflow guard)', () => {
    expect(isValidUlid('81JZ7N6A4M6Y8W5K2H7DGKX4PA')).toBe(false)
  })
})
