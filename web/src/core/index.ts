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

export {
  buildMessageCreatedBody,
  buildReactionAddedBody,
  buildReactionRemovedBody,
  buildMessageEditedBody,
  buildMessageDeletedBody,
  buildChannelCreatedBody,
  buildChannelRenamedBody,
  buildChannelArchivedBody,
  buildChannelMemberAddedBody,
  buildChannelMemberRemovedBody,
  buildDmCreatedBody,
  finalizeEnvelope,
} from './envelope'
export type {
  Body,
  Envelope,
  BuildMessageCreatedBodyOptions,
  BuildMetaBodyOptions,
} from './envelope'

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

export {
  MAX_FILE_NAME_BYTES,
  MAX_MIME_TYPE_BYTES,
  MAX_FILE_SIZE_BYTES,
  buildFileUploadedPayload,
} from './payloads/file'
export type { FileUploadedV1, BuildFileUploadedPayloadOptions } from './payloads/file'

export {
  buildChannelCreatedPayload,
  buildChannelRenamedPayload,
  buildChannelArchivedPayload,
  buildChannelMemberPayload,
  buildDmCreatedPayload,
} from './payloads/meta'
export type {
  ChannelCreatedV1,
  ChannelRenamedV1,
  ChannelArchivedV1,
  ChannelMemberV1,
  DmCreatedV1,
} from './payloads/meta'
