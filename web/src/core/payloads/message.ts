/**
 * `message.*` payload schemas — the browser port of
 * `server/msgd/core/payloads/message.py`.
 *
 * Id fields are *format-validated only*: prefix + ULID validity are checked to
 * catch malformed references early. Referential existence (does the
 * message/user/file exist?) is a server-side concern (§3.2), out of scope here.
 */

import { IdKind, isValidTypedId, newMessageId } from '../ids'

/** Payload for `message.created` v1 (§2.2). */
export type MessageCreatedV1 = {
  message_id: string
  text: string
  format: 'markdown' | 'plain'
  thread_root_id: string | null
  file_ids: string[]
  mentions: string[]
}

/** Options for {@link buildMessageCreatedPayload}; defaults mirror the Python model. */
export interface BuildMessageCreatedPayloadOptions {
  text: string
  format?: 'markdown' | 'plain'
  thread_root_id?: string | null
  file_ids?: string[]
  mentions?: string[]
  message_id?: string
}

/**
 * Mint (when absent) and format-validate a `message.created` v1 payload.
 *
 * Mirrors `MessageCreatedV1`'s field validators: `message_id` and any
 * `thread_root_id` are `m_` ids, `file_ids` are `f_` ids, `mentions` are `u_`
 * ids. Defaults: `format` `"markdown"`, `thread_root_id` `null`, `file_ids` `[]`,
 * `mentions` `[]`.
 *
 * @throws {Error} on a malformed id.
 */
export function buildMessageCreatedPayload(
  options: BuildMessageCreatedPayloadOptions,
): MessageCreatedV1 {
  const messageId = options.message_id ?? newMessageId()
  if (!isValidTypedId(messageId, IdKind.MESSAGE)) {
    throw new Error(`message_id is not a valid m_ id: ${messageId}`)
  }

  const threadRootId = options.thread_root_id ?? null
  if (threadRootId !== null && !isValidTypedId(threadRootId, IdKind.MESSAGE)) {
    throw new Error(`thread_root_id is not a valid m_ id: ${threadRootId}`)
  }

  const fileIds = options.file_ids ?? []
  for (const fileId of fileIds) {
    if (!isValidTypedId(fileId, IdKind.FILE)) {
      throw new Error(`file_ids contains an invalid f_ id: ${fileId}`)
    }
  }

  const mentions = options.mentions ?? []
  for (const userId of mentions) {
    if (!isValidTypedId(userId, IdKind.USER)) {
      throw new Error(`mentions contains an invalid u_ id: ${userId}`)
    }
  }

  return {
    message_id: messageId,
    text: options.text,
    format: options.format ?? 'markdown',
    thread_root_id: threadRootId,
    file_ids: fileIds,
    mentions: mentions,
  }
}

/**
 * Payload for `message.edited` v1 (§2.2 / §2.4).
 *
 * The new body of an existing message: the target `message_id` plus the
 * replacement `text` and `format`. `text`/`format` reuse the `message.created`
 * rules exactly — `format` is the same locked `'markdown' | 'plain'` domain.
 */
export type MessageEditedV1 = {
  message_id: string
  text: string
  format: 'markdown' | 'plain'
}

/** Options for {@link buildMessageEditedPayload}; defaults mirror the Python model. */
export interface BuildMessageEditedPayloadOptions {
  message_id: string
  text: string
  format?: 'markdown' | 'plain'
}

/**
 * Format-validate a `message.edited` v1 payload.
 *
 * @throws {Error} on a malformed `message_id`.
 */
export function buildMessageEditedPayload(
  options: BuildMessageEditedPayloadOptions,
): MessageEditedV1 {
  if (!isValidTypedId(options.message_id, IdKind.MESSAGE)) {
    throw new Error(`message_id is not a valid m_ id: ${options.message_id}`)
  }
  return {
    message_id: options.message_id,
    text: options.text,
    format: options.format ?? 'markdown',
  }
}

/**
 * Payload for `message.deleted` v1 (§2.2 / §2.4).
 *
 * A tombstone naming the target `message_id`; the projection hides the message.
 */
export type MessageDeletedV1 = {
  message_id: string
}

/** Options for {@link buildMessageDeletedPayload}. */
export interface BuildMessageDeletedPayloadOptions {
  message_id: string
}

/**
 * Format-validate a `message.deleted` v1 payload.
 *
 * @throws {Error} on a malformed `message_id`.
 */
export function buildMessageDeletedPayload(
  options: BuildMessageDeletedPayloadOptions,
): MessageDeletedV1 {
  if (!isValidTypedId(options.message_id, IdKind.MESSAGE)) {
    throw new Error(`message_id is not a valid m_ id: ${options.message_id}`)
  }
  return {
    message_id: options.message_id,
  }
}
