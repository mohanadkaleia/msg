import { describe, expect, it } from 'vitest'

import { detectTextDirection } from '../../../src/lib/textDirection'

describe('detectTextDirection', () => {
  it('classifies Arabic text as rtl', () => {
    expect(detectTextDirection('مرحبا بالعالم')).toBe('rtl')
    expect(detectTextDirection('السلام عليكم، كيف الحال؟')).toBe('rtl')
  })

  it('classifies Hebrew text as rtl', () => {
    expect(detectTextDirection('שלום עולם')).toBe('rtl')
  })

  it('classifies English (and other LTR-script) text as ltr', () => {
    expect(detectTextDirection('hello world')).toBe('ltr')
    expect(detectTextDirection('Ça va très bien')).toBe('ltr')
    expect(detectTextDirection('こんにちは')).toBe('ltr')
  })

  it('defaults empty and strong-less (neutral) text to ltr', () => {
    expect(detectTextDirection('')).toBe('ltr')
    expect(detectTextDirection('   ')).toBe('ltr')
    expect(detectTextDirection('123 456!?')).toBe('ltr')
    expect(detectTextDirection('🎉🎉🎉')).toBe('ltr')
    expect(detectTextDirection('...!?')).toBe('ltr')
  })

  // FIRST-STRONG is the documented contract (UAX #9 P2 / HTML dir="auto"):
  // the first strong-directional character decides; everything after it — even
  // a majority of the other direction — does not flip the result.
  it('mixed text: the FIRST strong character decides (Arabic-leading → rtl)', () => {
    expect(detectTextDirection('مرحبا hello world this tail is long and English')).toBe('rtl')
  })

  it('mixed text: the FIRST strong character decides (English-leading → ltr)', () => {
    expect(detectTextDirection('hello مرحبا بالعالم يا صديقي العزيز')).toBe('ltr')
  })

  it('skips leading neutrals (digits, punctuation, emoji, mentions) before the first strong char', () => {
    expect(detectTextDirection('123 مرحبا')).toBe('rtl')
    expect(detectTextDirection('"مرحبا" quoted')).toBe('rtl')
    expect(detectTextDirection('🎉 مبروك!')).toBe('rtl')
    expect(detectTextDirection('… hello')).toBe('ltr')
  })

  it('treats Arabic presentation forms as rtl', () => {
    // U+FEFB (LAM-ALEF ligature, presentation forms B) and U+FB50 (Alef Wasla, forms A).
    expect(detectTextDirection('ﻻ')).toBe('rtl')
    expect(detectTextDirection('ﭐ')).toBe('rtl')
  })

  it('handles supplementary-plane RTL scripts (Adlam) via code-point iteration', () => {
    // U+1E900 ADLAM CAPITAL LETTER ALIF — a surrogate pair in UTF-16.
    expect(detectTextDirection('\u{1E900}')).toBe('rtl')
  })
})
