// lib/status.ts — render-time custom-status resolution (ENG-164).
//
// LAZY EXPIRY, client half: the directory fold and `me.get` carry the RAW
// `status_expires_at` (the fold never consults the clock — rebuild ≡
// incremental stays deterministic; the server applies the same rule on GET).
// Whether a status is currently VISIBLE is therefore decided here, at render
// time: an expired status is treated as absent, exactly as if it were cleared.
// Pure + injectable `now` so components stay trivially testable.

/** The renderable half of a custom status (emoji and/or text — at least one). */
export interface ActiveStatus {
  emoji?: string
  text?: string
}

/** The raw status fields as they appear on a directory record (`undefined`)
 * or the `me.get` profile (`null`) — both "unset" spellings are accepted. */
export interface StatusFields {
  status_emoji?: string | null
  status_text?: string | null
  status_expires_at?: string | null
}

/**
 * Resolve the status to RENDER for a user: `null` when there is nothing to
 * show — no emoji AND no text, or the status has lazily expired
 * (`status_expires_at <= now`). An unparsable expiry is treated as expired
 * (fail-closed: garbage never pins a status forever).
 */
export function activeStatus(
  user: StatusFields | null | undefined,
  now: Date = new Date(),
): ActiveStatus | null {
  if (user == null) return null
  const emoji = user.status_emoji ?? undefined
  const text = user.status_text ?? undefined
  if (emoji === undefined && text === undefined) return null
  const expiresAt = user.status_expires_at
  if (expiresAt != null) {
    const expiry = Date.parse(expiresAt)
    if (Number.isNaN(expiry) || expiry <= now.getTime()) return null
  }
  const status: ActiveStatus = {}
  if (emoji !== undefined) status.emoji = emoji
  if (text !== undefined) status.text = text
  return status
}
