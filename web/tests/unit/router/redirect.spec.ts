import { describe, expect, it } from 'vitest'

import { safeRedirectPath } from '../../../src/router/redirect'

describe('safeRedirectPath', () => {
  it('honors a same-app absolute path', () => {
    expect(safeRedirectPath('/channels/general')).toBe('/channels/general')
    expect(safeRedirectPath('/')).toBe('/')
  })

  it('rejects a protocol-relative value → falls back to /', () => {
    expect(safeRedirectPath('//evil.com')).toBe('/')
    expect(safeRedirectPath('//evil.com/path')).toBe('/')
  })

  it('rejects an absolute off-origin URL → falls back to /', () => {
    expect(safeRedirectPath('https://evil.com')).toBe('/')
    expect(safeRedirectPath('http://evil.com/x')).toBe('/')
  })

  it('rejects a relative (non-slash) or non-string value → falls back to /', () => {
    expect(safeRedirectPath('channels/general')).toBe('/')
    expect(safeRedirectPath(undefined)).toBe('/')
    expect(safeRedirectPath(['/a', '/b'])).toBe('/')
    expect(safeRedirectPath(null)).toBe('/')
  })

  it('respects a custom fallback', () => {
    expect(safeRedirectPath('https://evil.com', '/home')).toBe('/home')
  })
})
