/**
 * Event envelope construction for the browser send path (TDD §2.1, §5.3) — the
 * TS mirror of `build_message_created_body` (`payloads/__init__.py`).
 *
 * An event's hashed `body` has the §2.1 shape; `event_hash` = SHA-256 over the
 * RFC 8785 (JCS) canonicalization of `body` only. {@link finalizeEnvelope}
 * produces the §3.2 wire form `{ body, event_hash }` the outbox enqueues.
 *
 * Only `message.created` is built here — it is the only event type the web
 * client *emits* in the M2 send path (§5.3). Other payload types are read-side
 * projection concerns for later tickets.
 *
 * Object insertion order is irrelevant to the hash (canonicalize sorts keys),
 * so the builders need not match Python field order.
 */

import { hashEvent } from './hashing'
import { newEventId } from './ids'
import type { JSONValue } from './jcs'
import { buildMessageCreatedPayload } from './payloads/message'

/** The hashed client body (§2.1). `event_hash` is SHA-256 of JCS(this). */
export type Body = {
  event_id: string
  workspace_id: string
  stream_id: string
  type: string
  type_version: number
  author_user_id: string
  author_device_id: string
  client_created_at: string
  payload: JSONValue
}

/** The §3.2 upload wire form: hashed body + its `event_hash`. */
export interface Envelope {
  body: Body
  event_hash: string
}

/** Options for {@link buildMessageCreatedBody}; mirrors `build_message_created_body`. */
export interface BuildMessageCreatedBodyOptions {
  workspace_id: string
  stream_id: string
  author_user_id: string
  author_device_id: string
  client_created_at: string
  text: string
  format?: 'markdown' | 'plain'
  thread_root_id?: string | null
  file_ids?: string[]
  mentions?: string[]
  event_id?: string
  message_id?: string
}

/**
 * Mint (when absent) and assemble a `message.created` v1 {@link Body}.
 *
 * Mints `event_id` and `message_id` when not supplied, format-validates the
 * payload id fields, and returns the §2.1 body shape. Envelope finalization
 * (attaching `event_hash`) is {@link finalizeEnvelope}.
 *
 * @throws {Error} on a malformed payload id.
 */
export function buildMessageCreatedBody(options: BuildMessageCreatedBodyOptions): Body {
  const payload = buildMessageCreatedPayload({
    text: options.text,
    ...(options.format !== undefined ? { format: options.format } : {}),
    ...(options.thread_root_id !== undefined ? { thread_root_id: options.thread_root_id } : {}),
    ...(options.file_ids !== undefined ? { file_ids: options.file_ids } : {}),
    ...(options.mentions !== undefined ? { mentions: options.mentions } : {}),
    ...(options.message_id !== undefined ? { message_id: options.message_id } : {}),
  })

  return {
    event_id: options.event_id ?? newEventId(),
    workspace_id: options.workspace_id,
    stream_id: options.stream_id,
    type: 'message.created',
    type_version: 1,
    author_user_id: options.author_user_id,
    author_device_id: options.author_device_id,
    client_created_at: options.client_created_at,
    payload,
  }
}

/**
 * Finalize a body into the §3.2 wire form `{ body, event_hash }` by hashing it.
 *
 * @throws {JCSError} if `body` is out of the JCS domain.
 */
export async function finalizeEnvelope(body: Body): Promise<Envelope> {
  const event_hash = await hashEvent(body)
  return { body, event_hash }
}
