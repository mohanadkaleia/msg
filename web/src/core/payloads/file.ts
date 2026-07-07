/**
 * `file.*` payload schemas — the browser port of
 * `server/msgd/core/payloads/file.py` (TDD §2.2 / M3.5 Phase-A).
 *
 * Id fields are *format-validated only*: prefix + ULID validity are checked to
 * catch malformed references early. Referential existence (does the blob exist?
 * was it actually uploaded?) is a server-side concern (ENG-116, §3.2), out of
 * scope here.
 *
 * LOCKED DECISIONS (§2.2-style — changing any ⇒ `type_version` bump), mirrored
 * exactly from the Python validators so both languages accept/reject the same
 * values:
 *
 * - `sha256` is the blob's content hash as a bare 64-char lowercase hex string
 *   (`^[0-9a-f]{64}$`) — NOT the `sha256:<hex>` prefixed form used by
 *   `event_hash`. Matches the content-addressed BlobStore key (ENG-115).
 * - `name` is a bounded, opaque filename: non-empty, at most
 *   {@link MAX_FILE_NAME_BYTES} (255) UTF-8 bytes.
 * - `mime_type` is a bounded `type/subtype` string: non-empty, at most
 *   {@link MAX_MIME_TYPE_BYTES} (255) UTF-8 bytes, exactly one `/` with
 *   non-empty halves. Deliberately not the full RFC 6838 token grammar.
 * - `size_bytes` is a non-negative integer within the JCS interop cap
 *   (`0 <= size_bytes <= 2**53 - 1`). The 50 MB business cap is a server
 *   concern (ENG-116), NOT the payload.
 */

import { IdKind, isValidTypedId } from '../ids'

/** Upper bound on the UTF-8 byte length of a `file.uploaded` `name` (locked at v1). */
export const MAX_FILE_NAME_BYTES = 255

/** Upper bound on the UTF-8 byte length of a `mime_type` (locked at v1). */
export const MAX_MIME_TYPE_BYTES = 255

/**
 * Upper bound on `size_bytes` — the JCS integer interop cap `2**53 - 1`
 * (`Number.MAX_SAFE_INTEGER`). The 50 MB business cap is server-side (ENG-116).
 */
export const MAX_FILE_SIZE_BYTES = Number.MAX_SAFE_INTEGER

const utf8 = new TextEncoder()

/** Bare 64-char lowercase hex — the content-addressed BlobStore key form (ENG-115). */
const SHA256_RE = /^[0-9a-f]{64}$/
/** Coarse `type/subtype` shape: exactly one `/` with non-empty, slash-free halves. */
const MIME_TYPE_RE = /^[^/]+\/[^/]+$/

function requireFileId(fileId: string): string {
  if (!isValidTypedId(fileId, IdKind.FILE)) {
    throw new Error(`file_id is not a valid f_ id: ${fileId}`)
  }
  return fileId
}

function requireSha256(sha256: string): string {
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`sha256 must be 64 lowercase hex chars (bare, no prefix), got ${sha256}`)
  }
  return sha256
}

function requireName(name: string): string {
  if (name === '') {
    throw new Error('name must be non-empty')
  }
  const n = utf8.encode(name).length
  if (n > MAX_FILE_NAME_BYTES) {
    throw new Error(`name is ${n} bytes UTF-8, exceeds the ${MAX_FILE_NAME_BYTES}-byte limit`)
  }
  return name
}

function requireMimeType(mimeType: string): string {
  const n = utf8.encode(mimeType).length
  if (n === 0) {
    throw new Error('mime_type must be non-empty')
  }
  if (n > MAX_MIME_TYPE_BYTES) {
    throw new Error(`mime_type is ${n} bytes UTF-8, exceeds the ${MAX_MIME_TYPE_BYTES}-byte limit`)
  }
  if (!MIME_TYPE_RE.test(mimeType)) {
    throw new Error(`mime_type is not a type/subtype string: ${mimeType}`)
  }
  return mimeType
}

function requireSizeBytes(sizeBytes: number): number {
  if (!Number.isInteger(sizeBytes)) {
    throw new Error(`size_bytes must be an integer, got ${sizeBytes}`)
  }
  if (sizeBytes < 0) {
    throw new Error(`size_bytes must be >= 0, got ${sizeBytes}`)
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new Error(`size_bytes ${sizeBytes} exceeds the interop cap ${MAX_FILE_SIZE_BYTES}`)
  }
  return sizeBytes
}

/** Payload for `file.uploaded` v1 (§2.2 / M3.5 Phase-A). */
export type FileUploadedV1 = {
  file_id: string
  sha256: string
  name: string
  mime_type: string
  size_bytes: number
}

/** Options for {@link buildFileUploadedPayload}; mirrors the Python model fields. */
export interface BuildFileUploadedPayloadOptions {
  file_id: string
  sha256: string
  name: string
  mime_type: string
  size_bytes: number
}

/**
 * Format-validate a `file.uploaded` v1 payload.
 *
 * Mirrors `FileUploadedV1`'s field validators: `file_id` is an `f_` id,
 * `sha256` is bare 64-char lowercase hex, `name`/`mime_type` are bounded, and
 * `size_bytes` is a non-negative in-cap integer.
 *
 * @throws {Error} on a malformed `file_id`, `sha256`, `name`, `mime_type`, or
 *   an out-of-range `size_bytes`.
 */
export function buildFileUploadedPayload(options: BuildFileUploadedPayloadOptions): FileUploadedV1 {
  return {
    file_id: requireFileId(options.file_id),
    sha256: requireSha256(options.sha256),
    name: requireName(options.name),
    mime_type: requireMimeType(options.mime_type),
    size_bytes: requireSizeBytes(options.size_bytes),
  }
}
