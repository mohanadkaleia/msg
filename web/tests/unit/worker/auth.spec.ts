import { describe, expect, it } from 'vitest'

import { AuthManager, deriveDeviceLabel } from '../../../src/worker/auth'
import { WorkerCore } from '../../../src/worker/core'
import { MemoryDb, openDb } from '../../../src/worker/db'
import { createHttpClient, type HttpClient } from '../../../src/worker/http'
import {
  META_DEVICE_ID,
  META_MY_USER_ID,
  META_ROLE,
  META_SESSION_EXPIRES_AT,
  META_SESSION_TOKEN,
  META_WORKSPACE_ID,
  type FromWorker,
  type MsgDb,
} from '../../../src/worker/types'

import { collectingSink, fakeIdbOptions, inertWsFactory } from './helpers'

const TOKEN = 'sess-tok-SECRET-do-not-leak-42'

/** Extract a URL string from any fetch input without base-to-string on a Request. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

interface CapturedRequest {
  url: string
  method: string
  body: Record<string, unknown> | undefined
  headers: Record<string, string> | undefined
}

function loginResponse(overrides: Record<string, unknown> = {}): Response {
  const payload = {
    token: TOKEN,
    user_id: 'user-1',
    device_id: 'dev-fresh',
    workspace_id: 'ws-1',
    role: 'owner',
    expires_at: '2026-10-01T00:00:00Z',
    ...overrides,
  }
  return new Response(JSON.stringify(payload), { status: 200 })
}

function problem(status: number, slug: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ type: `/problems/${slug}`, title: slug, status }), {
    status,
    ...(headers ? { headers } : {}),
  })
}

/** A scriptable fake `fetch` that records every request. */
function makeFetch(responder: (req: CapturedRequest, n: number) => Response): {
  fetchImpl: typeof fetch
  requests: CapturedRequest[]
} {
  const requests: CapturedRequest[] = []
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = typeof init?.body === 'string' ? init.body : undefined
    const req: CapturedRequest = {
      url: urlOf(input),
      method: init?.method ?? 'GET',
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : undefined,
      headers: init?.headers as Record<string, string> | undefined,
    }
    requests.push(req)
    return Promise.resolve(responder(req, requests.length - 1))
  }) as typeof fetch
  return { fetchImpl, requests }
}

/** Wire an AuthManager + its real HttpClient over the fake fetch (self-referencing token). */
function makeManager(
  db: MsgDb,
  fetchImpl: typeof fetch,
): { manager: AuthManager; http: HttpClient } {
  const holder: { manager: AuthManager | null } = { manager: null }
  const http = createHttpClient({
    fetchImpl,
    getToken: () => holder.manager?.getToken() ?? null,
    onUnauthorized: () => holder.manager?.clearSession(),
  })
  const manager = new AuthManager(db, http)
  holder.manager = manager
  return { manager, http }
}

describe('AuthManager.login', () => {
  it('stores token + device_id + identity in meta (MemoryDb)', async () => {
    const db = new MemoryDb()
    const { fetchImpl } = makeFetch(() => loginResponse())
    const { manager } = makeManager(db, fetchImpl)

    const res = await manager.login({ email: 'a@b.co', password: 'password1234' })

    expect(res.ok).toBe(true)
    expect(await db.metaGet(META_SESSION_TOKEN)).toBe(TOKEN)
    expect(await db.metaGet(META_DEVICE_ID)).toBe('dev-fresh')
    expect(await db.metaGet(META_MY_USER_ID)).toBe('user-1')
    expect(await db.metaGet(META_WORKSPACE_ID)).toBe('ws-1')
    expect(await db.metaGet(META_ROLE)).toBe('owner')
    expect(await db.metaGet(META_SESSION_EXPIRES_AT)).toBe('2026-10-01T00:00:00Z')
    expect(manager.status()).toEqual({
      authenticated: true,
      my_user_id: 'user-1',
      workspace_id: 'ws-1',
      role: 'owner',
      expires_at: '2026-10-01T00:00:00Z',
    })
  })

  it('persists through a real (fake-indexeddb) DexieDb', async () => {
    const db = await openDb(fakeIdbOptions())
    const { fetchImpl } = makeFetch(() => loginResponse())
    const { manager } = makeManager(db, fetchImpl)

    await manager.login({ email: 'a@b.co', password: 'password1234' })

    expect(await db.metaGet(META_SESSION_TOKEN)).toBe(TOKEN)
    expect(await db.metaGet(META_DEVICE_ID)).toBe('dev-fresh')
    await db.close()
  })

  it('omits device_id on first login and reuses the stored id on re-login', async () => {
    const db = new MemoryDb()
    const { fetchImpl, requests } = makeFetch(() => loginResponse({ device_id: 'dev-stable' }))
    const { manager } = makeManager(db, fetchImpl)

    await manager.login({ email: 'a@b.co', password: 'password1234' })
    await manager.login({ email: 'a@b.co', password: 'password1234' })

    // First request omits device_id; server-minted id is persisted...
    expect(requests[0]?.body?.device_id).toBeUndefined()
    // ...and the second request sends it back for reuse.
    expect(requests[1]?.body?.device_id).toBe('dev-stable')
    expect(await db.metaGet(META_DEVICE_ID)).toBe('dev-stable')
  })

  it('includes a non-empty device_label (server-required, min 1)', async () => {
    const db = new MemoryDb()
    const { fetchImpl, requests } = makeFetch(() => loginResponse())
    const { manager } = makeManager(db, fetchImpl)

    await manager.login({ email: 'a@b.co', password: 'password1234' })

    expect(typeof requests[0]?.body?.device_label).toBe('string')
    expect((requests[0]?.body?.device_label as string).length).toBeGreaterThan(0)
  })

  it('self-heals on invalid-device: drops the stored id and retries once fresh', async () => {
    const db = new MemoryDb()
    await db.metaPut(META_DEVICE_ID, 'dev-stale')
    const { fetchImpl, requests } = makeFetch((req) =>
      req.body?.device_id === 'dev-stale'
        ? problem(400, 'invalid-device')
        : loginResponse({ device_id: 'dev-new' }),
    )
    const { manager } = makeManager(db, fetchImpl)

    const res = await manager.login({ email: 'a@b.co', password: 'password1234' })

    expect(res.ok).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.body?.device_id).toBe('dev-stale')
    expect(requests[1]?.body?.device_id).toBeUndefined()
    expect(await db.metaGet(META_DEVICE_ID)).toBe('dev-new')
  })

  it('maps invalid-credentials problem+json to a token-free error result', async () => {
    const db = new MemoryDb()
    const { fetchImpl } = makeFetch(() => problem(401, 'invalid-credentials'))
    const { manager } = makeManager(db, fetchImpl)

    const res = await manager.login({ email: 'a@b.co', password: 'wrongwrongwrong' })

    if (res.ok) throw new Error('expected error')
    expect(res.error).toMatchObject({ code: 'invalid-credentials', status: 401 })
    expect(manager.status().authenticated).toBe(false)
  })

  it('surfaces retryAfter on rate-limited', async () => {
    const db = new MemoryDb()
    const { fetchImpl } = makeFetch(() => problem(429, 'rate-limited', { 'Retry-After': '45' }))
    const { manager } = makeManager(db, fetchImpl)

    const res = await manager.login({ email: 'a@b.co', password: 'password1234' })

    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('rate-limited')
    expect(res.error.retryAfter).toBe(45)
  })
})

describe('AuthManager.setup / acceptInvite', () => {
  it('setup persists the session + device_id', async () => {
    const db = new MemoryDb()
    const { fetchImpl, requests } = makeFetch(() => loginResponse({ device_id: 'dev-setup' }))
    const { manager } = makeManager(db, fetchImpl)

    const res = await manager.setup({
      workspace_name: 'Acme',
      email: 'owner@acme.co',
      password: 'password1234',
      display_name: 'Owner',
    })

    expect(res.ok).toBe(true)
    expect(requests[0]?.url).toContain('/v1/setup')
    expect(await db.metaGet(META_SESSION_TOKEN)).toBe(TOKEN)
    expect(await db.metaGet(META_DEVICE_ID)).toBe('dev-setup')
  })

  it('accept-invite persists the returned device_id for later re-login (R-g)', async () => {
    const db = new MemoryDb()
    const { fetchImpl, requests } = makeFetch(() => loginResponse({ device_id: 'dev-invite' }))
    const { manager } = makeManager(db, fetchImpl)

    const res = await manager.acceptInvite({
      token: 'invite-xyz',
      email: 'new@acme.co',
      display_name: 'Newbie',
      password: 'password1234',
    })

    expect(res.ok).toBe(true)
    expect(requests[0]?.url).toContain('/v1/auth/accept-invite')
    // No device fields are sent on accept-invite (server mints).
    expect(requests[0]?.body?.device_id).toBeUndefined()
    expect(requests[0]?.body?.device_label).toBeUndefined()
    expect(await db.metaGet(META_DEVICE_ID)).toBe('dev-invite')
  })
})

describe('AuthManager session lifecycle', () => {
  it('clears the session on a 401 from an authed call (onUnauthorized)', async () => {
    const db = new MemoryDb()
    let phase: 'login' | 'authed' = 'login'
    const { fetchImpl } = makeFetch(() =>
      phase === 'login' ? loginResponse() : problem(401, 'unauthenticated'),
    )
    const { manager, http } = makeManager(db, fetchImpl)

    await manager.login({ email: 'a@b.co', password: 'password1234' })
    expect(manager.status().authenticated).toBe(true)

    phase = 'authed'
    await http.get('/v1/auth/sessions') // 401 → onUnauthorized → clearSession

    expect(manager.status().authenticated).toBe(false)
    expect(await db.metaGet(META_SESSION_TOKEN)).toBeUndefined()
    // device_id survives a 401-driven clear.
    expect(await db.metaGet(META_DEVICE_ID)).toBe('dev-fresh')
  })

  it('logout clears the session, keeps device_id, and wipes derived + synced-KV tables', async () => {
    const db = new MemoryDb()
    const { fetchImpl } = makeFetch(() => loginResponse())
    const { manager } = makeManager(db, fetchImpl)
    await manager.login({ email: 'a@b.co', password: 'password1234' })
    await db.putMessages([
      {
        message_id: 'm1',
        stream_id: 's1',
        created_seq: 1,
        author_user_id: 'u1',
        text: '',
        format: 'plain',
        mention_user_ids: [],
        file_ids: [],
      },
    ])
    // ENG-126: seed the synced-KV tables so the wipe assertion is non-vacuous — a
    // shared machine must not leak the previous user's read positions / prefs.
    await db.putReadState([{ stream_id: 's1', last_read_seq: 5 }])
    await db.putPrefs([{ stream_id: 's1', level: 'mute' }])

    await manager.logout()

    expect(manager.status().authenticated).toBe(false)
    expect(await db.metaGet(META_SESSION_TOKEN)).toBeUndefined()
    expect(await db.metaGet(META_MY_USER_ID)).toBeUndefined()
    expect(await db.metaGet(META_DEVICE_ID)).toBe('dev-fresh') // kept
    expect(await db.count('messages')).toBe(0) // derived wiped
    // Synced-KV wiped too (logout = full local reset for the next user).
    expect(await db.count('read_state')).toBe(0)
    expect(await db.count('prefs')).toBe(0)
  })

  it('restore() rehydrates the in-memory session from meta (reload persistence)', async () => {
    const db = new MemoryDb()
    await db.metaPut(META_SESSION_TOKEN, TOKEN)
    await db.metaPut(META_MY_USER_ID, 'user-9')
    await db.metaPut(META_WORKSPACE_ID, 'ws-9')
    await db.metaPut(META_ROLE, 'member')
    await db.metaPut(META_SESSION_EXPIRES_AT, '2027-01-01T00:00:00Z')
    const { fetchImpl } = makeFetch(() => loginResponse())
    const { manager } = makeManager(db, fetchImpl)

    await manager.restore()

    expect(manager.status()).toEqual({
      authenticated: true,
      my_user_id: 'user-9',
      workspace_id: 'ws-9',
      role: 'member',
      expires_at: '2027-01-01T00:00:00Z',
    })
    expect(manager.getToken()).toBe(TOKEN) // worker-internal accessor
  })
})

describe('token-owned-by-worker boundary (KEY guardrail, R1/R7)', () => {
  it('the token appears in NO FromWorker frame produced by auth.* handlers', async () => {
    const db = new MemoryDb()
    const { fetchImpl } = makeFetch(() => loginResponse())
    const { sink, frames } = collectingSink()
    // Inject an inert WS factory so the post-login sync auto-start opens no socket.
    const core = new WorkerCore(db, sink, { fetchImpl, wsFactory: inertWsFactory })
    await core.init()

    // Drive login + status through the real RPC entry point.
    await core.handle('c1', {
      t: 'req',
      id: 'login-1',
      clientId: 'c1',
      req: { method: 'auth.login', params: { email: 'a@b.co', password: 'password1234' } },
    })
    await core.handle('c1', {
      t: 'req',
      id: 'status-1',
      clientId: 'c1',
      req: { method: 'auth.status', params: {} },
    })

    // The token was stored worker-side...
    expect(await db.metaGet(META_SESSION_TOKEN)).toBe(TOKEN)
    // ...but it must not appear in ANY frame handed to a tab.
    const serialized = JSON.stringify(frames)
    expect(serialized).not.toContain(TOKEN)

    // And the login result itself is a token-free success.
    const loginFrame = frames.find(
      (f): f is { clientId: string; msg: Extract<FromWorker, { t: 'res' }> } =>
        f.msg.t === 'res' && f.msg.id === 'login-1',
    )
    expect(loginFrame?.msg.ok).toBe(true)
    if (loginFrame?.msg.ok) {
      expect(JSON.stringify(loginFrame.msg.result)).not.toContain(TOKEN)
    }
  })
})

describe('deriveDeviceLabel', () => {
  it('derives a coarse "<Browser> on <OS>" label', () => {
    const chromeMac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    expect(deriveDeviceLabel(chromeMac)).toBe('Chrome on macOS')
  })

  it('falls back to a non-empty label when the UA is empty', () => {
    expect(deriveDeviceLabel('')).toBe('Web browser')
    expect(deriveDeviceLabel('').length).toBeGreaterThan(0)
  })

  it('bounds the label to 200 chars', () => {
    expect(deriveDeviceLabel('x'.repeat(5000)).length).toBeLessThanOrEqual(200)
  })
})
