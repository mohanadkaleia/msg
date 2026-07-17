// lib/textDirection.ts — per-message base-direction detection (ENG-175).
//
// A message whose text is Arabic (or another right-to-left script) must render
// right-aligned with `dir="rtl"`; English (and everything else) stays `dir="ltr"`.
// Detection is PER MESSAGE — each message's text is classified independently.
//
// HEURISTIC — "first strong" (the same rule the HTML `dir="auto"` attribute and
// UAX #9 rule P2 use): scan the text and let the FIRST strong-directional
// character decide the base direction. Chosen over majority-count because it is
// predictable (appending text never flips an existing message's alignment the
// way a count can), it matches what browsers themselves do for `dir="auto"`,
// and it handles the common mixed cases well — an Arabic sentence quoting an
// English word/link/mention stays RTL, an English sentence quoting Arabic stays
// LTR. Weak/neutral characters (digits, punctuation, whitespace, emoji) are
// skipped; text with no strong character (empty, "123!?", "🎉") defaults to LTR.
//
// Purely lexical: the text is only inspected, never rendered — no HTML sink here.

export type TextDirection = 'ltr' | 'rtl'

/**
 * Strong RIGHT-TO-LEFT characters (Bidi classes R + AL), by Unicode block:
 * - U+0590–05FF   Hebrew
 * - U+0600–06FF   Arabic
 * - U+0700–074F   Syriac
 * - U+0750–077F   Arabic Supplement
 * - U+0780–07BF   Thaana
 * - U+07C0–07FF   NKo
 * - U+0800–083F   Samaritan
 * - U+0840–085F   Mandaic
 * - U+0860–086F   Syriac Supplement
 * - U+08A0–08FF   Arabic Extended-A
 * - U+FB1D–FB4F   Hebrew presentation forms
 * - U+FB50–FDFF   Arabic presentation forms A
 * - U+FE70–FEFF   Arabic presentation forms B
 * - U+10800–10FFF Cypriot … Old Hungarian (historic RTL scripts)
 * - U+1E800–1EFFF Mende Kikakui, Adlam, Arabic Mathematical symbols
 *
 * Block-level approximation: a handful of technically-weak characters inside
 * these blocks (Hebrew points, Arabic-Indic digits ٠–٩) also match and count
 * as RTL here. For chat text that is the intuitive call — a message opening
 * with Arabic-Indic digits reads as Arabic — and it keeps the ranges simple.
 */
const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u

/**
 * Strong LEFT-TO-RIGHT characters, approximated as "any letter that is not in
 * an RTL block" — callers test RTL_CHAR first, so `\p{Letter}` here means a
 * strong LTR letter. Digits, punctuation and symbols are bidi-weak/neutral and
 * intentionally NOT matched (they must not decide the direction).
 */
const STRONG_LTR_CHAR = /\p{Letter}/u

/**
 * Detect the base direction of `text` from its FIRST strong-directional
 * character (first-strong, see module header). No strong character → 'ltr'.
 */
export function detectTextDirection(text: string): TextDirection {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl'
    if (STRONG_LTR_CHAR.test(ch)) return 'ltr'
  }
  return 'ltr'
}
