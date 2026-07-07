/**
 * `reaction.*` payload schemas — the browser port of
 * `server/msgd/core/payloads/reaction.py`.
 *
 * Id fields are *format-validated only*: prefix + ULID validity are checked to
 * catch malformed references early. Referential existence (does the target
 * message exist?) is a server-side concern (§3.2), out of scope here.
 *
 * Emoji domain (LOCKED DECISION, §2.2-style — changing it ⇒ `type_version`
 * bump): `emoji` is a bounded Unicode string, non-empty and at most
 * {@link MAX_EMOJI_BYTES} (64) bytes when UTF-8 encoded. There is deliberately
 * no emoji whitelist — the byte bound is the only gate. Mirrors the Python
 * `_require_emoji` validator so both languages accept/reject the same strings.
 *
 * Idempotency `(message_id, author_user_id, emoji)` (§2.4) is a server
 * projection concern (ENG-97), not enforced here: `author_user_id` lives on the
 * envelope, and these builders validate a single event's shape only.
 */

import { IdKind, isValidTypedId } from '../ids'

/** Upper bound on the UTF-8 byte length of a reaction `emoji` (locked at v1). */
export const MAX_EMOJI_BYTES = 64

const utf8 = new TextEncoder()

/** Throw unless `emoji` is a non-empty string of at most `MAX_EMOJI_BYTES` UTF-8 bytes. */
function requireEmoji(emoji: string): string {
  if (emoji === '') {
    throw new Error('emoji must be non-empty')
  }
  const n = utf8.encode(emoji).length
  if (n > MAX_EMOJI_BYTES) {
    throw new Error(`emoji is ${n} bytes UTF-8, exceeds the ${MAX_EMOJI_BYTES}-byte limit`)
  }
  return emoji
}

function requireMessageId(messageId: string): string {
  if (!isValidTypedId(messageId, IdKind.MESSAGE)) {
    throw new Error(`message_id is not a valid m_ id: ${messageId}`)
  }
  return messageId
}

/** Payload for `reaction.added` v1 (§2.2). */
export type ReactionAddedV1 = {
  message_id: string
  emoji: string
}

/** Payload for `reaction.removed` v1 (§2.2). */
export type ReactionRemovedV1 = {
  message_id: string
  emoji: string
}

/** Options for the reaction payload builders; mirrors the Python model fields. */
export interface BuildReactionPayloadOptions {
  message_id: string
  emoji: string
}

/**
 * Format-validate a `reaction.added` v1 payload.
 *
 * @throws {Error} on a malformed `message_id` or an out-of-domain `emoji`.
 */
export function buildReactionAddedPayload(options: BuildReactionPayloadOptions): ReactionAddedV1 {
  return {
    message_id: requireMessageId(options.message_id),
    emoji: requireEmoji(options.emoji),
  }
}

/**
 * Format-validate a `reaction.removed` v1 payload.
 *
 * @throws {Error} on a malformed `message_id` or an out-of-domain `emoji`.
 */
export function buildReactionRemovedPayload(
  options: BuildReactionPayloadOptions,
): ReactionRemovedV1 {
  return {
    message_id: requireMessageId(options.message_id),
    emoji: requireEmoji(options.emoji),
  }
}
