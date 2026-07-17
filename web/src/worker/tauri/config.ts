// worker/tauri/config.ts — the desktop app config (ENG-170, M6-5): the
// onboarding-persisted server URL + workspace folder, stored by the Rust
// `desktop_config_*` commands in the OS app-config dir — OUTSIDE the
// workspace folder (which stays a pure msgctl workspace) and NON-secret
// (the token lives in the TauriSecretStore / OS keychain).

import { invoke as defaultInvoke, type Invoke } from './invoke'

export interface DesktopConfig {
  /** The msgd base URL, e.g. `https://msg.example.com` (no trailing slash). */
  serverUrl: string
  /** Absolute path of the local workspace folder (the msgctl-verifiable root). */
  workspaceDir: string
  /**
   * WS transport: `raw` (default) = the webview's own `WebSocket` with the
   * `bearer` subprotocol; `plugin` = the Rust-side socket via
   * tauri-plugin-websocket — the documented fallback should the webview
   * refuse a raw socket from the tauri:// origin (see desktop/README.md).
   */
  wsTransport?: 'raw' | 'plugin'
}

/** Shape-check a parsed config document fail-closed (never trust old files). */
function isDesktopConfig(v: unknown): v is DesktopConfig {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.serverUrl === 'string' &&
    c.serverUrl.length > 0 &&
    typeof c.workspaceDir === 'string' &&
    c.workspaceDir.length > 0 &&
    (c.wsTransport === undefined || c.wsTransport === 'raw' || c.wsTransport === 'plugin')
  )
}

/** The persisted config, or `null` on first run / an unreadable document. */
export async function readDesktopConfig(
  invoke: Invoke = defaultInvoke,
): Promise<DesktopConfig | null> {
  const text = await invoke<string | null>('desktop_config_read')
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return isDesktopConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Persist the config atomically (Rust temp+rename discipline). */
export async function writeDesktopConfig(
  config: DesktopConfig,
  invoke: Invoke = defaultInvoke,
): Promise<void> {
  await invoke('desktop_config_write', { json: JSON.stringify(config, null, 2) + '\n' })
}

/**
 * Normalize + validate an onboarding-entered server URL: http(s) only, no
 * trailing slash (the HttpClient joins `/v1/...` paths onto it).
 */
export function normalizeServerUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const base = url.origin + url.pathname.replace(/\/+$/, '')
  return base
}

/** Derive the WS endpoint from the configured server URL (`http(s)` → `ws(s)`). */
export function deriveDesktopWsUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/, 'ws') + '/v1/ws'
}
