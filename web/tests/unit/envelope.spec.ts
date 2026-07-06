// @vitest-environment node
//
// The message.created body builder must produce a body whose JCS canonicalization
// hashes to the frozen §2.1 anchor — the builder-side proof that construction and
// hashing agree. Node env for crypto.subtle.

import { describe, expect, it } from 'vitest'

import { buildMessageCreatedBody, finalizeEnvelope } from '../../src/core/envelope'
import { buildMessageCreatedPayload } from '../../src/core/payloads/message'

const ANCHOR_HASH = 'sha256:49d43880190e9b17c2b4eb5cd4fbe39c972ba0d214b3f751d6033cb0fd707e51'

// The exact §2.1 fixed ids / text / timestamp.
const FIXED = {
  event_id: '01JZ7N6A4M6Y8W5K2H7DGKX4PA',
  workspace_id: 'w_01JZ7N6A4M6Y8W5K2H7DGKX4PB',
  stream_id: 's_01JZ7N6A4M6Y8W5K2H7DGKX4PC',
  author_user_id: 'u_01JZ7N6A4M6Y8W5K2H7DGKX4PD',
  author_device_id: 'd_01JZ7N6A4M6Y8W5K2H7DGKX4PE',
  client_created_at: '2026-07-04T18:22:10.123Z',
  message_id: 'm_01JZ7N6A4M6Y8W5K2H7DGKX4PF',
  mention: 'u_01JZ7N6A4M6Y8W5K2H7DGKX4PG',
}

describe('buildMessageCreatedBody', () => {
  it('assembles the §2.1 body and hashes to the frozen anchor', async () => {
    const body = buildMessageCreatedBody({
      event_id: FIXED.event_id,
      workspace_id: FIXED.workspace_id,
      stream_id: FIXED.stream_id,
      author_user_id: FIXED.author_user_id,
      author_device_id: FIXED.author_device_id,
      client_created_at: FIXED.client_created_at,
      message_id: FIXED.message_id,
      text: 'Hello everyone',
      mentions: [FIXED.mention],
    })

    const envelope = await finalizeEnvelope(body)
    expect(envelope.body).toBe(body)
    expect(envelope.event_hash).toBe(ANCHOR_HASH)
  })

  it('mints event_id and message_id when absent', () => {
    const body = buildMessageCreatedBody({
      workspace_id: FIXED.workspace_id,
      stream_id: FIXED.stream_id,
      author_user_id: FIXED.author_user_id,
      author_device_id: FIXED.author_device_id,
      client_created_at: FIXED.client_created_at,
      text: 'hi',
    })
    expect(body.event_id).toHaveLength(26)
    expect(body.type).toBe('message.created')
    expect(body.type_version).toBe(1)
    const payload = body.payload as { message_id: string; format: string; thread_root_id: null }
    expect(payload.message_id.startsWith('m_')).toBe(true)
    expect(payload.format).toBe('markdown')
    expect(payload.thread_root_id).toBeNull()
  })
})

describe('buildMessageCreatedPayload id validation', () => {
  it('rejects a malformed message_id', () => {
    expect(() => buildMessageCreatedPayload({ text: 'x', message_id: 'not-an-id' })).toThrow()
  })

  it('rejects a malformed mention (wrong prefix)', () => {
    expect(() =>
      buildMessageCreatedPayload({ text: 'x', mentions: ['m_01JZ7N6A4M6Y8W5K2H7DGKX4PF'] }),
    ).toThrow()
  })

  it('rejects a malformed file id', () => {
    expect(() =>
      buildMessageCreatedPayload({ text: 'x', file_ids: ['u_01JZ7N6A4M6Y8W5K2H7DGKX4PD'] }),
    ).toThrow()
  })

  it('rejects a malformed thread_root_id', () => {
    expect(() =>
      buildMessageCreatedPayload({ text: 'x', thread_root_id: 'f_01JZ7N6A4M6Y8W5K2H7DGKX4Q1' }),
    ).toThrow()
  })
})
