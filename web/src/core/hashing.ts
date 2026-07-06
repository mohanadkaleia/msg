/**
 * `event_hash` = SHA-256 over the RFC 8785 (JCS) canonicalization of `body`.
 *
 * The browser mirror of `server/msgd/core/hashing.py`. Per TDD §2.1 and D1 the
 * hash covers the event `body` only — `server` metadata and `signature` are
 * structurally outside `body` and cannot enter the canonicalization.
 *
 * Async, unlike Python's synchronous `hash_event`: WebCrypto's `crypto.subtle`
 * digest is Promise-based. The §5.3 optimistic send path already `await`s
 * envelope + hash construction in the SharedWorker before enqueuing the outbox,
 * so an async hash fits with no architectural change.
 *
 * Hash the RAW parsed body, never a re-serialized model (see `hashing.py`): the
 * caller passes the value straight out of {@link parseJcsJson}. {@link JCSError}
 * for out-of-domain input is propagated, not swallowed — the caller decides
 * reject vs. HTTP 400.
 *
 * `verifyHash` is intentionally NOT provided here: the web client has no
 * upload/verify path yet (ENG-77+). Defer it to the receive-path ticket to
 * avoid an unused, mis-usable surface; verify there by re-hashing the raw
 * received body, never a re-serialized model.
 */

import { canonicalize, type JSONValue } from './jcs'

/** The one hash algorithm msg uses for `event_hash` (D1); travels in the prefix. */
export const HASH_ALGORITHM = 'sha256'

/**
 * Return `event_hash` = `"sha256:<hex>"` over the JCS bytes of `body`.
 *
 * @throws {JCSError} if `body` (or a nested value) is out of the JCS domain.
 */
export async function hashEvent(body: JSONValue): Promise<string> {
  // Copy into a fresh Uint8Array so the backing store is a definite ArrayBuffer
  // (not the ArrayBufferLike TextEncoder yields, which SubtleCrypto's BufferSource
  // type rejects because it could in principle be a SharedArrayBuffer).
  const bytes = new Uint8Array(canonicalize(body))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${HASH_ALGORITHM}:${hex}`
}
