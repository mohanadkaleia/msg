// worker/auth.ts — the AuthManager (ENG-78, R6): the single owner of the session
// token, worker-side. It drives the server auth endpoints via the injected
// HttpClient, persists the session + device_id in the Dexie `meta` table for
// reload survival, and exposes the token ONLY worker-internally — to the HTTP
// client (Authorization: Bearer) and, later, the ENG-79 WS connect.
//
// The token lives in exactly two places, both worker-side: this manager's
// in-memory `session` and the `meta` KV rows. It is NEVER returned to a tab over
// RPC, rendered, or logged (R1). `login/setup/acceptInvite/status` return
// token-free results.
//
// ── ENG-79 (sync engine, worker-side ONLY) — WS connect contract (R8, TDD §3.3):
//     const token = auth.getToken()
//     new WebSocket(wsUrl, ['bearer', token])   // Sec-WebSocket-Protocol: bearer, <token>
//   NOT `?token=` — the raw token must never appear in a URL. No socket is opened
//   in ENG-78; this manager only exposes `getToken()` for that later path.

import type { ApiError, HttpClient } from './http'
import {
  META_DEVICE_ID,
  META_MY_USER_ID,
  META_ROLE,
  META_SESSION_EXPIRES_AT,
  META_SESSION_TOKEN,
  META_WORKSPACE_ID,
  type AcceptInviteCredentials,
  type AuthResult,
  type AuthStatus,
  type LoginCredentials,
  type MsgDb,
  type SetupCredentials,
} from './types'

/** The server's `LoginResponse` — the raw token is returned exactly once, here. */
interface LoginResponse {
  token: string
  user_id: string
  device_id: string
  workspace_id: string
  role: string
  /** RFC 3339 timestamp string over the wire. */
  expires_at: string
}

/** In-memory session — the single owner of the token (R1). */
interface SessionState {
  token: string
  myUserId: string
  workspaceId: string
  role: string
  expiresAt: string
}

export class AuthManager {
  private session: SessionState | null = null

  constructor(
    private readonly db: MsgDb,
    private readonly http: HttpClient,
  ) {}

  /**
   * Hydrate the in-memory session from `meta` (run in WorkerCore.init after the
   * projection-version check). Enables reload persistence (R6).
   */
  async restore(): Promise<void> {
    const token = await this.db.metaGet<string>(META_SESSION_TOKEN)
    if (!token) return
    const [myUserId, workspaceId, role, expiresAt] = await Promise.all([
      this.db.metaGet<string>(META_MY_USER_ID),
      this.db.metaGet<string>(META_WORKSPACE_ID),
      this.db.metaGet<string>(META_ROLE),
      this.db.metaGet<string>(META_SESSION_EXPIRES_AT),
    ])
    this.session = {
      token,
      myUserId: myUserId ?? '',
      workspaceId: workspaceId ?? '',
      role: role ?? '',
      expiresAt: expiresAt ?? '',
    }
  }

  /**
   * Worker-internal token accessor for the HTTP client and (R8) the ENG-79 WS
   * connect. NOT reachable from any tab — the RPC surface never calls it.
   */
  getToken(): string | null {
    return this.session?.token ?? null
  }

  /** Token-free identity for the tab side (R1). */
  status(): AuthStatus {
    if (!this.session) return { authenticated: false }
    return {
      authenticated: true,
      my_user_id: this.session.myUserId,
      workspace_id: this.session.workspaceId,
      role: this.session.role,
      expires_at: this.session.expiresAt,
    }
  }

  /** POST /v1/auth/login with device_id/label rules (R3); persist on success. */
  async login(c: LoginCredentials): Promise<AuthResult> {
    const deviceId = await this.db.metaGet<string>(META_DEVICE_ID)
    const deviceLabel = deriveDeviceLabel()

    let res = await this.http.post<LoginResponse>(
      '/v1/auth/login',
      {
        email: c.email,
        password: c.password,
        device_label: deviceLabel,
        ...(deviceId ? { device_id: deviceId } : {}),
      },
      { authed: false },
    )

    // Self-heal on `invalid-device` (R3): a stored device_id the server rejects
    // (pruned, or belongs to a different user on a shared machine) → drop it and
    // retry once fresh so the server mints a new one.
    if (!res.ok && res.error.code === 'invalid-device' && deviceId) {
      await this.db.metaPut(META_DEVICE_ID, undefined)
      res = await this.http.post<LoginResponse>(
        '/v1/auth/login',
        { email: c.email, password: c.password, device_label: deviceLabel },
        { authed: false },
      )
    }

    return this.finish(res)
  }

  /** POST /v1/setup (first-run). Server mints the device unconditionally. */
  async setup(c: SetupCredentials): Promise<AuthResult> {
    const res = await this.http.post<LoginResponse>(
      '/v1/setup',
      {
        workspace_name: c.workspace_name,
        email: c.email,
        password: c.password,
        display_name: c.display_name,
      },
      { authed: false },
    )
    return this.finish(res)
  }

  /** POST /v1/auth/accept-invite. No device fields — server mints (label None). */
  async acceptInvite(c: AcceptInviteCredentials): Promise<AuthResult> {
    const res = await this.http.post<LoginResponse>(
      '/v1/auth/accept-invite',
      { token: c.token, email: c.email, display_name: c.display_name, password: c.password },
      { authed: false },
    )
    return this.finish(res)
  }

  /**
   * Clear the session (in-memory token + session `meta` rows), KEEP `device_id`,
   * and FULL-wipe the local projections so a shared machine does not leak cached
   * data to the next user (R6/R7). This is a full local reset: the DERIVED tables
   * (`clearDerivedTables`) AND the SYNCED-KV tables (`clearSyncedKv` — `read_state`
   * + `prefs`, ENG-126). The two wipes stay SEPARATE by design: a projection-version
   * rebuild clears ONLY derived tables and PRESERVES synced-KV (server-owned per-user
   * state), whereas logout must additionally wipe synced-KV — the previous user's
   * read positions / notification levels must not survive for the next user.
   *
   * A best-effort server-side revoke is out of scope here (no bulk-logout
   * endpoint); a future ticket can revoke the current session via
   * DELETE /v1/auth/sessions/{id}.
   */
  async logout(): Promise<{ ok: true }> {
    await this.clearSession()
    await this.db.clearDerivedTables()
    await this.db.clearSyncedKv()
    return { ok: true }
  }

  /**
   * Drop the in-memory token and the session `meta` rows. KEEPS `device_id`
   * (browser-install identity, reused on next login). Wired as the HTTP client's
   * `onUnauthorized` — a 401 on any authed call clears the session app-wide (R6).
   */
  async clearSession(): Promise<void> {
    this.session = null
    await Promise.all([
      this.db.metaPut(META_SESSION_TOKEN, undefined),
      this.db.metaPut(META_MY_USER_ID, undefined),
      this.db.metaPut(META_WORKSPACE_ID, undefined),
      this.db.metaPut(META_ROLE, undefined),
      this.db.metaPut(META_SESSION_EXPIRES_AT, undefined),
    ])
  }

  /** Persist a successful login and set the in-memory session, else pass the error. */
  private async finish(res: ApiResultLogin): Promise<AuthResult> {
    if (!res.ok) return { ok: false, error: res.error }
    await this.persistSession(res.value)
    return { ok: true, status: this.status() }
  }

  private async persistSession(r: LoginResponse): Promise<void> {
    this.session = {
      token: r.token,
      myUserId: r.user_id,
      workspaceId: r.workspace_id,
      role: r.role,
      expiresAt: r.expires_at,
    }
    await Promise.all([
      this.db.metaPut(META_SESSION_TOKEN, r.token),
      this.db.metaPut(META_DEVICE_ID, r.device_id),
      this.db.metaPut(META_MY_USER_ID, r.user_id),
      this.db.metaPut(META_WORKSPACE_ID, r.workspace_id),
      this.db.metaPut(META_ROLE, r.role),
      this.db.metaPut(META_SESSION_EXPIRES_AT, r.expires_at),
    ])
  }
}

type ApiResultLogin = { ok: true; value: LoginResponse } | { ok: false; error: ApiError }

/**
 * A coarse, human-readable device label from the environment (R3, R-a). Bounded
 * to the server's 200-char limit with a safe non-empty fallback so the required
 * `device_label` field never validation-fails. Cosmetic (shown in the sessions
 * list) — not security-relevant.
 */
export function deriveDeviceLabel(ua?: string): string {
  const s = ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  if (!s) return 'Web browser'
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /Firefox\//.test(s)
        ? 'Firefox'
        : /Chrome\//.test(s)
          ? 'Chrome'
          : /Safari\//.test(s)
            ? 'Safari'
            : 'Browser'
  const os = /Mac OS X|Macintosh/.test(s)
    ? 'macOS'
    : /Windows/.test(s)
      ? 'Windows'
      : /Android/.test(s)
        ? 'Android'
        : /iPhone|iPad|iPod/.test(s)
          ? 'iOS'
          : /Linux/.test(s)
            ? 'Linux'
            : 'Web'
  return `${browser} on ${os}`.slice(0, 200)
}
