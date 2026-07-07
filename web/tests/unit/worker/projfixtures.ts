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
    file_ids: [],
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

/** A `workspace-meta` user lifecycle event (ENG-101 directory derivation). */
export function metaUserEvent(
  streamId: string,
  seq: number,
  type: 'user.joined' | 'user.left' | 'user.profile_updated',
  payload: { user_id: string; display_name?: string },
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
        author_user_id: payload.user_id,
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
