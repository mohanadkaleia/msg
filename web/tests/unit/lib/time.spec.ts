import { describe, expect, it } from 'vitest'

import { newMessageId } from '../../../src/core'
import { decodeUlidTime, formatDayDivider, messageTimestamp } from '../../../src/lib/time'

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
