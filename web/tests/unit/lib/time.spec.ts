import { describe, expect, it } from 'vitest'

import { newMessageId } from '../../../src/core'
import {
  decodeUlidTime,
  formatActivityTime,
  formatDayDivider,
  formatExpiresIn,
  messageTimestamp,
} from '../../../src/lib/time'

describe('decodeUlidTime', () => {
  it('recovers the mint time from a freshly minted message id', () => {
    const before = Date.now()
    const id = newMessageId()
    const after = Date.now()
    const ms = decodeUlidTime(id)
    expect(ms).not.toBeNull()
    expect(ms!).toBeGreaterThanOrEqual(before - 1)
    expect(ms!).toBeLessThanOrEqual(after + 1)
  })

  it('returns null for an id too short / malformed to carry a timestamp', () => {
    expect(decodeUlidTime('m_short')).toBeNull()
    expect(decodeUlidTime('')).toBeNull()
  })
})

describe('messageTimestamp', () => {
  it('prefers the ULID id time, falling back to created_seq for pending rows', () => {
    const id = newMessageId()
    const idTime = decodeUlidTime(id)!
    expect(messageTimestamp({ message_id: id, created_seq: 42 })).toBe(idTime)
    // A non-decodable id (optimistic sentinel) falls back to the created_seq epoch.
    expect(messageTimestamp({ message_id: 'm_bad', created_seq: 1_700_000_000_000 })).toBe(
      1_700_000_000_000,
    )
  })
})

describe('formatDayDivider', () => {
  const now = new Date('2026-07-06T12:00:00').getTime()
  const DAY = 24 * 60 * 60 * 1000

  it('labels the current + previous calendar days', () => {
    expect(formatDayDivider(now, now)).toBe('Today')
    expect(formatDayDivider(now - DAY, now)).toBe('Yesterday')
  })

  it('labels an older day with a formatted date', () => {
    const label = formatDayDivider(now - 5 * DAY, now)
    expect(label).not.toBe('Today')
    expect(label).not.toBe('Yesterday')
    expect(label).toMatch(/2026/)
  })
})

describe('formatActivityTime (ENG-136 Inbox)', () => {
  const now = new Date('2026-07-06T12:00:00').getTime()
  const DAY = 24 * 60 * 60 * 1000

  it('shows the clock time for today', () => {
    // Same instant → the locale clock time (e.g. "12:00 PM"), never a day label.
    const label = formatActivityTime(now, now)
    expect(label).toMatch(/12/)
    expect(label).not.toBe('Yesterday')
  })

  it('shows "Yesterday" for the previous calendar day', () => {
    expect(formatActivityTime(now - DAY, now)).toBe('Yesterday')
  })

  it('shows a short date for anything older', () => {
    const label = formatActivityTime(now - 5 * DAY, now)
    expect(label).not.toBe('Yesterday')
    expect(label).toMatch(/Jul|1/) // locale short date, e.g. "Jul 1"
  })
})

describe('formatExpiresIn (ENG-151 Admin invites)', () => {
  const now = new Date('2026-07-06T12:00:00Z').getTime()
  const HOUR = 60 * 60 * 1000

  it('shows minutes under an hour (floored at 1m)', () => {
    expect(formatExpiresIn(new Date(now + 45 * 60 * 1000).toISOString(), now)).toBe('in 45m')
    expect(formatExpiresIn(new Date(now + 10 * 1000).toISOString(), now)).toBe('in 1m')
  })

  it('shows hours under two days', () => {
    expect(formatExpiresIn(new Date(now + 6 * HOUR).toISOString(), now)).toBe('in 6h')
  })

  it('shows days from two days out', () => {
    expect(formatExpiresIn(new Date(now + 72 * HOUR).toISOString(), now)).toBe('in 3d')
  })

  it('reads "expired" for a past or unparseable instant', () => {
    expect(formatExpiresIn(new Date(now - HOUR).toISOString(), now)).toBe('expired')
    expect(formatExpiresIn('not-a-date', now)).toBe('expired')
  })
})
