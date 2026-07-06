/**
 * Typed-ULID identifiers for the msg protocol — the browser port of
 * `server/msgd/core/ids.py`.
 *
 * Every entity id is a ULID (Crockford base32, 26 chars, lexicographically
 * sortable) carrying a short type prefix::
 *
 *     w_  workspace     u_  user       s_  stream
 *     m_  message       f_  file       d_  device
 *
 * The one exception is `event_id`, which per TDD §2.1 is a *bare* ULID with no
 * prefix. Ids are client-mintable (offline-safe): the ULID timestamp +
 * randomness give global sortability without a server round trip.
 *
 * Monotonic minting
 * -----------------
 * Downstream tickets rely on ULID sort order (there is no `server_sequence`
 * client-side). Within a millisecond {@link newUlid} increments the previous
 * randomness so successive ids are *strictly* increasing lexicographically and
 * never collide; on 80-bit overflow it carries into the timestamp. Randomness
 * comes from `crypto.getRandomValues` (CSPRNG — the counterpart to `ids.py`'s
 * `secrets`), never `Math.random`.
 *
 * Divergence from `ids.py`: no mutex. A SharedWorker — and any single JS realm —
 * is single-threaded, so `ids.py`'s `threading.Lock` has no counterpart here.
 * The base32 encode is done by hand (~15 lines) rather than pulling `ulidx`,
 * which lacks the typed prefixes + validation we need and the monotonic parity
 * with `ids.py`.
 */

/** Crockford base32 alphabet (excludes I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_LENGTH = 26
const TIMESTAMP_CHARS = 10 // 48-bit ms timestamp
const RANDOMNESS_CHARS = 16 // 80-bit randomness
const RANDOMNESS_BYTES = 10
const RANDOMNESS_MAX = (1n << 80n) - 1n

/** The entity kinds that carry a type-prefixed ULID. Mirrors `ids.py::IdKind`. */
export const IdKind = {
  WORKSPACE: 'w_',
  USER: 'u_',
  STREAM: 's_',
  MESSAGE: 'm_',
  FILE: 'f_',
  DEVICE: 'd_',
} as const

/** A known entity prefix, e.g. `"m_"`. */
export type IdKind = (typeof IdKind)[keyof typeof IdKind]

/** The set of known entity prefixes. Mirrors `ids.py::ENTITY_PREFIXES`. */
export const ENTITY_PREFIXES: ReadonlySet<IdKind> = new Set(Object.values(IdKind))

/** A typed id split into its `prefix` and bare `ulid` parts. */
export interface ParsedId {
  prefix: string
  ulid: string
}

// --- monotonic minting -------------------------------------------------------

let lastMs = -1
let lastRandomness = 0n

/** 80 bits of CSPRNG randomness as a bigint. */
function randomness80(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOMNESS_BYTES))
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  return value
}

/** Encode `value` as `length` big-endian Crockford base32 chars. */
function encodeBase32(value: bigint, length: number): string {
  let out = ''
  let remaining = value
  for (let i = 0; i < length; i++) {
    out = CROCKFORD.charAt(Number(remaining & 31n)) + out
    remaining >>= 5n
  }
  return out
}

/**
 * Return a fresh 26-char ULID, strictly increasing across calls.
 *
 * Monotonic: two ids minted in the same millisecond differ by an incremented
 * randomness, so `newUlid() < newUlid()` always holds lexicographically.
 */
export function newUlid(): string {
  const now = Date.now()
  if (now > lastMs) {
    lastMs = now
    lastRandomness = randomness80()
  } else {
    // Same millisecond (or a backwards clock): keep the timestamp, bump the
    // randomness so the id still strictly increases.
    lastRandomness += 1n
    if (lastRandomness > RANDOMNESS_MAX) {
      // Randomness overflow within a millisecond (astronomically unlikely):
      // carry into the timestamp to stay monotonic.
      lastMs += 1
      lastRandomness = randomness80()
    }
  }
  return (
    encodeBase32(BigInt(lastMs), TIMESTAMP_CHARS) + encodeBase32(lastRandomness, RANDOMNESS_CHARS)
  )
}

/** Return a bare ULID for use as an `event_id` (no prefix, per §2.1). */
export function newEventId(): string {
  return newUlid()
}

/** Return `prefix + <ULID>` for a known entity prefix (e.g. `"m_"`). */
export function newTypedId(prefix: IdKind): string {
  if (!ENTITY_PREFIXES.has(prefix)) {
    throw new Error(`unknown entity prefix: ${prefix}`)
  }
  return prefix + newUlid()
}

export function newWorkspaceId(): string {
  return newTypedId(IdKind.WORKSPACE)
}

export function newUserId(): string {
  return newTypedId(IdKind.USER)
}

export function newStreamId(): string {
  return newTypedId(IdKind.STREAM)
}

export function newMessageId(): string {
  return newTypedId(IdKind.MESSAGE)
}

export function newFileId(): string {
  return newTypedId(IdKind.FILE)
}

export function newDeviceId(): string {
  return newTypedId(IdKind.DEVICE)
}

// --- parse / validate --------------------------------------------------------

/**
 * True if `value` is a syntactically valid bare ULID: 26 Crockford base32 chars
 * with a first char ≤ `'7'` (the 48-bit-timestamp overflow guard a correct ULID
 * decoder applies). Mirrors `ids.py::is_valid_ulid`.
 */
export function isValidUlid(value: string): boolean {
  if (value.length !== ULID_LENGTH) {
    return false
  }
  if (!'01234567'.includes(value.charAt(0))) {
    return false
  }
  for (const char of value) {
    if (!CROCKFORD.includes(char)) {
      return false
    }
  }
  return true
}

/** True if `value` is `prefix` followed by a valid ULID. */
export function isValidTypedId(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) {
    return false
  }
  return isValidUlid(value.slice(prefix.length))
}

/**
 * Split a typed id into `{ prefix, ulid }`. Mirrors `ids.py::parse_typed_id`.
 *
 * @throws {Error} if the prefix is not a known entity prefix (or, when given,
 *   does not equal `expectedPrefix`) or the remainder is not a valid ULID.
 */
export function parseTypedId(value: string, expectedPrefix?: string): ParsedId {
  let prefix: string
  if (expectedPrefix !== undefined) {
    if (!value.startsWith(expectedPrefix)) {
      throw new Error(`expected prefix ${expectedPrefix}, got id ${value}`)
    }
    prefix = expectedPrefix
  } else {
    const match = [...ENTITY_PREFIXES].find((p) => value.startsWith(p))
    if (match === undefined) {
      throw new Error(`id ${value} has no known entity prefix`)
    }
    prefix = match
  }

  const ulid = value.slice(prefix.length)
  if (!isValidUlid(ulid)) {
    throw new Error(`id ${value} does not contain a valid ULID`)
  }
  return { prefix, ulid }
}
