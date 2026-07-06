// @vitest-environment node
//
// Focused JCS unit tests: the ES6 number-formatting table, key ordering,
// escaping, the depth and integer-cap boundaries, surrogate rejection, and
// input-domain rejects. The frozen vector runner (vectors.spec.ts) is the
// cross-language gate; these give fast, localized diagnosis when a specific
// rule regresses. Node env for TextEncoder/TextDecoder consistency.

import { describe, expect, it } from 'vitest'

import {
  canonicalize,
  enforceIntegerCap,
  JCSError,
  MAX_DEPTH,
  parseJcsJson,
  type JSONValue,
} from '../../src/core/jcs'

/** Canonicalize a value and decode the resulting UTF-8 bytes back to a string. */
function canon(value: JSONValue): string {
  return new TextDecoder().decode(canonicalize(value))
}

describe('JCS number formatting (String(n) === ES6 Number::toString)', () => {
  // (input, expected canonical text). Pins the exact frozen-vector productions.
  const cases: Array<[number, string]> = [
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [2.0, '2'],
    [0.1, '0.1'],
    [1e30, '1e+30'],
    [1e21, '1e+21'],
    [9.999e22, '9.999e+22'],
    [1e-7, '1e-7'],
    [5e-324, '5e-324'],
    [9007199254740991, '9007199254740991'], // 2^53 - 1, the cap boundary
  ]

  for (const [input, expected] of cases) {
    it(`${String(input)} -> ${expected}`, () => {
      expect(canon(input)).toBe(expected)
    })
  }

  it('rejects NaN and Infinity (non-finite)', () => {
    expect(() => canonicalize(NaN)).toThrow(JCSError)
    expect(() => canonicalize(Infinity)).toThrow(JCSError)
    expect(() => canonicalize(-Infinity)).toThrow(JCSError)
  })
})

describe('JCS key ordering (UTF-16 code-unit sort)', () => {
  it('sorts plain keys', () => {
    expect(canon({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
  })

  it('sorts uppercase ASCII before lowercase', () => {
    expect(canon({ b: 1, B: 2, a: 3, A: 4 })).toBe('{"A":4,"B":2,"a":3,"b":1}')
  })

  it('sorts astral keys by UTF-16 code unit: U+1F600 (lead 0xD83D) before U+FFFF', () => {
    // Naive code-point sort would order U+FFFF first; UTF-16 code-unit sort does not.
    expect(canon({ '￿': 1, '\u{1f600}': 2 })).toBe('{"\u{1f600}":2,"￿":1}')
  })
})

describe('JCS string escaping (RFC 8785 §3.2.2.2)', () => {
  it('emits the short escapes', () => {
    expect(canon('"\\\n\t\b\f\r')).toBe('"\\"\\\\\\n\\t\\b\\f\\r"')
  })

  it('emits lowercase \\u00XX for other control chars', () => {
    expect(canon('\u0000\u0001\u001f')).toBe('"\\u0000\\u0001\\u001f"')
  })

  it('emits 0x7f (DEL) raw, not escaped', () => {
    const bytes = canonicalize('\u007f')
    // ["], 0x7f, ["]
    expect([...bytes]).toEqual([0x22, 0x7f, 0x22])
  })
})

describe('JCS depth guard (MAX_DEPTH = 128, iterative pre-pass)', () => {
  function nest(depth: number): JSONValue {
    let value: JSONValue = 1
    for (let i = 0; i < depth; i++) {
      value = [value]
    }
    return value
  }

  it('accepts nesting exactly at the cap (128)', () => {
    expect(() => canonicalize(nest(MAX_DEPTH))).not.toThrow()
  })

  it('rejects nesting one over the cap (129)', () => {
    expect(() => canonicalize(nest(MAX_DEPTH + 1))).toThrow(JCSError)
  })

  it('rejects a pathological 2000-deep value with JCSError, not a stack overflow', () => {
    // The iterative pre-pass must reject before the recursive serializer runs;
    // a RangeError (stack overflow) escaping here would fail the assertion.
    expect(() => canonicalize(nest(2000))).toThrow(JCSError)
  })
})

describe('JCS integer interop cap (parse-time, on the source literal)', () => {
  it('accepts the boundary 2^53 - 1', () => {
    expect(parseJcsJson('9007199254740991')).toBe(9007199254740991)
    expect(parseJcsJson('-9007199254740991')).toBe(-9007199254740991)
  })

  it('rejects plain integer literals over the cap (immune to JSON.parse truncation)', () => {
    expect(() => parseJcsJson('9007199254740992')).toThrow(JCSError)
    expect(() => parseJcsJson('9007199254740993')).toThrow(JCSError)
    expect(() => parseJcsJson('-9007199254740992')).toThrow(JCSError)
  })

  it('accepts exponential-form numbers beyond 2^53 (float path, uncapped)', () => {
    expect(parseJcsJson('1e21')).toBe(1e21)
    expect(parseJcsJson('1e30')).toBe(1e30)
    expect(parseJcsJson('9.999e22')).toBe(9.999e22)
  })

  // Forces the no-source-access branch that a runtime without JSON.parse
  // source-text access would take. The cap MUST fail closed there (throw), not
  // fail open (silently skip the check and accept an over-cap integer that would
  // hash differently from the Python reference).
  describe('fail-closed on a runtime without JSON source-text access', () => {
    it('rejects an over-cap integer when no source is available', () => {
      // 2**53 and 2**54 are exactly representable and over the ±(2^53−1) cap.
      expect(() => enforceIntegerCap(2 ** 53, undefined)).toThrow(JCSError)
      expect(() => enforceIntegerCap(2 ** 54, undefined)).toThrow(JCSError)
    })

    it('rejects any number when no source is available (cannot verify → refuse)', () => {
      expect(() => enforceIntegerCap(42, undefined)).toThrow(JCSError)
      expect(() => enforceIntegerCap(1e21, undefined)).toThrow(JCSError)
    })

    it('does not reject non-numbers (nothing to cap)', () => {
      expect(() => enforceIntegerCap('42', undefined)).not.toThrow()
      expect(() => enforceIntegerCap(null, undefined)).not.toThrow()
    })

    it('still enforces the cap normally when the source literal is present', () => {
      expect(() => enforceIntegerCap(9007199254740991, '9007199254740991')).not.toThrow()
      expect(() => enforceIntegerCap(1e21, '1e21')).not.toThrow()
      expect(() => enforceIntegerCap(9007199254740992, '9007199254740992')).toThrow(JCSError)
    })
  })
})

describe('JCS lone-surrogate rejection', () => {
  it('rejects a lone-surrogate string value', () => {
    expect(() => canonicalize({ x: '\ud800' })).toThrow(JCSError)
  })

  it('rejects a lone-surrogate object key', () => {
    expect(() => canonicalize({ '\ud800': 1 })).toThrow(JCSError)
  })
})

describe('JCS input-domain rejects', () => {
  it('rejects bigint', () => {
    expect(() => canonicalize(10n as unknown as JSONValue)).toThrow(JCSError)
  })

  it('rejects undefined', () => {
    expect(() => canonicalize(undefined as unknown as JSONValue)).toThrow(JCSError)
  })

  it('rejects a non-plain object (Date)', () => {
    expect(() => canonicalize(new Date() as unknown as JSONValue)).toThrow(JCSError)
  })

  it('rejects a non-plain object (Map)', () => {
    expect(() => canonicalize(new Map() as unknown as JSONValue)).toThrow(JCSError)
  })
})
