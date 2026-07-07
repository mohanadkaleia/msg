/**
 * `@/core` — the browser send/hash spine (ENG-76).
 *
 * The TypeScript port of the four Python `core/` layers the send path needs:
 * JCS canonicalization, SHA-256 hashing, typed-ULID minting, and the
 * `message.created` body builder. Must agree byte-for-byte with the Python impl
 * on the frozen vectors in `server/msgd/core/testdata/vectors.json`.
 */

export { canonicalize, parseJcsJson, JCSError, MAX_DEPTH } from './jcs'
export type { JSONValue } from './jcs'

export { hashEvent, HASH_ALGORITHM } from './hashing'

export {
  IdKind,
  ENTITY_PREFIXES,
  newUlid,
  newEventId,
  newTypedId,
  newWorkspaceId,
  newUserId,
  newStreamId,
  newMessageId,
  newFileId,
  newDeviceId,
  isValidUlid,
  isValidTypedId,
  parseTypedId,
} from './ids'
export type { ParsedId } from './ids'

export { buildMessageCreatedBody, finalizeEnvelope } from './envelope'
export type { Body, Envelope, BuildMessageCreatedBodyOptions } from './envelope'

export {
  buildMessageCreatedPayload,
  buildMessageEditedPayload,
  buildMessageDeletedPayload,
} from './payloads/message'
export type {
  MessageCreatedV1,
  BuildMessageCreatedPayloadOptions,
  MessageEditedV1,
  BuildMessageEditedPayloadOptions,
  MessageDeletedV1,
  BuildMessageDeletedPayloadOptions,
} from './payloads/message'

export {
  MAX_EMOJI_BYTES,
  buildReactionAddedPayload,
  buildReactionRemovedPayload,
} from './payloads/reaction'
export type {
  ReactionAddedV1,
  ReactionRemovedV1,
  BuildReactionPayloadOptions,
} from './payloads/reaction'
