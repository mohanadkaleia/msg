import { describe, expect, it } from 'vitest'

import { deriveWsUrl, parseFrame } from '../../../src/worker/ws'
import type { WireEvent } from '../../../src/worker/types'

describe('parseFrame (BrowserWsConnection text-frame parsing)', () => {
  it('parses a JSON text event frame into a WsFrame', () => {
    const event: WireEvent = {
      body: {
        stream_id: 's1',
        type: 'message.created',
        type_version: 1,
        author_user_id: 'u_1',
        payload: {},
      },
      event_hash: 'sha256:abc',
      signature: null,
      server: {
        server_sequence: 5,
        server_received_at: '2026-01-01T00:00:00.000Z',
        payload_redacted: false,
      },
    }
    const frame = parseFrame(JSON.stringify({ t: 'event', event }))
    expect(frame).toEqual({ t: 'event', event })
  })

  it('parses ping / pong control frames', () => {
    expect(parseFrame(JSON.stringify({ t: 'ping' }))).toEqual({ t: 'ping' })
    expect(parseFrame(JSON.stringify({ t: 'pong' }))).toEqual({ t: 'pong' })
  })

  it('keeps unknown/reserved frame types (tolerated, ignored by the engine)', () => {
    expect(parseFrame(JSON.stringify({ t: 'typing', stream_id: 's1' }))).toEqual({
      t: 'typing',
      stream_id: 's1',
    })
  })

  it('parses the ENG-126 signal frames (read_state / prefs / presence / typing)', () => {
    expect(
      parseFrame(JSON.stringify({ t: 'read_state', stream_id: 's1', last_read_seq: 7 })),
    ).toEqual({ t: 'read_state', stream_id: 's1', last_read_seq: 7 })
    expect(parseFrame(JSON.stringify({ t: 'prefs', stream_id: 's1', level: 'mute' }))).toEqual({
      t: 'prefs',
      stream_id: 's1',
      level: 'mute',
    })
    expect(parseFrame(JSON.stringify({ t: 'presence', user_id: 'u1', status: 'online' }))).toEqual({
      t: 'presence',
      user_id: 'u1',
      status: 'online',
    })
    expect(parseFrame(JSON.stringify({ t: 'typing', stream_id: 's1', user_id: 'u1' }))).toEqual({
      t: 'typing',
      stream_id: 's1',
      user_id: 'u1',
    })
  })

  it('drops a non-JSON text payload without throwing', () => {
    expect(parseFrame('not json {')).toBeNull()
  })

  it('drops a binary / non-string payload', () => {
    expect(parseFrame(new ArrayBuffer(8))).toBeNull()
    expect(parseFrame(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('drops a JSON value that is not an object with a string `t`', () => {
    expect(parseFrame(JSON.stringify(42))).toBeNull()
    expect(parseFrame(JSON.stringify(['event']))).toBeNull()
    expect(parseFrame(JSON.stringify({ notT: 1 }))).toBeNull()
    expect(parseFrame(JSON.stringify({ t: 7 }))).toBeNull()
    expect(parseFrame(JSON.stringify(null))).toBeNull()
  })
})

describe('deriveWsUrl (same-origin ws(s) derivation)', () => {
  it('maps http → ws and preserves host', () => {
    expect(deriveWsUrl({ protocol: 'http:', host: 'localhost:3000' } as Location)).toBe(
      'ws://localhost:3000/v1/ws',
    )
  })

  it('maps https → wss', () => {
    expect(deriveWsUrl({ protocol: 'https:', host: 'msg.example.com' } as Location)).toBe(
      'wss://msg.example.com/v1/ws',
    )
  })
})
