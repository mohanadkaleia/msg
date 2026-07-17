// worker/tauri/ws.ts — the FALLBACK WS transport (ENG-170, M6-5): a
// `WsConnection` over tauri-plugin-websocket, i.e. a Rust-side socket
// (tokio-tungstenite) instead of the webview's `WebSocket`.
//
// PRIMARY path is the webview's raw `new WebSocket(url, ['bearer', token])`
// (the default `browserWsFactory` — no code here involved): WS is exempt from
// CORS and WKWebView allows it from the tauri:// origin. This module exists
// for the documented failure mode — a webview refusing the socket (e.g. a
// mixed-content block of `ws://` on a non-localhost host from the custom
// scheme) — selected via `wsTransport: 'plugin'` in the desktop config. The
// bearer rides the same `Sec-WebSocket-Protocol: bearer, <token>` header the
// server normalizes (msgd ws/router.py `_bearer_token`), never the URL.

import TauriWebSocket from '@tauri-apps/plugin-websocket'

import {
  parseFrame,
  type WsClientFrame,
  type WsConnection,
  type WsFactory,
  type WsFrame,
} from '../ws'

type PluginMessage =
  | { type: 'Text'; data: string }
  | { type: 'Binary'; data: number[] }
  | { type: 'Ping'; data: number[] }
  | { type: 'Pong'; data: number[] }
  | { type: 'Close'; data: { code: number; reason: string } | null }

class PluginWsConnection implements WsConnection {
  private ws: TauriWebSocket | undefined
  private open = false
  private closeRequested = false
  private closeReported = false
  private frameCb: ((f: WsFrame) => void) | undefined
  private openCb: (() => void) | undefined
  private closeCb: ((info: { code: number; wasClean: boolean }) => void) | undefined
  private errorCb: (() => void) | undefined

  constructor(url: string, token: string) {
    void TauriWebSocket.connect(url, {
      headers: { 'Sec-WebSocket-Protocol': `bearer, ${token}` },
    })
      .then((ws) => {
        if (this.closeRequested) {
          void ws.disconnect()
          return
        }
        this.ws = ws
        void ws.addListener((raw) => {
          this.onMessage(raw)
        })
        this.open = true
        this.openCb?.()
      })
      .catch(() => {
        this.errorCb?.()
        this.reportClose(1006, false)
      })
  }

  private onMessage(msg: PluginMessage): void {
    if (msg.type === 'Text') {
      const frame = parseFrame(msg.data)
      if (frame) this.frameCb?.(frame)
    } else if (msg.type === 'Close') {
      this.open = false
      this.reportClose(msg.data?.code ?? 1005, true)
    }
    // Binary / protocol Ping / Pong frames are not part of the msg protocol —
    // dropped (tungstenite answers protocol pings itself).
  }

  private reportClose(code: number, wasClean: boolean): void {
    if (this.closeReported) return
    this.closeReported = true
    this.closeCb?.({ code, wasClean })
  }

  send(frame: WsClientFrame): void {
    if (this.open && this.ws) {
      this.ws.send(JSON.stringify(frame)).catch(() => {
        this.errorCb?.()
      })
    }
  }

  close(code?: number): void {
    this.closeRequested = true
    const ws = this.ws
    this.open = false
    if (ws) {
      this.ws = undefined
      ws.disconnect()
        .catch(() => {
          /* already closing/closed — nothing to do */
        })
        .finally(() => {
          this.reportClose(code ?? 1000, true)
        })
    } else {
      // Never connected (or still dialing — the connect handler disconnects).
      this.reportClose(code ?? 1000, true)
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

/** The plugin-backed {@link WsFactory} (config `wsTransport: 'plugin'`). */
export const pluginWsFactory: WsFactory = (url, token) => new PluginWsConnection(url, token)
