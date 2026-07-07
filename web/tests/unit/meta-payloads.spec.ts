// tests/unit/meta-payloads.spec.ts — the ENG-104 channel/DM payload + body builders
// (TS port of server/msgd/core/payloads/meta.py). Format-validation only (typed-id
// prefix + ULID validity, visibility literal); referential existence is a server
// concern. Body builders home + hash honestly.

import { describe, expect, it } from 'vitest'

import {
  buildChannelCreatedBody,
  buildChannelCreatedPayload,
  buildDmCreatedBody,
  buildDmCreatedPayload,
  finalizeEnvelope,
  hashEvent,
  newDeviceId,
  newStreamId,
  newUserId,
  newWorkspaceId,
} from '../../src/core'

const envelope = () => ({
  workspace_id: newWorkspaceId(),
  author_user_id: newUserId(),
  author_device_id: newDeviceId(),
  client_created_at: '2026-07-05T00:00:00.000Z',
})

describe('channel.created payload (format validation only)', () => {
  it('accepts a valid channel and rejects a bad stream id / visibility', () => {
    expect(
      buildChannelCreatedPayload({
        channel_stream_id: newStreamId(),
        name: 'general',
        visibility: 'public',
      }).visibility,
    ).toBe('public')
    expect(() =>
      buildChannelCreatedPayload({
        channel_stream_id: 'not-a-stream',
        name: 'x',
        visibility: 'public',
      }),
    ).toThrow()
    expect(() =>
      buildChannelCreatedPayload({
        channel_stream_id: newStreamId(),
        name: 'x',
        // @ts-expect-error deliberately bad visibility
        visibility: 'secret',
      }),
    ).toThrow()
  })
})

describe('dm.created payload', () => {
  it('rejects an empty participant list and a malformed user id', () => {
    expect(() =>
      buildDmCreatedPayload({ dm_stream_id: newStreamId(), member_user_ids: [] }),
    ).toThrow()
    expect(() =>
      buildDmCreatedPayload({ dm_stream_id: newStreamId(), member_user_ids: ['nope'] }),
    ).toThrow()
    const ok = buildDmCreatedPayload({
      dm_stream_id: newStreamId(),
      member_user_ids: [newUserId(), newUserId()],
    })
    expect(ok.member_user_ids).toHaveLength(2)
  })
})

describe('meta body builders home + hash honestly', () => {
  it('public channel.created homes at the given (meta) stream and hashes honestly', async () => {
    const meta = newStreamId()
    const channel = newStreamId()
    const body = buildChannelCreatedBody({
      ...envelope(),
      stream_id: meta,
      channel_stream_id: channel,
      name: 'general',
      visibility: 'public',
    })
    expect(body.type).toBe('channel.created')
    expect(body.stream_id).toBe(meta) // caller-chosen home
    const { event_hash } = await finalizeEnvelope(body)
    expect(await hashEvent(body)).toBe(event_hash)
  })

  it('dm.created is self-homed in the DM stream', () => {
    const dm = newStreamId()
    const body = buildDmCreatedBody({
      ...envelope(),
      stream_id: dm,
      dm_stream_id: dm,
      member_user_ids: [newUserId(), newUserId()],
    })
    expect(body.type).toBe('dm.created')
    expect(body.stream_id).toBe(dm)
  })
})
