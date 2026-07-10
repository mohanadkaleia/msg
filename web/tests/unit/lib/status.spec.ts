// tests/unit/lib/status.spec.ts — render-time custom-status resolution
// (ENG-164 lazy expiry, client half): the fold/profile carry the RAW
// status_expires_at; whether the status is VISIBLE is decided here.
import { describe, expect, it } from 'vitest'

import { activeStatus } from '../../../src/lib/status'

const NOW = new Date('2026-07-09T12:00:00.000Z')

describe('lib/status — activeStatus (ENG-164 lazy expiry)', () => {
  it('returns the emoji/text halves for an unexpired status', () => {
    expect(
      activeStatus(
        {
          status_emoji: '🌴',
          status_text: 'Vacation',
          status_expires_at: '2026-07-09T13:00:00.000Z',
        },
        NOW,
      ),
    ).toEqual({ emoji: '🌴', text: 'Vacation' })
  })

  it('a status with no expiry never auto-clears', () => {
    expect(activeStatus({ status_emoji: '🎧' }, NOW)).toEqual({ emoji: '🎧' })
    expect(activeStatus({ status_text: 'Focusing', status_expires_at: null }, NOW)).toEqual({
      text: 'Focusing',
    })
  })

  it('treats an EXPIRED status as absent (expires_at <= now)', () => {
    const past = {
      status_emoji: '🍜',
      status_text: 'Lunch',
      status_expires_at: '2026-07-09T11:59:59.000Z',
    }
    expect(activeStatus(past, NOW)).toBeNull()
    // Boundary: exactly now is expired too.
    expect(activeStatus({ status_text: 'x', status_expires_at: NOW.toISOString() }, NOW)).toBeNull()
  })

  it('returns null when there is nothing to show (unset / null / missing user)', () => {
    expect(activeStatus({}, NOW)).toBeNull()
    expect(activeStatus({ status_emoji: null, status_text: null }, NOW)).toBeNull()
    expect(activeStatus(null, NOW)).toBeNull()
    expect(activeStatus(undefined, NOW)).toBeNull()
  })

  it('fails closed on an unparsable expiry (garbage never pins a status)', () => {
    expect(activeStatus({ status_text: 'x', status_expires_at: 'not-a-timestamp' }, NOW)).toBeNull()
  })
})
