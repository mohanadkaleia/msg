// worker/ws.ts — the WebSocket transport seam (ENG-79, §5). The real `WebSocket`
// NEVER appears in `sync.ts`: the engine drives this minimal interface, prod
// builds a `BrowserWsConnection`, and tests supply a `FakeWsConnection`. No sync
// logic lives here — pure transport.

import type { WireEvent } from './types'

/**
 * A parsed inbound text frame. `event`/`ping`/`pong` are the M1 surface; every
 * other `t` (M3 read_state/presence/typing, or unknown) is tolerated + ignored
 * by the engine (D9). The catch-all keeps the type open without `any`.
 */
export type WsFrame =
  { t: 'event'; event: WireEvent } | { t: 'ping' } | { t: 'pong' } | { t: string }

/** Client→server control frames — the only M1 client-send surface. */
export type WsClientFrame = { t: 'ping' } | { t: 'pong' }

/**
 * The transport contract `SyncEngine` drives. Callbacks are registered once,
 * right after construction, before any event can fire.
 */
export interface WsConnection {
  send(frame: WsClientFrame): void
  close(code?: number): void
  onFrame(cb: (f: WsFrame) => void): void
  onOpen(cb: () => void): void
  onClose(cb: (info: { code: number; wasClean: boolean }) => void): void
  onError(cb: () => void): void
}

/**
 * Injected into `SyncEngine`. Prod passes {@link browserWsFactory}; tests pass a
 * fake. The token flows factory-side (never in the URL) — a `BrowserWsConnection`
 * puts it in the `Sec-WebSocket-Protocol: bearer, <token>` subprotocol (ENG-78/68).
 */
export type WsFactory = (url: string, token: string) => WsConnection

/** Client close code for a locally-initiated teardown (watchdog / reconnect). */
export const WS_CLOSE_CLIENT_GOING_AWAY = 4000

/**
 * Derive the same-origin WS URL from a `Location`. In a SharedWorker the worker's
 * `location` is the app origin (single-origin, §5.1). `http(s)` → `ws(s)`.
 */
export function deriveWsUrl(loc: Location = location): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${loc.host}/v1/ws`
}

/**
 * The production {@link WsConnection}: a thin wrapper over a real `WebSocket`.
 * The bearer token travels as the `['bearer', token]` subprotocol, never the URL
 * (a query token leaks into request-line logs, ENG-64 D2 / ws/router.py). A
 * non-text / non-JSON / non-object message is dropped — it never crashes.
 */
export class BrowserWsConnection implements WsConnection {
  private readonly ws: WebSocket
  private frameCb: ((f: WsFrame) => void) | undefined
  private openCb: (() => void) | undefined
  private closeCb: ((info: { code: number; wasClean: boolean }) => void) | undefined
  private errorCb: (() => void) | undefined

  constructor(url: string, token: string) {
    this.ws = new WebSocket(url, ['bearer', token])
    this.ws.addEventListener('open', () => this.openCb?.())
    this.ws.addEventListener('close', (ev: CloseEvent) => {
      this.closeCb?.({ code: ev.code, wasClean: ev.wasClean })
    })
    this.ws.addEventListener('error', () => this.errorCb?.())
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      const frame = parseFrame(ev.data)
      if (frame) this.frameCb?.(frame)
    })
  }

  send(frame: WsClientFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }

  close(code?: number): void {
    try {
      this.ws.close(code)
    } catch {
      // An invalid close code / already-closing socket — nothing to do.
    }
  }

  onFrame(cb: (f: WsFrame) => void): void {
    this.frameCb = cb
  }
  onOpen(cb: () => void): void {
    this.openCb = cb
  }
  onClose(cb: (info: { code: number; wasClean: boolean }) => void): void {
    this.closeCb = cb
  }
  onError(cb: () => void): void {
    this.errorCb = cb
  }
}

/** Parse a raw WS `message.data` payload into a {@link WsFrame}, or null to drop. */
export function parseFrame(data: unknown): WsFrame | null {
  if (typeof data !== 'string') return null // binary frames are not part of the protocol
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const t = (parsed as { t?: unknown }).t
  if (typeof t !== 'string') return null
  return parsed as WsFrame
}

/** The production {@link WsFactory}. */
export const browserWsFactory: WsFactory = (url, token) => new BrowserWsConnection(url, token)
