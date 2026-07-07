/**
 * `channel.*` / `dm.*` workspace-meta payload schemas — the browser port of
 * `server/msgd/core/payloads/meta.py` (TDD §2.2).
 *
 * The web client AUTHORS these in M3 (ENG-104): create/rename/archive a channel,
 * add/remove members, and open a DM. Id fields are *format-validated only* (prefix
 * + ULID validity); referential existence (does the user/stream exist?) is a
 * server concern (§3.2), never enforced here. The builders MUST agree byte-for-byte
 * with the Python models on the shared body shape — the frozen cross-language
 * vectors for these meta types are deferred to ENG-110.
 */

import { IdKind, isValidTypedId } from '../ids'

function requireStreamId(streamId: string): string {
  if (!isValidTypedId(streamId, IdKind.STREAM)) {
    throw new Error(`not a valid s_ id: ${streamId}`)
  }
  return streamId
}

function requireUserId(userId: string): string {
  if (!isValidTypedId(userId, IdKind.USER)) {
    throw new Error(`not a valid u_ id: ${userId}`)
  }
  return userId
}

/** Payload for `channel.created` v1 (§2.2). */
export type ChannelCreatedV1 = {
  channel_stream_id: string
  name: string
  visibility: 'public' | 'private'
}

/** Payload for `channel.renamed` v1 (§2.2). */
export type ChannelRenamedV1 = { channel_stream_id: string; name: string }

/** Payload for `channel.archived` v1 (§2.2). */
export type ChannelArchivedV1 = { channel_stream_id: string }

/** Payload for `channel.member_added` / `channel.member_removed` v1 (§2.2). */
export type ChannelMemberV1 = { channel_stream_id: string; user_id: string }

/** Payload for `dm.created` v1 (§2.2). */
export type DmCreatedV1 = { dm_stream_id: string; member_user_ids: string[] }

/** Format-validate a `channel.created` v1 payload. */
export function buildChannelCreatedPayload(options: {
  channel_stream_id: string
  name: string
  visibility: 'public' | 'private'
}): ChannelCreatedV1 {
  if (options.visibility !== 'public' && options.visibility !== 'private') {
    throw new Error(`visibility must be 'public' or 'private': ${String(options.visibility)}`)
  }
  return {
    channel_stream_id: requireStreamId(options.channel_stream_id),
    name: options.name,
    visibility: options.visibility,
  }
}

/** Format-validate a `channel.renamed` v1 payload. */
export function buildChannelRenamedPayload(options: {
  channel_stream_id: string
  name: string
}): ChannelRenamedV1 {
  return { channel_stream_id: requireStreamId(options.channel_stream_id), name: options.name }
}

/** Format-validate a `channel.archived` v1 payload. */
export function buildChannelArchivedPayload(options: {
  channel_stream_id: string
}): ChannelArchivedV1 {
  return { channel_stream_id: requireStreamId(options.channel_stream_id) }
}

/** Format-validate a `channel.member_added`/`channel.member_removed` v1 payload. */
export function buildChannelMemberPayload(options: {
  channel_stream_id: string
  user_id: string
}): ChannelMemberV1 {
  return {
    channel_stream_id: requireStreamId(options.channel_stream_id),
    user_id: requireUserId(options.user_id),
  }
}

/**
 * Format-validate a `dm.created` v1 payload. `member_user_ids` must be a non-empty
 * list of valid user ids; the server additionally enforces the author is one of
 * them and the id set is fresh (genesis collision).
 */
export function buildDmCreatedPayload(options: {
  dm_stream_id: string
  member_user_ids: string[]
}): DmCreatedV1 {
  if (options.member_user_ids.length === 0) {
    throw new Error('dm.created member_user_ids must be non-empty')
  }
  return {
    dm_stream_id: requireStreamId(options.dm_stream_id),
    member_user_ids: options.member_user_ids.map(requireUserId),
  }
}
