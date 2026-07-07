import { describe, expect, it } from 'vitest'

import { sanitizePastedHtml } from '../../../src/components/shell/composer/sanitize'

describe('composer/sanitize — pasted HTML is reduced to inert text (XSS boundary)', () => {
  it('drops <script> bodies entirely', () => {
    expect(sanitizePastedHtml('<script>alert(1)</script>hello')).toBe('hello')
  })

  it('strips an <img onerror> to nothing (no element, no handler survives)', () => {
    const out = sanitizePastedHtml('<img src=x onerror="alert(1)">bad')
    expect(out).toBe('bad')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('onerror')
  })

  it('collapses arbitrary markup to its text content — never live HTML', () => {
    const out = sanitizePastedHtml('<b>bold</b> <a href="javascript:alert(1)">link</a>')
    expect(out).toBe('bold link')
    expect(out).not.toContain('<')
    expect(out).not.toContain('javascript:')
  })

  it('is a no-op-ish passthrough for plain text', () => {
    expect(sanitizePastedHtml('just text')).toBe('just text')
  })
})
