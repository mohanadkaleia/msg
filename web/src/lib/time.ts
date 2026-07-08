// lib/time.ts — message time helpers for day dividers + timestamps (ENG-82).
//
// The `messages` projection deliberately carries NO wall-clock column (it is a
// deterministic, byte-stable dump — ENG-80), so we recover a message's creation
// time from its id: every `message_id` is a typed ULID (`m_<26-char ULID>`) whose
// first 10 Crockford-base32 chars are the 48-bit millisecond mint timestamp. That
// is the client-created time — exactly what a day divider needs — with ZERO change
// to the locked projection seam. Pending rows fall back to `created_seq` (their
// ms-epoch sentinel) so a just-composed message still lands under today's divider.

import type { MessageRow } from '../worker'

/** Crockford base32 alphabet (excludes I, L, O, U) — matches core/ids.ts. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIMESTAMP_CHARS = 10

/**
 * Decode the 48-bit ms timestamp from a 26-char ULID (or a typed id like
 * `m_...`). Returns `null` if the string is too short / has a non-base32 char in
 * the timestamp window (defensive — never throws on other users' data).
 */
export function decodeUlidTime(id: string): number | null {
  // Strip a `x_` type prefix if present (message ids are `m_<ULID>`).
  const ulid = id.length > 2 && id[1] === '_' ? id.slice(2) : id
  if (ulid.length < TIMESTAMP_CHARS) return null
  let ms = 0
  for (let i = 0; i < TIMESTAMP_CHARS; i++) {
    const ch = ulid[i]
    if (ch === undefined) return null
    const v = CROCKFORD.indexOf(ch.toUpperCase())
    if (v < 0) return null
    ms = ms * 32 + v
  }
  return ms
}

/**
 * The creation time (ms epoch) for a projected message: decoded from its ULID
 * `message_id`, or — for an optimistic pending/failed row whose id may not decode
 * — its `created_seq` ms-epoch sentinel. Always returns a finite number.
 */
export function messageTimestamp(message: Pick<MessageRow, 'message_id' | 'created_seq'>): number {
  const fromId = decodeUlidTime(message.message_id)
  if (fromId !== null && fromId > 0) return fromId
  // Pending sentinel: created_seq is a Date.now() ms epoch. Settled rows use a
  // small server_sequence which is not a time — but those always decode from the
  // ULID above, so this fallback only ever runs for optimistic rows.
  return message.created_seq
}

/** Stable local-calendar-day key (`YYYY-MM-DD`) for grouping into dividers. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Human day-divider label: "Today" / "Yesterday" / "Mon D, YYYY". */
export function formatDayDivider(ms: number, now: number = Date.now()): string {
  const key = dayKey(ms)
  if (key === dayKey(now)) return 'Today'
  if (key === dayKey(now - 24 * 60 * 60 * 1000)) return 'Yesterday'
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Short clock time for a message row, e.g. "9:41 AM". */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * Relative activity stamp for a triage row (ENG-136 Inbox): today shows the
 * clock time ("10:32 AM"), yesterday shows "Yesterday", anything older shows a
 * short date ("Jun 3").
 */
export function formatActivityTime(ms: number, now: number = Date.now()): string {
  const key = dayKey(ms)
  if (key === dayKey(now)) return formatTime(ms)
  if (key === dayKey(now - 24 * 60 * 60 * 1000)) return 'Yesterday'
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
