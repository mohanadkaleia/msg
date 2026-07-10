// tests/unit/worker/projfixtures.ts — synthetic EventRow builders for the
// ENG-80 projection suites. No sync engine, no browser, no server: apply /
// rebuild / dump / badges are all exercised directly on MemoryDb / fake-indexeddb.

import type { EventRow } from '../../../src/worker/types'

export interface MessageCreatedOpts {
  streamId: string
  seq: number
  messageId: string
  text?: string
  format?: 'markdown' | 'plain'
  threadRootId?: string
  authorUserId?: string
  mentions?: string[]
  fileIds?: string[]
  typeVersion?: number
}

/** A well-formed `message.created` event (v1 by default). */
export function messageCreatedEvent(opts: MessageCreatedOpts): EventRow {
  const eventId = `e_${opts.streamId}_${opts.seq}`
  const payload = {
    message_id: opts.messageId,
    text: opts.text ?? 'hello',
    format: opts.format ?? 'markdown',
    thread_root_id: opts.threadRootId ?? null,
    file_ids: opts.fileIds ?? [],
    mentions: opts.mentions ?? [],
  }
  return {
    stream_id: opts.streamId,
    server_sequence: opts.seq,
    event_id: eventId,
    type: 'message.created',
    envelope: {
      body: {
        event_id: eventId,
        workspace_id: 'w_test',
        stream_id: opts.streamId,
        type: 'message.created',
        type_version: opts.typeVersion ?? 1,
        author_user_id: opts.authorUserId ?? 'u_author',
        author_device_id: 'd_test',
        client_created_at: '2026-01-01T00:00:00.000Z',
        payload,
      },
      event_hash: `hash_${eventId}`,
      signature: `sig_${eventId}`,
      server: { server_sequence: opts.seq, server_received_at: '2026-01-01T00:00:00.000Z' },
    },
  }
}

/** An unknown event type (D9 skip) — `widget.exploded` v7. */
export function unknownTypeEvent(streamId: string, seq: number): EventRow {
  const eventId = `e_${streamId}_${seq}`
  return {
    stream_id: streamId,
    server_sequence: seq,
    event_id: eventId,
    type: 'widget.exploded',
    envelope: {
      body: {
        event_id: eventId,
        workspace_id: 'w_test',
        stream_id: streamId,
        type: 'widget.exploded',
        type_version: 7,
        author_user_id: 'u_author',
        author_device_id: 'd_test',
        client_created_at: '2026-01-01T00:00:00.000Z',
        payload: { blast_radius: 42 },
      },
      event_hash: `hash_${eventId}`,
    },
  }
}

/** A meta event (D9 skip) — `channel.created`. */
export function metaEvent(streamId: string, seq: number): EventRow {
  const eventId = `e_${streamId}_${seq}`
  return {
    stream_id: streamId,
    server_sequence: seq,
    event_id: eventId,
    type: 'channel.created',
    envelope: {
      body: {
        event_id: eventId,
        workspace_id: 'w_test',
        stream_id: streamId,
        type: 'channel.created',
        type_version: 1,
        author_user_id: 'u_author',
        author_device_id: 'd_test',
        client_created_at: '2026-01-01T00:00:00.000Z',
        payload: { name: 'general' },
      },
      event_hash: `hash_${eventId}`,
    },
  }
}

/**
 * A `dm.created` v1 genesis event, SELF-HOMED in the DM's own stream (§2.2) —
 * the ENG-149 `dm_user_ids` fold source. `payload` overrides support malformed-
 * genesis cases (D9 skip → the field stays absent).
 */
export function dmCreatedEvent(opts: {
  streamId: string
  seq?: number
  memberUserIds?: string[]
  typeVersion?: number
  payload?: unknown
}): EventRow {
  const seq = opts.seq ?? 1
  const eventId = `e_${opts.streamId}_${seq}`
  return {
    stream_id: opts.streamId,
    server_sequence: seq,
    event_id: eventId,
    type: 'dm.created',
    envelope: {
      body: {
        event_id: eventId,
        workspace_id: 'w_test',
        stream_id: opts.streamId,
        type: 'dm.created',
        type_version: opts.typeVersion ?? 1,
        author_user_id: 'u_author',
        author_device_id: 'd_test',
        client_created_at: '2026-01-01T00:00:00.000Z',
        payload: opts.payload ?? {
          dm_stream_id: opts.streamId,
          member_user_ids: opts.memberUserIds ?? [],
        },
      },
      event_hash: `hash_${eventId}`,
    },
  }
}

/** A `workspace-meta` user lifecycle event (ENG-101 directory derivation). */
/** A `workspace.created`/`workspace.updated` meta event (ENG-152 identity fold). */
export function metaWorkspaceEvent(
  streamId: string,
  seq: number,
  type: 'workspace.created' | 'workspace.updated',
  // Presence-significant, matching the server `WorkspaceUpdatedV1`: `icon_sha256`
  // (ENG-152) may be a string (set) or an explicit null (cleared); absence means
  // untouched — same nullable semantics as name/description.
  payload: { name?: string; description?: string; icon_sha256?: string | null },
): EventRow {
  const eventId = `e_${streamId}_${seq}`
  return {
    stream_id: streamId,
    server_sequence: seq,
    event_id: eventId,
    type,
    envelope: {
      body: {
        event_id: eventId,
        workspace_id: 'w_test',
        stream_id: streamId,
        type,
        type_version: 1,
        author_user_id: 'u_admin',
        author_device_id: 'd_test',
        client_created_at: '2026-01-01T00:00:00.000Z',
        payload,
      },
      event_hash: `hash_${eventId}`,
    },
  }
}

export function metaUserEvent(
  streamId: string,
  seq: number,
  type: 'user.joined' | 'user.left' | 'user.profile_updated',
  // ENG-164: profile_updated may carry title/description/status fields (a
  // null clears; absent leaves untouched) — modeled as an open record here.
  payload: { user_id: string; display_name?: string } & Record<string, unknown>,
  authorUserId?: string,
): EventRow {
  const eventId = `e_${streamId}_${seq}`
  return {
    stream_id: streamId,
    server_sequence: seq,
    event_id: eventId,
    type,
    envelope: {
      body: {
        event_id: eventId,
        workspace_id: 'w_test',
        stream_id: streamId,
        type,
        type_version: 1,
        // Defaults to the subject (self-authored, like user.joined); a test may
        // override it to forge a cross-user rename (author != subject).
        author_user_id: authorUserId ?? payload.user_id,
        author_device_id: 'd_test',
        client_created_at: '2026-01-01T00:00:00.000Z',
        payload,
      },
      event_hash: `hash_${eventId}`,
    },
  }
}

/**
 * A structurally-valid `message.created` v1 envelope whose payload is missing a
 * `message_id` — the malformed-known case (skip + warn, never throw).
 */
export function malformedMessageEvent(streamId: string, seq: number): EventRow {
  const ev = messageCreatedEvent({ streamId, seq, messageId: 'm_placeholder' })
  ;(ev.envelope!.body.payload as Record<string, unknown>) = { text: 'orphan', format: 'plain' }
  return ev
}

// ---------------------------------------------------------------------------
// ENG-100 (M3) event builders — reactions, edits, deletes. All share the §2.1
// envelope shape; `type_version` is 1. `author_user_id` is the reactor/editor.
// ---------------------------------------------------------------------------

interface RefEventOpts {
  streamId: string
  seq: number
  messageId: string
  authorUserId?: string
}

function refEvent(type: string, payload: Record<string, unknown>, opts: RefEventOpts): EventRow {
  const eventId = `e_${opts.streamId}_${opts.seq}`
  return {
    stream_id: opts.streamId,
    server_sequence: opts.seq,
    event_id: eventId,
    type,
    envelope: {
      body: {
        event_id: eventId,
        workspace_id: 'w_test',
        stream_id: opts.streamId,
        type,
        type_version: 1,
        author_user_id: opts.authorUserId ?? 'u_author',
        author_device_id: 'd_test',
        client_created_at: '2026-01-01T00:00:00.000Z',
        payload,
      },
      event_hash: `hash_${eventId}`,
    },
  }
}

/** A `reaction.added` v1 event (reactor = `authorUserId`, exact-byte `emoji`). */
export function reactionAddedEvent(opts: RefEventOpts & { emoji: string }): EventRow {
  return refEvent('reaction.added', { message_id: opts.messageId, emoji: opts.emoji }, opts)
}

/** A `reaction.removed` v1 event. */
export function reactionRemovedEvent(opts: RefEventOpts & { emoji: string }): EventRow {
  return refEvent('reaction.removed', { message_id: opts.messageId, emoji: opts.emoji }, opts)
}

/** A `message.edited` v1 event (new `text`+`format` for `messageId`). */
export function messageEditedEvent(
  opts: RefEventOpts & { text: string; format?: 'markdown' | 'plain' },
): EventRow {
  return refEvent(
    'message.edited',
    { message_id: opts.messageId, text: opts.text, format: opts.format ?? 'markdown' },
    opts,
  )
}

/** A `message.deleted` v1 tombstone event for `messageId`. */
export function messageDeletedEvent(opts: RefEventOpts): EventRow {
  return refEvent('message.deleted', { message_id: opts.messageId }, opts)
}

// ---------------------------------------------------------------------------
// ENG-120 file.uploaded builders. A `file.uploaded` v1 payload carries NO
// stream_id (it comes from the envelope); the five fields mirror FileUploadedV1.
// ---------------------------------------------------------------------------

/**
 * A deterministic, format-valid `f_` id from a short numeric tag (26-char ULID:
 * Crockford base32, first char ≤ '7'). e.g. `fileId(1)` → `f_00…01`.
 */
export function fileId(tag: number): string {
  // Hex digits (0-9A-F) are all valid Crockford base32 chars, so the id is a
  // format-valid ULID for any tag; pad to the 26-char ULID width.
  const suffix = tag.toString(16).toUpperCase()
  return `f_${'0'.repeat(26 - suffix.length)}${suffix}`
}

export interface FileUploadedOpts {
  streamId: string
  seq: number
  fileId: string
  sha256?: string
  name?: string
  mimeType?: string
  sizeBytes?: number
  authorUserId?: string
  typeVersion?: number
  /** The body's `client_created_at` (ENG-152 `FileRow.created_at` source). */
  clientCreatedAt?: string
}

/** A well-formed `file.uploaded` event (v1 by default). */
export function fileUploadedEvent(opts: FileUploadedOpts): EventRow {
  const eventId = `e_${opts.streamId}_${opts.seq}`
  const type = 'file.uploaded'
  return {
    stream_id: opts.streamId,
    server_sequence: opts.seq,
    event_id: eventId,
    type,
    envelope: {
      body: {
        event_id: eventId,
        workspace_id: 'w_test',
        stream_id: opts.streamId,
        type,
        type_version: opts.typeVersion ?? 1,
        author_user_id: opts.authorUserId ?? 'u_author',
        author_device_id: 'd_test',
        client_created_at: opts.clientCreatedAt ?? '2026-01-01T00:00:00.000Z',
        payload: {
          file_id: opts.fileId,
          sha256: opts.sha256 ?? 'a'.repeat(64),
          name: opts.name ?? 'photo.png',
          mime_type: opts.mimeType ?? 'image/png',
          size_bytes: opts.sizeBytes ?? 1234,
        },
      },
      event_hash: `hash_${eventId}`,
    },
  }
}
