// ENG-170 (M6-5) — env detection + the desktop boot assembly: a Tauri env
// must select the SOLO transport running the desktop trim — SqliteDb over the
// Tauri SqlDriver, fullMirror + on-disk WorkspaceMirror over the Tauri seams,
// the keychain SecretStore, plugin-http fetch and explicit base/WS URLs from
// the configured server. Web env detection (shared-worker/leader/solo) stays
// byte-identical.

import { describe, expect, it, vi } from 'vitest'

// jsdom has no Tauri host: replace the plugin-http fetch with a sentinel the
// assembly test can assert on (boot.ts imports it statically; vi.mock is
// hoisted, so the sentinel must be hoisted too).
const pluginFetch = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: pluginFetch }))

import { newDeviceId, newStreamId, newUserId, newWorkspaceId } from '../../../src/core'
import { detectTransportKind } from '../../../src/worker/client'
import { WorkspaceMirror } from '../../../src/worker/mirror/workspace-mirror'
import { SqliteDb } from '../../../src/worker/sqlite/sqlite-db'
import {
  createTauriBoot,
  createTauriBootFromConfig,
  needsOnboarding,
} from '../../../src/worker/tauri/boot'
import type { DesktopConfig } from '../../../src/worker/tauri/config'
import { deriveDesktopWsUrl, normalizeServerUrl } from '../../../src/worker/tauri/config'
import { TauriBlobCache } from '../../../src/worker/tauri/fs'
import type { Invoke } from '../../../src/worker/tauri/invoke'
import { TauriSecretStore } from '../../../src/worker/tauri/secret-store'
import { pluginWsFactory } from '../../../src/worker/tauri/ws'
import { META_DEVICE_ID, META_MY_USER_ID, META_WORKSPACE_ID } from '../../../src/worker/types'

// ---------------------------------------------------------------------------
// A minimal in-memory fake of the Rust host (the cargo tests own the real
// side of these contracts).
// ---------------------------------------------------------------------------

interface FakeHost {
  invoke: Invoke
  state: { config: string | null; manifest: string | null }
  calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }>
}

function fakeHost(config: DesktopConfig | null): FakeHost {
  const state = {
    config: config === null ? null : JSON.stringify(config),
    manifest: null as string | null,
  }
  const calls: FakeHost['calls'] = []
  const invoke: Invoke = <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args })
    const result = ((): unknown => {
      switch (cmd) {
        case 'desktop_config_read':
          return state.config
        case 'sql_select':
          return []
        case 'manifest_read':
          return state.manifest
        case 'manifest_write':
          state.manifest = args?.json as string
          return undefined
        case 'ndjson_list_months':
        case 'ndjson_list_streams':
        case 'ndjson_read_all':
          return []
        default:
          return undefined // sql_open/execute/close, ndjson_append, secret_*, …
      }
    })()
    return Promise.resolve(result as T)
  }
  return { invoke, state, calls }
}

const CONFIG: DesktopConfig = {
  serverUrl: 'https://msg.example.com',
  workspaceDir: '/Users/me/msg-workspace',
}

// ---------------------------------------------------------------------------
// Env detection: Tauri → solo, everything web-shaped unchanged.
// ---------------------------------------------------------------------------

describe('detectTransportKind with a Tauri env (M6-5)', () => {
  it('selects solo in the Tauri shell even when SharedWorker/locks exist', () => {
    expect(
      detectTransportKind({
        hasTauri: true,
        hasSharedWorker: true,
        hasLocks: true,
        hasBroadcastChannel: true,
      }),
    ).toBe('solo')
  })

  it('leaves the three web environments byte-identical', () => {
    expect(
      detectTransportKind({ hasSharedWorker: true, hasLocks: true, hasBroadcastChannel: true }),
    ).toBe('shared-worker')
    expect(
      detectTransportKind({ hasSharedWorker: false, hasLocks: true, hasBroadcastChannel: true }),
    ).toBe('leader')
    expect(
      detectTransportKind({ hasSharedWorker: false, hasLocks: false, hasBroadcastChannel: false }),
    ).toBe('solo')
  })
})

// ---------------------------------------------------------------------------
// The boot assembly.
// ---------------------------------------------------------------------------

describe('createTauriBoot (the desktop trim assembly)', () => {
  it('returns null on first run (no config) and needsOnboarding reports it', async () => {
    const host = fakeHost(null)
    expect(await needsOnboarding(host.invoke)).toBe(true)
    expect(await createTauriBoot({ invoke: host.invoke })).toBeNull()

    const configured = fakeHost(CONFIG)
    expect(await needsOnboarding(configured.invoke)).toBe(false)
  })

  it('assembles solo-core options: SqliteDb + fullMirror + Tauri seams + Tauri fetch + explicit URLs', async () => {
    const host = fakeHost(CONFIG)
    const boot = await createTauriBoot({ invoke: host.invoke })
    expect(boot).not.toBeNull()
    if (!boot) return

    // Explicit server URLs (the tauri:// origin has no same-origin /v1).
    expect(boot.coreOptions.baseUrl).toBe('https://msg.example.com')
    expect(boot.coreOptions.wsUrl).toBe('wss://msg.example.com/v1/ws')
    // The plugin-http fetch (bypasses webview CORS) is the default transport.
    expect(boot.coreOptions.fetchImpl).toBe(pluginFetch)
    // Desktop trim: full mirror + on-disk seams + keychain SecretStore.
    expect(boot.coreOptions.fullMirror).toBe(true)
    expect(boot.coreOptions.mirror).toBeInstanceOf(WorkspaceMirror)
    expect(boot.coreOptions.blobStore).toBeInstanceOf(TauriBlobCache)
    expect(boot.coreOptions.secretStore).toBeInstanceOf(TauriSecretStore)
    expect(typeof boot.coreOptions.isOnline).toBe('function')
    // Primary WS path is the webview's raw WebSocket: no factory injected.
    expect(boot.coreOptions.wsFactory).toBeUndefined()

    // The DB is the SqliteDb over the workspace's projections.sqlite3.
    const db = await boot.openDb()
    expect(db).toBeInstanceOf(SqliteDb)
    expect(host.calls.find((c) => c.cmd === 'sql_open')?.args).toEqual({
      path: '/Users/me/msg-workspace/projections.sqlite3',
    })
    // The schema (FTS5 included) went through the Tauri driver.
    const executed = host.calls.filter((c) => c.cmd === 'sql_execute')
    expect(executed.some((c) => String(c.args?.sql).includes('USING fts5'))).toBe(true)
    await db.close()
  })

  it('selects the plugin WS fallback only when the config says so', async () => {
    const host = fakeHost({ ...CONFIG, wsTransport: 'plugin' })
    const boot = await createTauriBoot({ invoke: host.invoke })
    expect(boot?.coreOptions.wsFactory).toBe(pluginWsFactory)
  })

  it('warms the mirror identity from login metaPut writes (manifest carries the local author)', async () => {
    const host = fakeHost(CONFIG)
    const boot = await createTauriBootFromConfig(CONFIG, { invoke: host.invoke })
    const db = await boot.openDb()
    const mirror = boot.coreOptions.mirror
    expect(mirror).toBeDefined()
    if (!mirror) return

    const sid = newStreamId()
    // Pre-login: no identity yet → the mirror must fail CLOSED, no manifest.
    await expect(
      mirror.registerStreams([
        {
          stream_id: sid,
          kind: 'channel',
          name: 'general',
          visibility: 'public',
          head_seq: 0,
          member: true,
        },
      ]),
    ).rejects.toThrow(/not established/)
    expect(host.state.manifest).toBeNull()

    // Login lands identity through db.metaPut (the AuthManager path) — the
    // boot's interception warms the mirror identity.
    const wsId = newWorkspaceId()
    const userId = newUserId()
    const deviceId = newDeviceId()
    await db.metaPut(META_WORKSPACE_ID, wsId)
    await db.metaPut(META_MY_USER_ID, userId)
    await db.metaPut(META_DEVICE_ID, deviceId)
    await mirror.registerStreams([
      {
        stream_id: sid,
        kind: 'channel',
        name: 'general',
        visibility: 'public',
        head_seq: 0,
        member: true,
      },
    ])
    expect(host.state.manifest).not.toBeNull()
    const manifest = JSON.parse(host.state.manifest ?? '{}') as {
      workspace_id: string
      local_author: { user_id: string; device_id: string }
      streams: Record<string, { name: string }>
    }
    expect(manifest.workspace_id).toBe(wsId)
    expect(manifest.local_author).toEqual({ user_id: userId, device_id: deviceId })
    expect(manifest.streams[sid]?.name).toBe('general')
    await db.close()
  })
})

// ---------------------------------------------------------------------------
// Config helpers.
// ---------------------------------------------------------------------------

describe('desktop config helpers', () => {
  it('normalizeServerUrl accepts http(s) and strips trailing slashes', () => {
    expect(normalizeServerUrl('https://msg.example.com/')).toBe('https://msg.example.com')
    expect(normalizeServerUrl(' http://10.0.0.5:8080 ')).toBe('http://10.0.0.5:8080')
    expect(normalizeServerUrl('https://host/base/')).toBe('https://host/base')
    expect(normalizeServerUrl('ftp://host')).toBeNull()
    expect(normalizeServerUrl('not a url')).toBeNull()
  })

  it('deriveDesktopWsUrl maps http(s) → ws(s) onto /v1/ws', () => {
    expect(deriveDesktopWsUrl('https://msg.example.com')).toBe('wss://msg.example.com/v1/ws')
    expect(deriveDesktopWsUrl('http://localhost:8080')).toBe('ws://localhost:8080/v1/ws')
  })
})
