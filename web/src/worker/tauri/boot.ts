// worker/tauri/boot.ts — assembles the DESKTOP trim of the worker core
// (ENG-170, M6-5): the SqliteDb over the Tauri SqlDriver on the configured
// workspace folder's `projections.sqlite3`, the on-disk WorkspaceMirror over
// the Tauri EventLog/ManifestStore, the content-addressed TauriBlobCache, the
// OS-keychain TauriSecretStore, plugin-http `fetch` (the tauri:// webview's
// CORS-free transport) and the explicit base/WS URLs from the configured
// server — exactly the headless-CI wiring of tests/integration/m6-offline
// with the Node seams swapped for their Rust twins.
//
// client.ts dynamic-imports this module ONLY when `__TAURI_INTERNALS__` is
// present, so none of it (nor `@tauri-apps/*`) enters the web entry graph.

import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

import type { WorkerCoreOptions } from '../core'
import { WorkspaceMirror, type WorkspaceMirrorIdentity } from '../mirror/workspace-mirror'
import { openSqliteDb } from '../sqlite/sqlite-db'
import { META_DEVICE_ID, META_MY_USER_ID, META_WORKSPACE_ID, type MsgDb } from '../types'
import type { WsFactory } from '../ws'

import { deriveDesktopWsUrl, readDesktopConfig, type DesktopConfig } from './config'
import { TauriBlobCache, TauriEventLog, TauriManifestStore } from './fs'
import { invoke as defaultInvoke, type Invoke } from './invoke'
import { TauriSecretStore } from './secret-store'
import { TauriSqlDriver } from './sql-driver'

export interface TauriBoot {
  config: DesktopConfig
  /** Opens the workspace's `projections.sqlite3` over the Tauri SqlDriver. */
  openDb: () => Promise<MsgDb>
  /** The desktop WorkerCore knobs (full mirror, seams, URLs, fetch). */
  coreOptions: WorkerCoreOptions
}

/** Injection points for tests (fake IPC / fetch / WS). */
export interface TauriBootDeps {
  invoke?: Invoke
  fetchImpl?: typeof fetch
  wsFactory?: WsFactory
}

/**
 * The local identity the mirror stamps into `workspace.json`. It becomes
 * known only at (first) login — AuthManager persists it through `metaPut` —
 * so the mirror receives a GETTER-backed identity over a cache that is
 * seeded from `meta` at boot and refreshed by intercepting `metaPut`. By the
 * time the mirror first writes (registerStreams, on a post-auth `/v1/sync`
 * response), the cache is warm; if not, the getter fails CLOSED and the
 * mirror write aborts rather than minting a manifest with a bogus author.
 */
interface IdentityCache {
  workspaceId: string | null
  myUserId: string | null
  deviceId: string | null
  workspaceName: string | null
}

function requireField(value: string | null, what: string): string {
  if (value === null) {
    throw new Error(`tauri boot: the local ${what} is not established yet (pre-login?)`)
  }
  return value
}

/** First-run probe: `true` when no desktop config exists yet (→ onboarding). */
export async function needsOnboarding(invoke: Invoke = defaultInvoke): Promise<boolean> {
  return (await readDesktopConfig(invoke)) === null
}

/**
 * Build the desktop boot from the persisted config, or `null` on first run
 * (no config yet — the router shows the onboarding view, which persists the
 * config and reloads the window).
 */
export async function createTauriBoot(deps: TauriBootDeps = {}): Promise<TauriBoot | null> {
  const invoke = deps.invoke ?? defaultInvoke
  const config = await readDesktopConfig(invoke)
  if (config === null) return null
  return createTauriBootFromConfig(config, deps)
}

/** The config-known assembly (exported for the onboarding flow + tests). */
export async function createTauriBootFromConfig(
  config: DesktopConfig,
  deps: TauriBootDeps = {},
): Promise<TauriBoot> {
  const invoke = deps.invoke ?? defaultInvoke
  const root = config.workspaceDir
  const dbPath = `${root}/projections.sqlite3`

  const manifestStore = new TauriManifestStore(root, invoke)
  const identityCache: IdentityCache = {
    workspaceId: null,
    myUserId: null,
    deviceId: null,
    workspaceName: null,
  }
  const identity: WorkspaceMirrorIdentity = {
    get workspaceId() {
      return requireField(identityCache.workspaceId, 'workspace id')
    },
    get workspaceName() {
      // Cosmetic in the manifest (verify only requires the key): keep the
      // existing manifest's name, else a stable default.
      return identityCache.workspaceName ?? 'msg workspace'
    },
    get myUserId() {
      return requireField(identityCache.myUserId, 'user id')
    },
    get deviceId() {
      return requireField(identityCache.deviceId, 'device id')
    },
  }

  const openDb = async (): Promise<MsgDb> => {
    const driver = await TauriSqlDriver.open(dbPath, invoke)
    const db = await openSqliteDb(driver)
    // Seed the identity cache: a returning install has it in `meta`; a fresh
    // one gets it at login via the metaPut interception below.
    const [wsId, userId, deviceId] = await Promise.all([
      db.metaGet<string>(META_WORKSPACE_ID),
      db.metaGet<string>(META_MY_USER_ID),
      db.metaGet<string>(META_DEVICE_ID),
    ])
    if (typeof wsId === 'string') identityCache.workspaceId = wsId
    if (typeof userId === 'string') identityCache.myUserId = userId
    if (typeof deviceId === 'string') identityCache.deviceId = deviceId
    try {
      const manifest = await manifestStore.read()
      if (manifest) identityCache.workspaceName = manifest.name
    } catch {
      // An unreadable manifest never blocks boot; the mirror will re-mint it.
    }
    // Intercept the identity keys AuthManager persists at login so the mirror
    // identity is warm before the first post-auth sync response.
    const originalMetaPut = db.metaPut.bind(db)
    db.metaPut = async (key: string, value: unknown): Promise<void> => {
      await originalMetaPut(key, value)
      if (typeof value !== 'string') return
      if (key === META_WORKSPACE_ID) identityCache.workspaceId = value
      else if (key === META_MY_USER_ID) identityCache.myUserId = value
      else if (key === META_DEVICE_ID) identityCache.deviceId = value
    }
    return db
  }

  // The documented fallback WS transport (see worker/tauri/ws.ts): only the
  // explicit `wsTransport: 'plugin'` config selects it; the primary path is
  // the webview's raw WebSocket (the core's default browserWsFactory).
  let wsFactory = deps.wsFactory
  if (!wsFactory && config.wsTransport === 'plugin') {
    wsFactory = (await import('./ws')).pluginWsFactory
  }

  const coreOptions: WorkerCoreOptions = {
    // Explicit server URLs: the SPA is served from tauri://, so same-origin
    // relative `/v1` paths and location-derived WS URLs cannot work here.
    baseUrl: config.serverUrl,
    wsUrl: deriveDesktopWsUrl(config.serverUrl),
    // plugin-http's fetch: goes through the Rust HTTP client, so the msgd
    // API needs no CORS allowance for the tauri:// origin.
    fetchImpl: deps.fetchImpl ?? tauriFetch,
    // M6-3 desktop trim: full mirror + on-disk NDJSON workspace + blob cache.
    fullMirror: true,
    mirror: new WorkspaceMirror(new TauriEventLog(root, invoke), manifestStore, identity),
    blobStore: new TauriBlobCache(root, invoke),
    // M6-4: the token rests in the OS keychain, never the workspace folder.
    secretStore: new TauriSecretStore(invoke),
    // M6-4 cold-offline boot: report real connectivity so the engine parks
    // degraded('offline') without dialing when the machine is offline.
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
    ...(wsFactory ? { wsFactory } : {}),
  }

  return { config, openDb, coreOptions }
}
