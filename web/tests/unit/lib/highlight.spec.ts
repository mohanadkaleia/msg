// tests/unit/lib/highlight.spec.ts — ENG-127 highlightSegments correctness + XSS
// teeth. The helper must ONLY ever split the input into plain-string segments
// (their concatenation reproduces the input byte-for-byte) — it never escapes,
// rewrites, or builds HTML; the view renders each segment via {{ }}. The DOM-level
// teeth (markup in text/terms stays inert when rendered) live in
// SearchOverlay.spec.ts, which fails if the render ever switches to v-html.
import { describe, expect, it } from 'vitest'

import { highlightSegments } from '../../../src/lib/highlight'

/** The segments' concatenation must always reproduce the input exactly. */
function joined(text: string, terms: string[]): string {
  return highlightSegments(text, terms)
    .map((s) => s.text)
    .join('')
}

describe('highlightSegments (ENG-127)', () => {
  it('splits around a single case-insensitive match', () => {
    expect(highlightSegments('Well Hello there', ['hello'])).toEqual([
      { text: 'Well ', match: false },
      { text: 'Hello', match: true },
      { text: ' there', match: false },
    ])
  })

  it('matches multiple terms and repeated occurrences', () => {
    expect(highlightSegments('foo bar foo', ['foo', 'bar'])).toEqual([
      { text: 'foo', match: true },
      { text: ' ', match: false },
      { text: 'bar', match: true },
      { text: ' ', match: false },
      { text: 'foo', match: true },
    ])
  })

  it('returns one unmatched segment when nothing matches', () => {
    expect(highlightSegments('nothing here', ['zzz'])).toEqual([
      { text: 'nothing here', match: false },
    ])
  })

  it('returns one unmatched segment for empty/whitespace-only terms', () => {
    expect(highlightSegments('some text', [])).toEqual([{ text: 'some text', match: false }])
    expect(highlightSegments('some text', ['', '   '])).toEqual([
      { text: 'some text', match: false },
    ])
  })

  it('returns no segments for empty text', () => {
    expect(highlightSegments('', ['a'])).toEqual([])
  })

  it('treats regex metacharacters in terms as literals (never as patterns)', () => {
    // '.*' as a pattern would swallow everything; as a literal it matches nothing here.
    expect(highlightSegments('abc', ['.*'])).toEqual([{ text: 'abc', match: false }])
    expect(highlightSegments('use c++ today (really)', ['c++', '(really)'])).toEqual([
      { text: 'use ', match: false },
      { text: 'c++', match: true },
      { text: ' today ', match: false },
      { text: '(really)', match: true },
    ])
  })

  it('prefers the longest term at a position (overlapping terms)', () => {
    expect(highlightSegments('foobar baz', ['foo', 'foobar'])).toEqual([
      { text: 'foobar', match: true },
      { text: ' baz', match: false },
    ])
  })

  // -- XSS teeth (helper level): markup passes through as PLAIN STRINGS --------
  // The helper must never mangle, interpret, or wrap markup — each segment is an
  // exact substring of the input, so the view's {{ }} interpolation is the one
  // and only escaping layer. Any HTML-string building here would break these.

  it('passes markup in the text through as plain segments (exact substrings)', () => {
    const text = 'hi <img src=x onerror=alert(1)> bye'
    const segs = highlightSegments(text, ['hi'])
    expect(segs).toEqual([
      { text: 'hi', match: true },
      { text: ' <img src=x onerror=alert(1)> bye', match: false },
    ])
    expect(joined(text, ['hi'])).toBe(text)
  })

  it('matches markup-shaped terms literally and keeps the raw text intact', () => {
    const text = 'try <script>alert(1)</script> now'
    const segs = highlightSegments(text, ['<script>'])
    expect(segs).toEqual([
      { text: 'try ', match: false },
      { text: '<script>', match: true },
      { text: 'alert(1)</script> now', match: false },
    ])
    expect(joined(text, ['<script>'])).toBe(text)
  })

  it('always reconstructs the original text from the segments', () => {
    const samples: Array<[string, string[]]> = [
      ['a"b\'c<d>e&f', ['<d>']],
      ['ABC abc AbC', ['abc']],
      ['no match at all', ['qqq', 'www']],
    ]
    for (const [text, terms] of samples) expect(joined(text, terms)).toBe(text)
  })
})
