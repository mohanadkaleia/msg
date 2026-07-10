// worker/client.ts — the single entry the stores call (D-1). Feature-detects
// the transport once (SharedWorker → leader → solo), wires the RPC caller, and
// returns the ONE WorkerClient whose surface is identical across all three.
//
// `makeWorkerClient` and `detectTransportKind` are exported so the transport
// selection and the client surface are unit-testable without a browser.

import { WorkerCore } from './core'
import { openDb } from './db'
import { createLeaderTransport } from './leader'
import { createRpcCaller } from './rpc'
import {
  type AcceptInviteCredentials,
  type AdminInviteCreateParams,
  type AdminInviteCreateResult,
  type AdminInviteRevokeResult,
  type AdminInvitesResult,
  type AdminMember,
  type AdminMembersResult,
  type AdminMemberUpdateParams,
  type AdminWorkspace,
  type AdminWorkspaceUpdateParams,
  type AuthResult,
  type AuthStatus,
  type BackfillResult,
  type AvatarFetchResult,
  type FileFetchResult,
  type FilesListResult,
  type FileUploadParams,
  type FromWorker,
  type LoginCredentials,
  type MeProfile,
  type MeUpdateParams,
  type MsgDb,
  type MutateParams,
  type MutateResult,
  type PrefLevel,
  type PrefsListResult,
  type PrefsRow,
  type PresencePush,
  type PushPayload,
  type QueryParams,
  type QueryResult,
  type ReadStateRow,
  type SearchParams,
  type SearchResult,
  type SetupCredentials,
  type SyncStatus,
  type Topic,
  type ToWorker,
  type Transport,
  type TypingPush,
  type Unsubscribe,
  type UploadAck,
  type UploadProgress,
  type WorkerClient,
  type WorkerStatus,
} from './types'

const CHANNEL_NAME = 'msg-worker'

// ---------------------------------------------------------------------------
// Feature detection (D-1).
// ---------------------------------------------------------------------------

export interface WorkerEnv {
  hasSharedWorker: boolean
  hasLocks: boolean
  hasBroadcastChannel: boolean
}

/**
 * Choose the transport: SharedWorker if present; else a Web Locks leader if
 * both locks and BroadcastChannel exist; else a degenerate single-tab `solo`
 * (no cross-tab coherence — acceptable long tail, risk 7).
 */
export function detectTransportKind(env: WorkerEnv): WorkerStatus['transport'] {
  if (env.hasSharedWorker) return 'shared-worker'
  if (env.hasLocks && env.hasBroadcastChannel) return 'leader'
  return 'solo'
}

function currentEnv(): WorkerEnv {
  return {
    hasSharedWorker: typeof SharedWorker !== 'undefined',
    hasLocks: typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks != null,
    hasBroadcastChannel: typeof BroadcastChannel !== 'undefined',
  }
}

// ---------------------------------------------------------------------------
// The client surface — identical over any Transport.
// ---------------------------------------------------------------------------

export function makeWorkerClient(clientId: string, transport: Transport): WorkerClient {
  const caller = createRpcCaller(clientId, (f) => {
    transport.post(f)
  })
  transport.onFrame((f) => {
    caller.handleFrame(f)
  })

  return {
    ready: () => transport.ready(),
    query<Q extends QueryParams>(params: Q): Promise<QueryResult<Q>> {
      return caller.request({ method: 'query', params }) as Promise<QueryResult<Q>>
    },
    mutate<M extends MutateParams>(params: M): Promise<MutateResult<M>> {
      return caller.request({ method: 'mutate', params }) as Promise<MutateResult<M>>
    },
    subscribe<T extends Topic>(topic: T, handler: (payload: PushPayload<T>) => void): Unsubscribe {
      return caller.subscribe(topic, (payload) => {
        handler(payload as PushPayload<T>)
      })
    },
    status: () => transport.status(),
    onStatus: (h) => transport.onStatus(h),
    // The auth namespace keeps stores off the wire (R5). Every result is
    // token-free; credentials cross tab→worker over structured-clone postMessage.
    auth: {
      login: (c: LoginCredentials) =>
        caller.request({ method: 'auth.login', params: c }) as Promise<AuthResult>,
      setup: (c: SetupCredentials) =>
        caller.request({ method: 'auth.setup', params: c }) as Promise<AuthResult>,
      acceptInvite: (c: AcceptInviteCredentials) =>
        caller.request({ method: 'auth.acceptInvite', params: c }) as Promise<AuthResult>,
      logout: () => caller.request({ method: 'auth.logout', params: {} }) as Promise<{ ok: true }>,
      status: () =>
        (caller.request({ method: 'auth.status', params: {} }) as Promise<AuthResult>).then((r) =>
          r.ok ? r.status : ({ authenticated: false } satisfies AuthStatus),
        ),
    },
    // Thin accessors over the existing sync.* RPC handlers (ENG-79). The shell
    // reads the initial status + drives scrollback backfill through these; the
    // live status stream still arrives on the `{kind:'sync'}` push subscription.
    sync: {
      status: () => caller.request({ method: 'sync.status', params: {} }) as Promise<SyncStatus>,
      backfill: (streamId: string) =>
        caller.request({
          method: 'sync.backfill',
          params: { stream_id: streamId },
        }) as Promise<BackfillResult>,
    },
    // Files namespace (ENG-119): thin wrappers over the worker file.* RPCs. The tab
    // mints `upload_id` and subscribes via `onProgress` BEFORE `upload` (no
    // lost-first-frame race); `download`/`thumbnail` return opaque bytes only. Every
    // `fetch`/token/`/v1/files` call is worker-side — nothing token-ish crosses here.
    files: {
      upload: (params: FileUploadParams) =>
        caller.request({ method: 'file.upload', params }) as Promise<UploadAck>,
      retry: (uploadId: string) =>
        caller.request({
          method: 'file.retry',
          params: { upload_id: uploadId },
        }) as Promise<UploadAck>,
      cancel: (uploadId: string) =>
        caller.request({
          method: 'file.cancel',
          params: { upload_id: uploadId },
        }) as Promise<UploadAck>,
      download: (fileId: string) =>
        caller.request({
          method: 'file.fetch',
          params: { file_id: fileId, variant: 'blob' },
        }) as Promise<FileFetchResult>,
      thumbnail: (fileId: string) =>
        caller.request({
          method: 'file.fetch',
          params: { file_id: fileId, variant: 'thumbnail' },
        }) as Promise<FileFetchResult>,
      // ENG-152: the workspace file listing — a LOCAL projection read routed over
      // the existing `query` verb (zero network, zero token exposure), surfaced
      // here so the Files view reads `client.files.list()` like its siblings.
      list: () =>
        caller.request({
          method: 'query',
          params: { q: 'files.list' },
        }) as Promise<FilesListResult>,
      onProgress: (uploadId: string, cb: (payload: UploadProgress) => void): Unsubscribe =>
        caller.subscribe({ kind: 'upload', upload_id: uploadId }, (payload) => {
          cb(payload as UploadProgress)
        }),
    },
    // Search (ENG-126): the ONE read routed over HTTP (server FTS), not the local
    // projection. The token stays worker-side; the tab passes only filters + cursor.
    search: (params: SearchParams) =>
      caller.request({ method: 'search', params }) as Promise<SearchResult>,
    // Admin (ENG-151): HTTP pass-through over the worker's authed client. The
    // tab sees plain data only — no token, URL, or `/v1/` path crosses here;
    // owner/admin gating and 403/404/422 semantics are server truth surfaced
    // as coded RpcCallErrors (`forbidden` / `not-found` / `validation-error`).
    admin: {
      members: {
        list: () =>
          caller.request({
            method: 'admin.members.list',
            params: {},
          }) as Promise<AdminMembersResult>,
        update: (params: AdminMemberUpdateParams) =>
          caller.request({ method: 'admin.members.update', params }) as Promise<AdminMember>,
      },
      invites: {
        list: () =>
          caller.request({
            method: 'admin.invites.list',
            params: {},
          }) as Promise<AdminInvitesResult>,
        create: (params: AdminInviteCreateParams) =>
          caller.request({
            method: 'admin.invites.create',
            params,
          }) as Promise<AdminInviteCreateResult>,
        revoke: (params: { id: string }) =>
          caller.request({
            method: 'admin.invites.revoke',
            params,
          }) as Promise<AdminInviteRevokeResult>,
      },
      // ENG-152 workspace settings (name + description + icon). Writes ALSO land
      // on every member's shell via the server-authored `workspace.updated` meta
      // event the local `workspace.info` fold reads.
      workspace: {
        get: () =>
          caller.request({
            method: 'admin.workspace.get',
            params: {},
          }) as Promise<AdminWorkspace>,
        update: (params: AdminWorkspaceUpdateParams) =>
          caller.request({
            method: 'admin.workspace.update',
            params,
          }) as Promise<AdminWorkspace>,
        // ENG-152: the icon Blob crosses by structured clone; the worker owns the
        // POST (raw bytes + bearer). The echoed row carries the new icon sha.
        uploadIcon: (blob: Blob) =>
          caller.request({
            method: 'admin.workspace.uploadIcon',
            params: { blob },
          }) as Promise<AdminWorkspace>,
        clearIcon: () =>
          caller.request({
            method: 'admin.workspace.clearIcon',
            params: {},
          }) as Promise<AdminWorkspace>,
      },
    },
    // Self-profile (`/v1/me`): HTTP pass-through mirroring `admin` — the tab
    // sees plain profile data only (no token/URL crosses here), and the server
    // is structurally self-only (no user_id parameter exists on this surface).
    me: {
      get: () => caller.request({ method: 'me.get', params: {} }) as Promise<MeProfile>,
      update: (params: MeUpdateParams) =>
        caller.request({ method: 'me.update', params }) as Promise<MeProfile>,
      // ENG-152: the avatar Blob crosses by structured clone; the worker owns
      // the POST (raw bytes + bearer). The echoed profile carries the new sha.
      uploadAvatar: (blob: Blob) =>
        caller.request({ method: 'me.uploadAvatar', params: { blob } }) as Promise<MeProfile>,
      clearAvatar: () =>
        caller.request({ method: 'me.clearAvatar', params: {} }) as Promise<MeProfile>,
    },
    // Other-user reads (ENG-152): a member's avatar bytes via the workspace-
    // readable serve endpoint — worker-side fetch + LRU keyed by the directory
    // sha; the tab mints the object URL (useAvatarUrl).
    users: {
      avatar: (userId: string, avatarSha256: string) =>
        caller.request({
          method: 'user.avatar',
          params: { user_id: userId, avatar_sha256: avatarSha256 },
        }) as Promise<AvatarFetchResult>,
    },
    // Workspace-scoped reads (ENG-152): the caller's OWN workspace icon bytes via
    // the workspace-readable serve endpoint — worker-side fetch + LRU keyed by
    // the folded icon sha; the tab mints the object URL (useWorkspaceIconUrl).
    workspace: {
      icon: (iconSha256: string) =>
        caller.request({
          method: 'workspace.icon',
          params: { icon_sha256: iconSha256 },
        }) as Promise<AvatarFetchResult>,
    },
    // Read-state (ENG-126): `mark` clears the unread/mention badge (optimistic +
    // monotonic worker-side; the `{kind:'stream'}` push re-derives the badge).
    readState: {
      mark: (streamId: string, seq: number) =>
        caller.request({
          method: 'readState.mark',
          params: { stream_id: streamId, last_read_seq: seq },
        }) as Promise<ReadStateRow>,
    },
    // Notification prefs (ENG-126): synced-KV get/set (LWW); changes fan `{kind:'prefs'}`.
    prefs: {
      get: () => caller.request({ method: 'prefs.get', params: {} }) as Promise<PrefsListResult>,
      set: (streamId: string, level: PrefLevel) =>
        caller.request({
          method: 'prefs.set',
          params: { stream_id: streamId, level },
        }) as Promise<PrefsRow>,
    },
    // Presence (ENG-126): ephemeral, memory-only, workspace-wide. Subscribe seeds
    // from the current in-memory snapshot on its first push (no HTTP seed).
    presence: {
      subscribe: (cb: (payload: PresencePush) => void): Unsubscribe =>
        caller.subscribe({ kind: 'presence' }, (payload) => {
          cb(payload as PresencePush)
        }),
    },
    // Typing (ENG-126): ephemeral, per-stream. `send` emits a throttled outbound
    // signal (dropped when offline); `subscribe` receives the auto-expiring set.
    typing: {
      subscribe: (streamId: string, cb: (payload: TypingPush) => void): Unsubscribe =>
        caller.subscribe({ kind: 'typing', stream_id: streamId }, (payload) => {
          cb(payload as TypingPush)
        }),
      send: (streamId: string) =>
        caller.request({
          method: 'typing.send',
          params: { stream_id: streamId },
        }) as Promise<{ ok: true }>,
    },
    dispose: () => {
      caller.dispose()
      transport.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// Transports.
// ---------------------------------------------------------------------------

/** Degenerate single-tab transport: WorkerCore in-page, no election, no channel. */
export async function createSoloTransport(
  clientId: string,
  openDbFn: () => Promise<MsgDb>,
): Promise<Transport> {
  const db = await openDbFn()
  let frameHandler: ((f: FromWorker) => void) | undefined
  const core = new WorkerCore(db, (targetClientId, msg) => {
    if (targetClientId === clientId) frameHandler?.(msg)
  })
  await core.init()
  void core.handle(clientId, { t: 'hello', clientId })
  const status: WorkerStatus = { transport: 'solo', db: db.persistence, role: 'n/a' }

  return {
    post: (f) => {
      void core.handle(clientId, f)
    },
    onFrame: (cb) => {
      frameHandler = cb
    },
    ready: () => Promise.resolve(),
    status: () => status,
    onStatus: () => () => {
      /* solo status is static */
    },
    dispose: () => {
      void core.handle(clientId, { t: 'bye', clientId })
      void db.close()
    },
  }
}

/** SharedWorker transport (browser only; smoke-tested in ENG-83). */
function createSharedWorkerTransport(clientId: string): Transport {
  const worker = new SharedWorker(new URL('./shared-worker.ts', import.meta.url), {
    type: 'module',
  })
  const port = worker.port
  port.start()
  let frameHandler: ((f: FromWorker) => void) | undefined
  port.onmessage = (ev: MessageEvent<FromWorker>): void => {
    frameHandler?.(ev.data)
  }
  const hello: ToWorker = { t: 'hello', clientId }
  port.postMessage(hello)
  const status: WorkerStatus = {
    transport: 'shared-worker',
    db: typeof indexedDB !== 'undefined' ? 'persistent' : 'memory',
    role: 'n/a',
  }

  return {
    post: (f) => {
      port.postMessage(f)
    },
    onFrame: (cb) => {
      frameHandler = cb
    },
    ready: () => Promise.resolve(),
    status: () => status,
    onStatus: () => () => {
      /* shared-worker status is static at this layer */
    },
    dispose: () => {
      const bye: ToWorker = { t: 'bye', clientId }
      port.postMessage(bye)
      port.close()
    },
  }
}

// ---------------------------------------------------------------------------
// The factory the stores call.
// ---------------------------------------------------------------------------

export interface CreateWorkerClientOptions {
  /** Override feature detection (tests). */
  env?: WorkerEnv
  /** Override the DB boot (tests / degraded control). */
  openDb?: () => Promise<MsgDb>
  /** Override the client id (tests). */
  clientId?: string
}

export async function createWorkerClient(
  options: CreateWorkerClientOptions = {},
): Promise<WorkerClient> {
  const env = options.env ?? currentEnv()
  const clientId = options.clientId ?? crypto.randomUUID()
  const openDbFn = options.openDb ?? (() => openDb())
  const kind = detectTransportKind(env)

  let transport: Transport
  switch (kind) {
    case 'shared-worker':
      transport = createSharedWorkerTransport(clientId)
      break
    case 'leader':
      transport = createLeaderTransport({
        clientId,
        // Real LockManager / BroadcastChannel satisfy the injected interfaces.
        locks: navigator.locks,
        channel: new BroadcastChannel(CHANNEL_NAME),
        openDb: openDbFn,
      })
      break
    case 'solo':
      transport = await createSoloTransport(clientId, openDbFn)
      break
  }

  const client = makeWorkerClient(clientId, transport)
  await client.ready()
  return client
}

// ---------------------------------------------------------------------------
// Module-level singleton (ENG-78). The tab creates exactly one WorkerClient for
// the page; stores and the router guard consume it via `getWorkerClient()`. This
// is the M2 seam intent — ENG-82 may swap it for provide/inject.
// ---------------------------------------------------------------------------

let clientPromise: Promise<WorkerClient> | undefined

/** The one WorkerClient for this tab, created lazily on first use. */
export function getWorkerClient(): Promise<WorkerClient> {
  if (!clientPromise) clientPromise = createWorkerClient()
  return clientPromise
}
