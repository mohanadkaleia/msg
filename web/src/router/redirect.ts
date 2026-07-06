// router/redirect.ts — post-auth redirect guard (ENG-78, security round 1).
//
// A `?redirect=` query param is attacker-influenceable, so it must never be fed
// verbatim into router.push(): a protocol-relative (`//evil.com`) or absolute
// (`https://evil.com`) value would be an open-redirect-shaped navigation off the
// app. Defense-in-depth: honor a redirect ONLY when it is a same-app path — a
// single leading slash and not a scheme/authority — else fall back to the
// default landing route.

/** Return `value` iff it is a same-app absolute path, else `fallback` ('/'). */
export function safeRedirectPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string') return fallback
  if (!value.startsWith('/')) return fallback // relative or scheme-bearing → reject
  if (value.startsWith('//')) return fallback // protocol-relative → reject
  return value
}
