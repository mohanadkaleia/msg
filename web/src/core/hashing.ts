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

/** Lowercase-hex-encode a raw digest — the shared encoder for both hash forms. */
function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

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
  return `${HASH_ALGORITHM}:${toHex(digest)}`
}

/**
 * SHA-256 of raw bytes as a BARE 64-char lowercase hex string (ENG-119) — the
 * `^[0-9a-f]{64}$` content-hash form the server recomputes and the content-
 * addressed BlobStore keys on (ENG-115). DISTINCT from {@link hashEvent}'s
 * `sha256:`-prefixed `event_hash` form: this hashes file bytes, not a JCS body,
 * and carries no algorithm prefix.
 *
 * `crypto.subtle.digest('SHA-256', …)` is ONE-SHOT — WebCrypto has no streaming
 * digest — so the whole buffer is resident while it hashes. For a file upload the
 * caller passes `await file.arrayBuffer()`; a ~50 MB buffer resident is acceptable
 * (the server enforces the real size cap independently, so the client need not).
 */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Wrapping an ArrayBuffer in a Uint8Array is a VIEW, not a copy — so the 50 MB
  // file buffer is not doubled. The `BufferSource` assertion sidesteps the purely
  // theoretical SharedArrayBuffer arm of the lib type (a real file buffer is never
  // shared), matching the discipline in `hashEvent` above.
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
  const digest = await crypto.subtle.digest('SHA-256', view as BufferSource)
  return toHex(digest)
}
