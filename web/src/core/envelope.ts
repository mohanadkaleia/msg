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
import {
  buildChannelArchivedPayload,
  buildChannelCreatedPayload,
  buildChannelMemberPayload,
  buildChannelRenamedPayload,
  buildDmCreatedPayload,
} from './payloads/meta'
import {
  buildMessageCreatedPayload,
  buildMessageDeletedPayload,
  buildMessageEditedPayload,
} from './payloads/message'
import { buildReactionAddedPayload, buildReactionRemovedPayload } from './payloads/reaction'

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
 * Shared envelope options for the M3 client-emitted event bodies (ENG-100):
 * reactions, edits, deletes. These carry a payload that REFERENCES an existing
 * `message_id` (no new message id is minted), so unlike {@link BuildMessageCreatedBodyOptions}
 * there is no `message_id`/`format`/`mentions` minting here.
 */
interface BuildRefBodyOptions {
  workspace_id: string
  stream_id: string
  author_user_id: string
  author_device_id: string
  client_created_at: string
  event_id?: string
}

/** Assemble a §2.1 {@link Body} for a client-emitted, message-referencing event. */
function buildRefBody(type: string, payload: JSONValue, options: BuildRefBodyOptions): Body {
  return {
    event_id: options.event_id ?? newEventId(),
    workspace_id: options.workspace_id,
    stream_id: options.stream_id,
    type,
    type_version: 1,
    author_user_id: options.author_user_id,
    author_device_id: options.author_device_id,
    client_created_at: options.client_created_at,
    payload,
  }
}

/**
 * Mint and assemble a `reaction.added` v1 {@link Body} (ENG-100). The reactor is
 * the envelope `author_user_id` (the server keys the set on it, not the payload);
 * `emoji` is validated to the byte-bounded domain and carried opaque.
 *
 * @throws {Error} on a malformed `message_id` or an out-of-domain `emoji`.
 */
export function buildReactionAddedBody(
  options: BuildRefBodyOptions & { message_id: string; emoji: string },
): Body {
  const payload = buildReactionAddedPayload({
    message_id: options.message_id,
    emoji: options.emoji,
  })
  return buildRefBody('reaction.added', payload, options)
}

/**
 * Mint and assemble a `reaction.removed` v1 {@link Body} (ENG-100).
 *
 * @throws {Error} on a malformed `message_id` or an out-of-domain `emoji`.
 */
export function buildReactionRemovedBody(
  options: BuildRefBodyOptions & { message_id: string; emoji: string },
): Body {
  const payload = buildReactionRemovedPayload({
    message_id: options.message_id,
    emoji: options.emoji,
  })
  return buildRefBody('reaction.removed', payload, options)
}

/**
 * Mint and assemble a `message.edited` v1 {@link Body} (ENG-100). Carries the
 * replacement `text` + `format` for an existing `message_id`.
 *
 * @throws {Error} on a malformed `message_id`.
 */
export function buildMessageEditedBody(
  options: BuildRefBodyOptions & {
    message_id: string
    text: string
    format?: 'markdown' | 'plain'
  },
): Body {
  const payload = buildMessageEditedPayload({
    message_id: options.message_id,
    text: options.text,
    ...(options.format !== undefined ? { format: options.format } : {}),
  })
  return buildRefBody('message.edited', payload, options)
}

/**
 * Mint and assemble a `message.deleted` v1 {@link Body} (ENG-100) — a tombstone
 * naming an existing `message_id`.
 *
 * @throws {Error} on a malformed `message_id`.
 */
export function buildMessageDeletedBody(
  options: BuildRefBodyOptions & { message_id: string },
): Body {
  const payload = buildMessageDeletedPayload({ message_id: options.message_id })
  return buildRefBody('message.deleted', payload, options)
}

/**
 * Shared envelope options for the M3 client-emitted workspace-meta event bodies
 * (ENG-104): channel create/rename/archive, member add/remove, DM create. Unlike
 * the message ops these carry NO `message_id`; `stream_id` is the §2.2 HOME (the
 * caller's choice: workspace-meta for a public-channel event, the channel's own
 * stream for a private one, the DM's own stream for `dm.created`).
 */
export interface BuildMetaBodyOptions {
  workspace_id: string
  stream_id: string
  author_user_id: string
  author_device_id: string
  client_created_at: string
  event_id?: string
}

/** Assemble a §2.1 {@link Body} for a client-emitted workspace-meta event. */
function buildMetaBody(type: string, payload: JSONValue, options: BuildMetaBodyOptions): Body {
  return {
    event_id: options.event_id ?? newEventId(),
    workspace_id: options.workspace_id,
    stream_id: options.stream_id,
    type,
    type_version: 1,
    author_user_id: options.author_user_id,
    author_device_id: options.author_device_id,
    client_created_at: options.client_created_at,
    payload,
  }
}

/**
 * Mint and assemble a `channel.created` v1 {@link Body} (ENG-104). §2.2 homing is
 * the caller's choice via `stream_id` (workspace-meta for public, the channel's
 * own stream for private); `channel_stream_id` is the channel's own stream id the
 * server reducer creates.
 *
 * @throws {Error} on a malformed `channel_stream_id` or bad `visibility`.
 */
export function buildChannelCreatedBody(
  options: BuildMetaBodyOptions & {
    channel_stream_id: string
    name: string
    visibility: 'public' | 'private'
  },
): Body {
  const payload = buildChannelCreatedPayload({
    channel_stream_id: options.channel_stream_id,
    name: options.name,
    visibility: options.visibility,
  })
  return buildMetaBody('channel.created', payload, options)
}

/**
 * Mint and assemble a `channel.renamed` v1 {@link Body} (ENG-104).
 *
 * @throws {Error} on a malformed `channel_stream_id`.
 */
export function buildChannelRenamedBody(
  options: BuildMetaBodyOptions & { channel_stream_id: string; name: string },
): Body {
  const payload = buildChannelRenamedPayload({
    channel_stream_id: options.channel_stream_id,
    name: options.name,
  })
  return buildMetaBody('channel.renamed', payload, options)
}

/**
 * Mint and assemble a `channel.archived` v1 {@link Body} (ENG-104).
 *
 * @throws {Error} on a malformed `channel_stream_id`.
 */
export function buildChannelArchivedBody(
  options: BuildMetaBodyOptions & { channel_stream_id: string },
): Body {
  const payload = buildChannelArchivedPayload({ channel_stream_id: options.channel_stream_id })
  return buildMetaBody('channel.archived', payload, options)
}

/**
 * Mint and assemble a `channel.member_added` v1 {@link Body} (ENG-104).
 *
 * @throws {Error} on a malformed `channel_stream_id` or `user_id`.
 */
export function buildChannelMemberAddedBody(
  options: BuildMetaBodyOptions & { channel_stream_id: string; user_id: string },
): Body {
  const payload = buildChannelMemberPayload({
    channel_stream_id: options.channel_stream_id,
    user_id: options.user_id,
  })
  return buildMetaBody('channel.member_added', payload, options)
}

/**
 * Mint and assemble a `channel.member_removed` v1 {@link Body} (ENG-104).
 *
 * @throws {Error} on a malformed `channel_stream_id` or `user_id`.
 */
export function buildChannelMemberRemovedBody(
  options: BuildMetaBodyOptions & { channel_stream_id: string; user_id: string },
): Body {
  const payload = buildChannelMemberPayload({
    channel_stream_id: options.channel_stream_id,
    user_id: options.user_id,
  })
  return buildMetaBody('channel.member_removed', payload, options)
}

/**
 * Mint and assemble a `dm.created` v1 {@link Body} (ENG-104). A DM is a private
 * stream whose members are the participant set; the genesis event is SELF-HOMED in
 * the DM's own stream (`stream_id === dm_stream_id`). The server enforces the
 * author is one of `member_user_ids`.
 *
 * @throws {Error} on a malformed `dm_stream_id` / participant, or an empty set.
 */
export function buildDmCreatedBody(
  options: BuildMetaBodyOptions & { dm_stream_id: string; member_user_ids: string[] },
): Body {
  const payload = buildDmCreatedPayload({
    dm_stream_id: options.dm_stream_id,
    member_user_ids: options.member_user_ids,
  })
  return buildMetaBody('dm.created', payload, options)
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
