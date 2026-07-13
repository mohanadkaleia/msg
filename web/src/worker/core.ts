// worker/core.ts — WorkerCore: ALL worker logic, transport-agnostic (D-3).
//
// It touches nothing but (1) an MsgDb handle and (2) a MessageSink. It never
// references `self`, ports, channels, or locks — that is what makes the sync
// engine (ENG-79) and projections (ENG-80), which register handlers here,
// unit-testable in vitest against fake-indexeddb or MemoryDb, no browser.

import {
  clearWorkspaceIcon,
  createAdminInvite,
  getAdminWorkspace,
  listAdminInvites,
  listAdminMembers,
  revokeAdminInvite,
  updateAdminMember,
  updateAdminWorkspace,
  uploadWorkspaceIcon,
} from './admin'
import { AuthManager } from './auth'
import { checkProjectionVersion } from './db'
import { FileManager } from './files'
import { createHttpClient, type HttpClient } from './http'
import { rebuildFromEventLog, type RebuildFromDiskResult } from './mirror/rebuild'
import type { BlobCache } from './mirror/seams'
import type { WorkspaceMirror } from './mirror/workspace-mirror'
import { clearAvatar, getMe, updateMe, uploadAvatar } from './me'
import { MetaAuthor } from './meta'
import { Outbox } from './outbox'
import {
  createPluginBot,
  createPluginHook,
  grantPluginBotStream,
  listPluginBots,
  listPluginHooks,
  mintPluginBotToken,
  revokePluginBotStream,
  revokePluginBotToken,
  revokePluginHook,
} from './plugins'
import { EphemeralState } from './presence'
import { PrefsManager, isPrefLevel } from './prefs'
import { ReadStateManager } from './readstate'
import { searchLocalMessages, searchMessages } from './search'
import type { SecretStore } from './secret-store'
import {
  applyEventsToProjection,
  getMessage,
  getWorkspaceInfo,
  listAttachments,
  listDirectory,
  listFiles,
  listMessages,
  listReactions,
  listStreamsForSidebar,
  listThread,
  listThreadSummaries,
} from './projection'
import { SyncEngine } from './sync'
import { browserWsFactory, type WsFactory, type WsFrame } from './ws'
import {
  MAX_CACHED_EVENTS_PER_STREAM,
  RpcCodedError,
  topicKey,
  type AdminInviteCreateResult,
  type AdminInviteRevokeResult,
  type AdminInvitesResult,
  type AdminMember,
  type AdminMembersResult,
  type AdminWorkspace,
  type ApplyEventsToProjection,
  type AuthResult,
  type AvatarFetchResult,
  type BackfillResult,
  type FileFetchResult,
  type MeProfile,
  type MessageSink,
  type MsgDb,
  type MutateParams,
  type MutateResultUnion,
  type PluginActionResult,
  type PluginBot,
  type PluginBotsResult,
  type PluginHookCreateResult,
  type PluginHooksResult,
  type PluginTokenMintResult,
  type PrefsListResult,
  type PrefsRow,
  type PresenceStatus,
  type PushPayload,
  type QueryParams,
  type QueryResultUnion,
  type ReadStateRow,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type SearchResult,
  type SyncStatus,
  type ToWorker,
  type Topic,
  type UploadAck,
} from './types'

/**
 * The result each RPC method resolves to. ENG-79/80/81 refine `query`/`mutate`
 * here as they add real reads/mutations; the entry keeps handler + call-site
 * types precise with no re-narrowing.
 */
export interface RpcResultMap {
  'meta.get': { key: string; value: unknown }
  ping: { pong: true }
  query: QueryResultUnion
  mutate: MutateResultUnion
  'auth.login': AuthResult
  'auth.setup': AuthResult
  'auth.acceptInvite': AuthResult
  'auth.status': AuthResult
  'auth.logout': { ok: true }
  'sync.status': SyncStatus
  'sync.backfill': BackfillResult
  'sync.start': { ok: true }
  'sync.stop': { ok: true }
  'file.upload': UploadAck
  'file.retry': UploadAck
  'file.cancel': UploadAck
  'file.fetch': FileFetchResult
  // ENG-126 — search (HTTP FTS) + synced-KV read-state/prefs + outbound typing.
  search: SearchResult
  'readState.mark': ReadStateRow
  'prefs.get': PrefsListResult
  'prefs.set': PrefsRow
  'typing.send': { ok: true }
  // ENG-151 — admin HTTP pass-through (live server truth, nothing persisted).
  'admin.members.list': AdminMembersResult
  'admin.members.update': AdminMember
  'admin.invites.list': AdminInvitesResult
  'admin.invites.create': AdminInviteCreateResult
  'admin.invites.revoke': AdminInviteRevokeResult
  // ENG-152 — workspace settings (name + description + icon).
  'admin.workspace.get': AdminWorkspace
  'admin.workspace.update': AdminWorkspace
  'admin.workspace.uploadIcon': AdminWorkspace
  'admin.workspace.clearIcon': AdminWorkspace
  // ENG-176 — plugins HTTP pass-through (bots + incoming webhooks; live
  // server truth, owner/admin-gated server-side, nothing persisted). The
  // mint/create results carry the one-time raw token / capability URL.
  'plugins.bots.list': PluginBotsResult
  'plugins.bots.create': PluginBot
  'plugins.bots.mintToken': PluginTokenMintResult
  'plugins.bots.revokeToken': PluginActionResult
  'plugins.bots.grantStream': PluginActionResult
  'plugins.bots.revokeStream': PluginActionResult
  'plugins.hooks.list': PluginHooksResult
  'plugins.hooks.create': PluginHookCreateResult
  'plugins.hooks.revoke': PluginActionResult
  // Self-profile HTTP pass-through (`/v1/me`) — structurally self-only.
  'me.get': MeProfile
  'me.update': MeProfile
  // ENG-152 profile pictures: self-only avatar writes + the workspace-readable
  // avatar read (worker-side fetch + LRU; only bytes cross to the tab).
  'me.uploadAvatar': MeProfile
  'me.clearAvatar': MeProfile
  'user.avatar': AvatarFetchResult
  // ENG-152 workspace icon: the workspace-readable icon read (worker-side fetch
  // + LRU; only bytes cross to the tab).
  'workspace.icon': AvatarFetchResult
}

/** A handler typed to exactly one method's request variant and result. */
export type RpcHandlerFor<M extends RpcMethod> = (
  req: Extract<RpcRequest, { method: M }>,
  clientId: string,
) => Promise<RpcResultMap[M]>

/** The loose internal shape stored in the registry (over the whole union). */
type AnyRpcHandler = (req: RpcRequest, clientId: string) => Promise<unknown>

interface Subscription {
  clientId: string
  topic: Topic
}

/**
 * WorkerCore construction knobs. The HTTP client is injectable so tests pass a
 * fake `fetch` with no network; the production default is real `fetch` over
 * same-origin relative `/v1` paths (R-f). All three transports construct
 * WorkerCore with no options, so the default path is zero-config.
 */
export interface WorkerCoreOptions {
  /** A fully-formed HTTP client (tests). Wins over `fetchImpl`/`baseUrl`. */
  http?: HttpClient
  /** Inject a fake `fetch` (tests) while keeping the default token wiring. */
  fetchImpl?: typeof fetch
  /** Override the API base URL (default '' → relative same-origin paths). */
  baseUrl?: string
  /**
   * ENG-80's projection build, injected into the sync engine (§3). Default
   * (ENG-81 FOLD-IN): the REAL `applyEventsToProjection` bound to this core's db,
   * so `new WorkerCore(db, sink)` (all three transport entry points) lands live
   * WS events in `messages`. Tests wanting the inert seam inject the no-op.
   */
  applyToProjection?: ApplyEventsToProjection
  /**
   * WS transport factory for the sync engine. Default {@link browserWsFactory}
   * (real `WebSocket`); tests inject a fake so no socket is opened.
   */
  wsFactory?: WsFactory
  /**
   * M6-3 (ENG-167) full-mirror mode (desktop): forward-sync every stream
   * gapless-from-1 and disable bounded-cache eviction (`evictStream` becomes a
   * no-op — a full mirror must never shed events). Default false; the web
   * client's windowed behavior is unchanged.
   */
  fullMirror?: boolean
  /**
   * M6-3 (ENG-167) on-disk workspace mirror (desktop). Injected together with
   * `fullMirror`; the web passes neither, so the mirror is inert there. Also
   * enables {@link WorkerCore.rebuildFromDisk}.
   */
  mirror?: WorkspaceMirror
  /**
   * M6-3 (ENG-167) content-addressed offline blob store (desktop). `file.fetch`
   * tees verified downloaded bytes into it — and serves from it (M6-4) — so
   * attachments open offline.
   */
  blobStore?: BlobCache
  /**
   * M6-4 (ENG-168): where the session token rests. Default: the Dexie-backed
   * `MetaSecretStore` over this core's db — the SAME `meta` rows as before, so
   * the WEB target is unchanged. Desktop cores MUST inject a platform store
   * (OS keychain in M6-5; in-memory in tests) — the token must never live in
   * `projections.sqlite3` inside the portable workspace folder, and
   * `SqliteDb.metaPut` refuses it fail-closed if this is mis-wired.
   */
  secretStore?: SecretStore
  /**
   * M6-4 (ENG-168): connectivity snapshot for the sync engine (`navigator.
   * onLine` semantics). When it reports `false` at start, the engine parks
   * `degraded('offline')` WITHOUT dialing — the cold OFFLINE boot path: init
   * still restores the session (SecretStore is local) and every query/search/
   * send answers locally; {@link WorkerCore.notifyOnline} reconnects. Default
   * assumes online (the web transports rely on WS backoff to ride out drops).
   */
  isOnline?: () => boolean
}

export class WorkerCore {
  private readonly handlers = new Map<RpcMethod, AnyRpcHandler>()
  /** Keyed by the subscription's correlation id. */
  private readonly subs = new Map<string, Subscription>()
  /** The session owner (ENG-78). Holds the token in-memory + persists to `meta`. */
  private readonly auth: AuthManager
  /** The replication loop (ENG-79). Started after auth, stopped on logout. */
  private readonly sync: SyncEngine
  /** The optimistic send + drain loop (ENG-81). */
  private readonly outbox: Outbox
  /** Client file upload/download state machine (ENG-119). */
  private readonly files: FileManager
  /** Channel & member management + DM creation authoring (ENG-104). */
  private readonly meta: MetaAuthor
  /** The worker-side HTTP client — shared by every manager (search reads it directly). */
  private readonly http: HttpClient
  /** Synced-KV read-state mirror (ENG-126) — monotonic, rebuild-exempt, persisted. */
  private readonly readState: ReadStateManager
  /** Synced-KV notification prefs (ENG-126) — LWW, rebuild-exempt, persisted. */
  private readonly prefs: PrefsManager
  /** Ephemeral presence + typing (ENG-126) — memory-only, NO db handle (structural). */
  private readonly ephemeral: EphemeralState
  /** Latest sync state — gates the outbox drain to `live` + detects the rising edge. */
  private syncLive = false
  /** M6-3: full-mirror mode — evictStream is a no-op (the mirror keeps everything). */
  private readonly fullMirror: boolean
  /** M6-3: the on-disk workspace mirror (desktop); undefined on the web (inert). */
  private readonly mirror: WorkspaceMirror | undefined

  constructor(
    private readonly db: MsgDb,
    private readonly sink: MessageSink,
    options: WorkerCoreOptions = {},
  ) {
    // The HTTP client reads the token from — and clears the session through —
    // this same manager. `getToken`/`onUnauthorized` are invoked only at call
    // time (well after construction), so referencing `this.auth` here is safe.
    const http =
      options.http ??
      createHttpClient({
        baseUrl: options.baseUrl ?? '',
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        getToken: () => this.auth.getToken(),
        onUnauthorized: () => {
          // An expired/revoked session clears app-wide AND stops replication.
          this.sync.stop()
          return this.auth.clearSession()
        },
      })
    this.http = http
    // M6-4 (ENG-168): the token's at-rest home rides the SecretStore seam —
    // Dexie `meta` by default (web, unchanged), an injected platform store on
    // the desktop (never inside the portable workspace folder).
    this.auth = new AuthManager(db, http, options.secretStore)
    this.fullMirror = options.fullMirror ?? false
    this.mirror = options.mirror
    this.sync = new SyncEngine({
      http,
      wsFactory: options.wsFactory ?? browserWsFactory,
      db,
      getToken: () => this.auth.getToken(),
      // M6-3 (ENG-167): full-mirror + on-disk NDJSON mirror, desktop-only knobs.
      fullMirror: this.fullMirror,
      ...(this.mirror ? { mirror: this.mirror } : {}),
      // M6-4 (ENG-168): connectivity snapshot — a cold OFFLINE boot parks the
      // engine degraded without dialing; notifyOnline() reconnects.
      ...(options.isOnline ? { isOnline: options.isOnline } : {}),
      // ENG-126: route the four signal frames OUT of the event-sync path. The
      // handler shape-validates each arm defensively (D9); a malformed frame is
      // ignored, never crashing the socket or entering the cursor machinery.
      onSignalFrame: (frame) => this.handleSignalFrame(frame),
      // FOLD-IN (ENG-79/80 wiring gap, §7): default the seam to the REAL
      // projection so live WS events land in `messages`, not just `events`. One
      // constructor change fixes all three transport entry points (they share
      // this constructor). Tests that want the inert seam inject it explicitly.
      applyToProjection:
        options.applyToProjection ??
        ((streamId, events) => applyEventsToProjection(this.db, streamId, events)),
      emitStatus: (status) => this.onSyncStatus(status),
      publishStream: (streamId) =>
        this.publish({ kind: 'stream', stream_id: streamId }, { stream_id: streamId }),
      // ENG-134: same `{kind:'sync'}` fan the AUTHOR path uses (meta's
      // `onStreamsChanged`) — lets the live receiver's new-stream discovery
      // (`triggerNewChannel`) refresh the sidebar for a mid-session DM/channel.
      publishStreamsChanged: () => this.publish({ kind: 'sync' }, this.sync.status()),
    })
    this.outbox = new Outbox({
      db,
      http,
      authStatus: () => this.auth.status(),
      publishStream: (streamId) =>
        this.publish({ kind: 'stream', stream_id: streamId }, { stream_id: streamId }),
      // Only drain when the sync engine is live (§4): an offline/degraded compose
      // sits `queued`; the rising-edge-into-`live` kick (onSyncStatus) sends it.
      canDrain: () => this.syncLive,
    })
    this.files = new FileManager({
      http,
      outbox: this.outbox,
      authStatus: () => this.auth.status(),
      // Fan an upload-progress frame to the tab that subscribed on this upload_id.
      publishUpload: (uploadId, progress) =>
        this.publish({ kind: 'upload', upload_id: uploadId }, progress),
      // M6-3/M6-4: tee verified downloaded bytes into — and serve `file.fetch`
      // from — the content-addressed offline blob store (desktop only; the
      // sha/mime lookup rides the `files` projection).
      ...(options.blobStore
        ? {
            blobStore: options.blobStore,
            lookupFile: async (fileId: string) => {
              const row = await this.db.getFile(fileId)
              return row ? { sha256: row.sha256, mimeType: row.mime_type } : undefined
            },
          }
        : {}),
    })
    this.meta = new MetaAuthor({
      db,
      http,
      authStatus: () => this.auth.status(),
      refreshStreams: () => this.sync.refreshStreams(),
      // A `{kind:'sync'}` fan makes the sidebar re-query streams.list — which is
      // how a NEW stream (no per-stream subscription yet) first appears (ENG-104).
      onStreamsChanged: () => this.publish({ kind: 'sync' }, this.sync.status()),
    })
    // ENG-126 synced-KV managers — hold a db handle, PERSIST, rebuild-exempt.
    this.readState = new ReadStateManager({
      db,
      http,
      publishStream: (streamId) =>
        this.publish({ kind: 'stream', stream_id: streamId }, { stream_id: streamId }),
    })
    this.prefs = new PrefsManager({
      db,
      http,
      publishPrefs: () => {
        void this.prefs.list().then((prefs) => this.publish({ kind: 'prefs' }, { prefs }))
      },
    })
    // ENG-126 ephemeral presence/typing — constructed WITHOUT a db handle (a
    // structural guarantee it cannot persist). `sendTyping` is gated to `live` by
    // the SyncEngine (drops otherwise); the throttle lives in EphemeralState.
    this.ephemeral = new EphemeralState({
      publishPresence: (payload) => this.publish({ kind: 'presence' }, payload),
      publishTyping: (streamId, payload) =>
        this.publish({ kind: 'typing', stream_id: streamId }, payload),
      sendTyping: (streamId) => this.sync.sendTyping(streamId),
    })
    this.registerDefaults()
    this.registerAuth()
    this.registerSync()
    this.registerFiles()
    this.registerSignals()
    this.registerAdmin()
    this.registerPlugins()
    this.registerMe()
  }

  /**
   * ENG-126 signal-frame router. Called by the SyncEngine for the four inbound
   * signal frame types, OUTSIDE the event-sync path. Each arm shape-validates the
   * WIRE frame defensively and ignores a malformed one (D9) — a version-skewed /
   * corrupt frame must never crash the worker or mutate state on bad data.
   */
  private handleSignalFrame(frame: WsFrame): void {
    switch (frame.t) {
      case 'read_state': {
        const f = frame as { stream_id?: unknown; last_read_seq?: unknown }
        if (typeof f.stream_id === 'string' && typeof f.last_read_seq === 'number') {
          void this.readState.applyEcho({ stream_id: f.stream_id, last_read_seq: f.last_read_seq })
        }
        return
      }
      case 'prefs': {
        const f = frame as { stream_id?: unknown; level?: unknown }
        if (typeof f.stream_id === 'string' && isPrefLevel(f.level)) {
          void this.prefs.applyEcho({ stream_id: f.stream_id, level: f.level })
        }
        return
      }
      case 'presence': {
        const f = frame as { user_id?: unknown; status?: unknown }
        if (typeof f.user_id === 'string' && isPresenceStatus(f.status)) {
          this.ephemeral.applyPresence({ user_id: f.user_id, status: f.status })
        }
        return
      }
      case 'typing': {
        const f = frame as { stream_id?: unknown; user_id?: unknown }
        if (typeof f.stream_id === 'string' && typeof f.user_id === 'string') {
          this.ephemeral.applyTyping({ stream_id: f.stream_id, user_id: f.user_id })
        }
        return
      }
    }
  }

  /**
   * Fan a sync status to `{kind:'sync'}` subscribers AND drive the outbox: track
   * `live` for the drain gate, and on the rising edge into `live` (reconnect /
   * first connect) kick the drain so queued offline sends flush themselves (§4).
   */
  private onSyncStatus(status: SyncStatus): void {
    const wasLive = this.syncLive
    this.syncLive = status.state === 'live'
    this.publish({ kind: 'sync' }, status)
    if (!wasLive && this.syncLive) {
      // Rising edge into `live` (first connect / reconnect): kick the outbox drain
      // AND reconcile the synced-KV mirrors from the server (ENG-126). Both are
      // fire-and-forget; a failed fetch is a no-op that the next live edge retries.
      this.outbox.drain()
      void this.readState.bootstrap()
      void this.prefs.bootstrap()
    }
    if (wasLive && !this.syncLive) {
      // Leaving `live` (socket drop / degraded / logout): ephemeral presence +
      // typing do not survive a disconnect — wipe them (re-derived on reconnect).
      this.ephemeral.clearAll()
    }
  }

  /**
   * Run once after construction: reconcile PROJECTION_VERSION (D-4), restore the
   * session, and — if authenticated — start the sync engine (§12 lifecycle).
   */
  async init(): Promise<void> {
    await checkProjectionVersion(this.db)
    await this.auth.restore()
    if (this.auth.getToken()) this.sync.start()
  }

  /**
   * Worker-internal token accessor for the ENG-79 WS connect path (R8). Lives on
   * the core (which the transports own) and is NOT part of the tab-facing RPC
   * surface — no tab can reach it.
   */
  getToken(): string | null {
    return this.auth.getToken()
  }

  /**
   * M6-4 (ENG-168) connectivity edges, delegated to the sync engine. The shell
   * that owns this core (a transport's `online`/`offline` listener, or the
   * desktop host) calls these; `notifyOnline` reconnects a degraded engine
   * immediately, whose rising edge into `live` then drains the outbox and
   * re-pushes locally-advanced read markers (onSyncStatus).
   */
  notifyOnline(): void {
    this.sync.notifyOnline()
  }

  notifyOffline(): void {
    this.sync.notifyOffline()
  }

  /**
   * Extension point for ENG-79/80/81. Per-method generic: `register('query', h)`
   * types `h`'s request as exactly the query variant and its result as the query
   * response — no defensive re-narrowing at the call site. Later registration wins.
   */
  register<M extends RpcMethod>(method: M, handler: RpcHandlerFor<M>): void {
    this.handlers.set(method, handler as AnyRpcHandler)
  }

  /** Route an inbound frame to the right handler and reply via the sink. */
  async handle(clientId: string, msg: ToWorker): Promise<void> {
    switch (msg.t) {
      case 'hello':
        // Client identity/addressing lives in the transports (ports / channel),
        // not in the core; nothing to track here at the shell stage.
        return
      case 'bye':
        this.removeClientSubscriptions(msg.clientId)
        return
      case 'sub':
        this.subs.set(msg.id, { clientId, topic: msg.topic })
        this.sink(clientId, { t: 'res', id: msg.id, ok: true, result: { subscribed: true } })
        return
      case 'unsub':
        this.subs.delete(msg.id)
        this.sink(clientId, { t: 'res', id: msg.id, ok: true, result: { unsubscribed: true } })
        return
      case 'req': {
        const handler = this.handlers.get(msg.req.method)
        if (!handler) {
          this.sink(clientId, {
            t: 'res',
            id: msg.id,
            ok: false,
            error: { code: 'unknown_method', detail: msg.req.method },
          })
          return
        }
        try {
          const result = await handler(msg.req, clientId)
          this.sink(clientId, { t: 'res', id: msg.id, ok: true, result })
        } catch (err) {
          this.sink(clientId, { t: 'res', id: msg.id, ok: false, error: toRpcError(err) })
        }
        return
      }
    }
  }

  /** Fan a push out to every client subscribed to `topic`. */
  publish<T extends Topic>(topic: T, payload: PushPayload<T>): void {
    const key = topicKey(topic)
    for (const sub of this.subs.values()) {
      if (topicKey(sub.topic) === key) {
        this.sink(sub.clientId, { t: 'push', topic, payload })
      }
    }
  }

  /**
   * Bounded-cache eviction (D-6): keep the newest ~MAX events for a stream,
   * delete older. It queries `events` only — it has no `outbox` handle, so it
   * structurally cannot touch pending sends. Not wired into a hot path here
   * (no apply loop until ENG-79); ships proven-safe.
   */
  async evictStream(streamId: string): Promise<void> {
    // M6-3 (ENG-167): a full mirror keeps EVERY event — eviction would punch
    // holes in the gapless local log the on-disk mirror is derived from.
    if (this.fullMirror) return
    const seqs = await this.db.listEventSequences(streamId) // ascending
    if (seqs.length <= MAX_CACHED_EVENTS_PER_STREAM) return
    const cutoff = seqs.length - MAX_CACHED_EVENTS_PER_STREAM
    const toDelete = seqs.slice(0, cutoff)
    await this.db.deleteEventsBySequence(streamId, toDelete)
  }

  /**
   * M6-3 (ENG-167): rebuild-from-disk — §12 invariant 6 EXTENDED to the on-disk
   * NDJSON log (the desktop analogue of `msgctl rebuild`). Drops `events` + the
   * derived tables, repopulates from the mirror's log (each event's
   * `event_hash` re-verified, fail-closed BEFORE anything is dropped), and
   * replays the projections through the SAME `rebuildProjections` the
   * incremental path uses. Requires a configured mirror (desktop).
   */
  async rebuildFromDisk(): Promise<RebuildFromDiskResult> {
    if (!this.mirror) {
      throw new RpcCodedError('no_mirror', 'rebuildFromDisk requires a configured workspace mirror')
    }
    return rebuildFromEventLog(this.db, this.mirror.log)
  }

  /** Drop all subscriptions held by a disconnecting client. */
  private removeClientSubscriptions(clientId: string): void {
    for (const [id, sub] of this.subs) {
      if (sub.clientId === clientId) this.subs.delete(id)
    }
  }

  // -- Default handlers ----------------------------------------------------
  // `ping`/`meta.get` prove the round trip; `query` is the real ENG-80
  // projection dispatcher; `mutate` stays not_implemented until ENG-81.

  private registerDefaults(): void {
    this.register('ping', () => Promise.resolve({ pong: true }))

    this.register('meta.get', async (req) => {
      const value = await this.db.metaGet(req.params.key)
      return { key: req.params.key, value }
    })

    this.register('query', (req) => this.handleQuery(req.params))

    this.register('mutate', (req) => this.handleMutate(req.params))
  }

  /**
   * Mutation dispatcher (ENG-81). Discriminated on `params.m` (exhaustive
   * `switch`, mirroring `handleQuery`), each arm delegating to the `Outbox`. All
   * identity is read worker-side inside the outbox — never from the tab.
   */
  private handleMutate(params: MutateParams): Promise<MutateResultUnion> {
    switch (params.m) {
      case 'outbox.send':
        return this.outbox.send(params)
      case 'outbox.react':
        return this.outbox.react(params)
      case 'outbox.edit':
        return this.outbox.edit(params)
      case 'outbox.remove':
        return this.outbox.remove(params)
      case 'outbox.retry':
        return this.outbox.retry(params.event_id)
      case 'outbox.delete':
        return this.outbox.delete(params.event_id)
      case 'channel.create':
        return this.meta.createChannel(params)
      case 'channel.rename':
        return this.meta.renameChannel(params)
      case 'channel.archive':
        return this.meta.archiveChannel(params)
      case 'channel.addMember':
        return this.meta.addMember(params)
      case 'channel.removeMember':
        return this.meta.removeMember(params)
      case 'dm.create':
        return this.meta.createDm(params)
      default:
        // Exhaustive: a new MutateParams member without a case is a COMPILE error
        // (params narrows to `never`); an out-of-contract `m` throws a coded error.
        return assertNeverMutate(params)
    }
  }

  /**
   * Projection query dispatcher (ENG-80). Reads from the local `messages`
   * projection via projection.ts/badges.ts — never the HTTP API for message
   * data. `myUserId` (for mention badges) comes from the worker-owned session.
   */
  private handleQuery(params: QueryParams): Promise<QueryResultUnion> {
    switch (params.q) {
      case 'messages.list':
        return listMessages(this.db, params.stream_id, {
          ...(params.before_seq !== undefined ? { beforeSeq: params.before_seq } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        })
      case 'streams.list':
        return this.listStreams()
      case 'message.get':
        return getMessage(this.db, params.message_id).then((message) => ({ message }))
      case 'directory.list':
        return listDirectory(this.db)
      case 'workspace.info':
        return getWorkspaceInfo(this.db)
      case 'messages.reactions':
        return listReactions(this.db, params.message_ids, this.auth.status().my_user_id ?? '')
      case 'messages.thread':
        return listThread(this.db, params.root_message_id, {
          ...(params.before_seq !== undefined ? { beforeSeq: params.before_seq } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        })
      case 'messages.threads':
        return listThreadSummaries(this.db, params.root_message_ids)
      case 'attachments.forMessage':
        return listAttachments(this.db, params.message_id)
      case 'files.list':
        return listFiles(this.db)
      default:
        // Exhaustive: a new QueryParams member without a case is a COMPILE error
        // here (params narrows to `never`). At runtime an out-of-contract `q`
        // (e.g. a version-skewed tab) throws → `handle` frames a typed
        // `{ ok: false, error: { code: 'unknown-query' } }`, never a silent
        // `{ ok: true, result: undefined }` the shell would mis-render.
        return assertNeverQuery(params)
    }
  }

  private async listStreams(): Promise<QueryResultUnion> {
    const myUserId = this.auth.status().my_user_id ?? ''
    return { streams: await listStreamsForSidebar(this.db, myUserId) }
  }

  // -- ENG-78 auth handlers ------------------------------------------------
  // Real handlers delegating to the AuthManager (R5). Results are token-free
  // application-level values — a wrong password is NOT an RPC rejection, so the
  // RpcCallError reject path stays reserved for genuine transport/handler faults.

  private registerAuth(): void {
    this.register('auth.login', async (req) => {
      const result = await this.auth.login(req.params)
      if (result.ok) this.sync.start()
      return result
    })
    this.register('auth.setup', async (req) => {
      const result = await this.auth.setup(req.params)
      if (result.ok) this.sync.start()
      return result
    })
    this.register('auth.acceptInvite', async (req) => {
      const result = await this.auth.acceptInvite(req.params)
      if (result.ok) this.sync.start()
      return result
    })
    this.register('auth.logout', async () => {
      this.sync.stop()
      return this.auth.logout()
    })
    this.register('auth.status', () =>
      Promise.resolve({ ok: true, status: this.auth.status() } satisfies AuthResult),
    )
  }

  // -- ENG-79 sync handlers ------------------------------------------------
  // Delegate the four sync.* RPCs to the SyncEngine. `start`/`stop` are
  // idempotent; the engine also auto-starts in `init()`/login and stops on
  // logout, so these are mostly for diagnostics + explicit control.

  private registerSync(): void {
    this.register('sync.status', () => Promise.resolve(this.sync.status()))
    this.register('sync.backfill', (req) => this.sync.backfill(req.params.stream_id))
    this.register('sync.start', () => {
      this.sync.start()
      return Promise.resolve({ ok: true as const })
    })
    this.register('sync.stop', () => {
      this.sync.stop()
      return Promise.resolve({ ok: true as const })
    })
  }

  // -- ENG-119 file handlers -----------------------------------------------
  // Delegate the four file.* RPCs to the FileManager. `upload` returns immediately
  // (progress rides the `{kind:'upload'}` push); `fetch` returns opaque bytes. All
  // `fetch`/token/`/v1/files` logic stays inside the FileManager (token boundary).

  private registerFiles(): void {
    this.register('file.upload', (req) => this.files.startUpload(req.params))
    this.register('file.retry', (req) => this.files.retry(req.params.upload_id))
    this.register('file.cancel', (req) => this.files.cancel(req.params.upload_id))
    this.register('file.fetch', (req) => this.files.fetch(req.params))
  }

  // -- ENG-126 search + read-state/prefs + typing handlers -----------------
  // `search` routes by capability (ENG-166, M6-2): an FTS-capable backend
  // (SqliteDb) answers from the local `messages_fts` index — zero network;
  // Dexie/Memory (fts:false) keep the ENG-126 HTTP FTS read (token
  // worker-side), byte-identical behavior to before. `readState.mark`/`prefs.*`
  // drive the synced-KV managers; `typing.send` is a fire-and-forget ephemeral
  // signal (client-throttled in EphemeralState, dropped by SyncEngine when offline).

  private registerSignals(): void {
    this.register('search', (req) =>
      this.db.capabilities.fts
        ? searchLocalMessages(this.db, req.params)
        : searchMessages(this.http, req.params),
    )
    this.register('readState.mark', (req) =>
      this.readState.mark(req.params.stream_id, req.params.last_read_seq),
    )
    this.register('prefs.get', async () => ({ prefs: await this.prefs.list() }))
    this.register('prefs.set', (req) => this.prefs.set(req.params.stream_id, req.params.level))
    this.register('typing.send', (req) => {
      this.ephemeral.sendTyping(req.params.stream_id)
      return Promise.resolve({ ok: true as const })
    })
  }

  // -- ENG-151 admin handlers ----------------------------------------------
  // HTTP pass-through over the shared authed http client (admin.ts), like
  // `search`: live server truth, owner/admin-gated server-side, and NOTHING
  // persisted locally. A 403/404/422 surfaces as a coded RPC error.

  private registerAdmin(): void {
    this.register('admin.members.list', () => listAdminMembers(this.http))
    this.register('admin.members.update', (req) => updateAdminMember(this.http, req.params))
    this.register('admin.invites.list', () => listAdminInvites(this.http))
    this.register('admin.invites.create', (req) => createAdminInvite(this.http, req.params))
    this.register('admin.invites.revoke', (req) => revokeAdminInvite(this.http, req.params))
    // ENG-152 workspace settings — the PATCH also emits the server-authored
    // `workspace.updated` meta event; the local `workspace.info` fold picks it
    // up through normal sync, so nothing is persisted here either.
    this.register('admin.workspace.get', () => getAdminWorkspace(this.http))
    this.register('admin.workspace.update', (req) => updateAdminWorkspace(this.http, req.params))
    // ENG-152 workspace icon — the upload's Blob arrived by structured clone;
    // the worker POSTs the raw bytes (token attached here, never tab-side). The
    // resulting `workspace.updated` meta event syncs back and updates the
    // `workspace.info` fold, which is how every member's rail sees the new icon.
    this.register('admin.workspace.uploadIcon', (req) =>
      uploadWorkspaceIcon(this.http, req.params.blob),
    )
    this.register('admin.workspace.clearIcon', () => clearWorkspaceIcon(this.http))
  }

  // -- ENG-176 plugins handlers ----------------------------------------------
  // HTTP pass-through over the shared authed http client (plugins.ts), the
  // admin discipline verbatim: live server truth, owner/admin-gated
  // server-side, NOTHING persisted locally. The mint/create results carry the
  // one-time raw token / capability URL straight through to the facade — this
  // core never stores, caches, or logs either. A 403/404/422 surfaces as a
  // coded RPC error.

  private registerPlugins(): void {
    this.register('plugins.bots.list', () => listPluginBots(this.http))
    this.register('plugins.bots.create', (req) => createPluginBot(this.http, req.params))
    this.register('plugins.bots.mintToken', (req) => mintPluginBotToken(this.http, req.params))
    this.register('plugins.bots.revokeToken', (req) => revokePluginBotToken(this.http, req.params))
    this.register('plugins.bots.grantStream', (req) => grantPluginBotStream(this.http, req.params))
    this.register('plugins.bots.revokeStream', (req) =>
      revokePluginBotStream(this.http, req.params),
    )
    this.register('plugins.hooks.list', () => listPluginHooks(this.http))
    this.register('plugins.hooks.create', (req) => createPluginHook(this.http, req.params))
    this.register('plugins.hooks.revoke', (req) => revokePluginHook(this.http, req.params))
  }

  // -- Self-profile handlers -------------------------------------------------
  // HTTP pass-through over the shared authed http client (me.ts), mirroring
  // the admin arms: live server truth, structurally self-only server-side,
  // NOTHING persisted locally. The rename a successful `me.update` causes
  // reaches the local directory via the normal sync path (the server appends
  // `user.profile_updated` to workspace-meta). A 401/422 surfaces as a coded
  // RPC error.

  private registerMe(): void {
    this.register('me.get', () => getMe(this.http))
    this.register('me.update', (req) => updateMe(this.http, req.params))
    // ENG-152 profile pictures. The upload's Blob arrived by structured clone;
    // the worker POSTs the raw bytes (token attached here, never tab-side).
    // The resulting `user.profile_updated` meta event syncs back and updates
    // the directory fold, which is how every OTHER member sees the new face.
    this.register('me.uploadAvatar', (req) => uploadAvatar(this.http, req.params.blob))
    this.register('me.clearAvatar', () => clearAvatar(this.http))
    this.register('user.avatar', (req) => this.files.fetchAvatar(req.params))
    // ENG-152 workspace icon read: worker-side fetch + LRU, only bytes cross.
    this.register('workspace.icon', (req) => this.files.fetchWorkspaceIcon(req.params))
  }
}

/** Narrow an inbound presence `status` to the legal set (reject malformed, D9). */
function isPresenceStatus(v: unknown): v is PresenceStatus {
  return v === 'online' || v === 'offline'
}

/**
 * Exhaustiveness guard for the query dispatcher: unreachable for an in-contract
 * `q`, so `params` narrows to `never` (a missing case is a compile error). At
 * runtime it throws a coded error `handle` turns into a clean `unknown-query`
 * frame rather than resolving `undefined`.
 */
function assertNeverQuery(params: never): never {
  throw new RpcCodedError('unknown-query', `unhandled query: ${JSON.stringify(params)}`)
}

/** Exhaustiveness guard for the mutation dispatcher (mirror of `assertNeverQuery`). */
function assertNeverMutate(params: never): never {
  throw new RpcCodedError('unknown-mutation', `unhandled mutation: ${JSON.stringify(params)}`)
}

function toRpcError(err: unknown): RpcError {
  if (err instanceof RpcCodedError) {
    return { code: err.code, detail: err.message }
  }
  return {
    code: 'handler_error',
    detail: err instanceof Error ? err.message : String(err),
  }
}
