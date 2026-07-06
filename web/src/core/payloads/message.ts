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
