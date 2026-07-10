// tests/unit/worker/admin.spec.ts — the ENG-151 admin RPC arms: HTTP
// pass-through over the worker's authed client (`/v1/admin/*`), nothing
// persisted locally. Asserts each handler issues the right method + URL +
// body, success returns the server shape verbatim, and 403/404/422 fold into
// the standard coded RPC errors (`forbidden` / `not-found` /
// `validation-error`) — plus a WorkerCore round trip and the token boundary.

import { describe, expect, it } from 'vitest'

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
} from '../../../src/worker/admin'
import { WorkerCore } from '../../../src/worker/core'
import { MemoryDb } from '../../../src/worker/db'
import { RpcCodedError } from '../../../src/worker/types'
import type {
  AdminInvite,
  AdminMember,
  AdminMembersResult,
  FromWorker,
} from '../../../src/worker/types'
import type { ApiError } from '../../../src/worker/http'

import { collectingSink, FakeHttpClient, FakeSyncServer, inertWsFactory } from './helpers'

function member(overrides: Partial<AdminMember> = {}): AdminMember {
  return {
    user_id: 'u_1',
    display_name: 'Alice',
    email: 'alice@example.com',
    role: 'member',
    is_bot: false,
    deactivated: false,
    ...overrides,
  }
}

function invite(overrides: Partial<AdminInvite> = {}): AdminInvite {
  return {
    id: 'a'.repeat(64), // sha256 token_hash — the revoke handle, never the raw token
    role: 'member',
    created_by: 'u_owner',
    expires_at: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

const forbidden: ApiError = { status: 403, code: 'forbidden', title: 'Forbidden' }
const invalid: ApiError = { status: 422, code: 'validation-error', title: 'Validation error' }

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof RpcCodedError) return err.code
    throw err
  }
  throw new Error('expected a rejection')
}

describe('admin.members.list (GET /v1/admin/members)', () => {
  it('GETs the roster and returns the server fields verbatim', async () => {
    const server = new FakeSyncServer()
    server.adminMembers = [
      member(),
      member({ user_id: 'u_2', display_name: 'Bot', is_bot: true, deactivated: true }),
    ]
    const http = new FakeHttpClient(server)

    const res = await listAdminMembers(http)

    expect(http.getCalls).toEqual(['/v1/admin/members'])
    expect(res.members).toHaveLength(2)
    expect(res.members[0]).toEqual({
      user_id: 'u_1',
      display_name: 'Alice',
      email: 'alice@example.com',
      role: 'member',
      is_bot: false,
      deactivated: false,
    })
    expect(res.members[1]).toMatchObject({ is_bot: true, deactivated: true })
  })

  it('maps a 403 (member/guest caller) to the coded `forbidden` error', async () => {
    const server = new FakeSyncServer()
    server.adminError = forbidden
    const http = new FakeHttpClient(server)

    expect(await codeOf(listAdminMembers(http))).toBe('forbidden')
  })
})

describe('admin.members.update (PATCH /v1/admin/members/{user_id})', () => {
  it('PATCHes the target URL with only the defined fields (role only)', async () => {
    const server = new FakeSyncServer()
    server.adminMembers = [member()]
    const http = new FakeHttpClient(server)

    const res = await updateAdminMember(http, { user_id: 'u_1', role: 'admin' })

    expect(http.patchCalls).toEqual([
      { path: '/v1/admin/members/u_1', body: { role: 'admin' } }, // no `active` key
    ])
    expect(res.role).toBe('admin')
    expect(res.user_id).toBe('u_1')
  })

  it('PATCHes `active: false` (deactivate) and returns the updated row', async () => {
    const server = new FakeSyncServer()
    server.adminMembers = [member()]
    const http = new FakeHttpClient(server)

    const res = await updateAdminMember(http, { user_id: 'u_1', active: false })

    expect(http.patchCalls[0]).toEqual({
      path: '/v1/admin/members/u_1',
      body: { active: false },
    })
    expect(res.deactivated).toBe(true)
  })

  it('sends both fields when both are given', async () => {
    const server = new FakeSyncServer()
    server.adminMembers = [member()]
    const http = new FakeHttpClient(server)

    await updateAdminMember(http, { user_id: 'u_1', role: 'guest', active: true })

    expect(http.patchCalls[0]?.body).toEqual({ role: 'guest', active: true })
  })

  it('keeps a 403 policy denial distinct from the uniform 404', async () => {
    const server = new FakeSyncServer()
    server.adminMembers = [member({ role: 'owner' })]
    const http = new FakeHttpClient(server)

    server.adminError = forbidden // e.g. owner-immutability / admin-on-admin
    expect(await codeOf(updateAdminMember(http, { user_id: 'u_1', role: 'member' }))).toBe(
      'forbidden',
    )

    server.adminError = undefined
    expect(await codeOf(updateAdminMember(http, { user_id: 'u_missing', role: 'member' }))).toBe(
      'not-found',
    )
  })

  it('maps a 422 (empty PATCH) to the coded `validation-error`', async () => {
    const server = new FakeSyncServer()
    server.adminError = invalid
    const http = new FakeHttpClient(server)

    expect(await codeOf(updateAdminMember(http, { user_id: 'u_1' }))).toBe('validation-error')
  })
})

describe('admin.invites.list (GET /v1/admin/invites)', () => {
  it('GETs the pending invites; `id` is the token_hash, never a raw token', async () => {
    const server = new FakeSyncServer()
    server.adminInvites = [invite(), invite({ id: 'b'.repeat(64), role: 'guest' })]
    const http = new FakeHttpClient(server)

    const res = await listAdminInvites(http)

    expect(http.getCalls).toEqual(['/v1/admin/invites'])
    expect(res.invites).toHaveLength(2)
    expect(res.invites[0]).toEqual({
      id: 'a'.repeat(64),
      role: 'member',
      created_by: 'u_owner',
      expires_at: '2026-08-01T00:00:00Z',
    })
    // No field of the response smells like a credential.
    for (const inv of res.invites) {
      expect(Object.keys(inv).sort()).toEqual(['created_by', 'expires_at', 'id', 'role'])
    }
  })

  it('maps a 403 to the coded `forbidden` error', async () => {
    const server = new FakeSyncServer()
    server.adminError = forbidden
    const http = new FakeHttpClient(server)

    expect(await codeOf(listAdminInvites(http))).toBe('forbidden')
  })
})

describe('admin.invites.create (POST /v1/admin/invites)', () => {
  it('POSTs role + ttl_seconds and returns the one-time join URL + expiry', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    const res = await createAdminInvite(http, { role: 'guest', ttl_seconds: 86400 })

    expect(http.postCalls).toEqual([
      { path: '/v1/admin/invites', body: { role: 'guest', ttl_seconds: 86400 } },
    ])
    expect(res.url).toBe('https://msg.example/join/raw-invite-token-1')
    expect(res.expires_at).toBeTruthy()
  })

  it('omits ttl_seconds from the body when not given (server default applies)', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    await createAdminInvite(http, { role: 'member' })

    expect(http.postCalls[0]?.body).toEqual({ role: 'member' }) // no `ttl_seconds` key
  })

  it('the raw token appears ONLY in the create response, never in a later list', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    const created = await createAdminInvite(http, { role: 'member' })
    const listed = await listAdminInvites(http)

    const raw = created.url.split('/join/')[1]!
    expect(raw).toBe('raw-invite-token-1')
    expect(listed.invites).toHaveLength(1) // the new invite IS pending…
    expect(JSON.stringify(listed)).not.toContain(raw) // …but only as a hash
  })

  it('maps a 403 (member/guest caller) to the coded `forbidden` error', async () => {
    const server = new FakeSyncServer()
    server.adminError = forbidden
    const http = new FakeHttpClient(server)

    expect(await codeOf(createAdminInvite(http, { role: 'member' }))).toBe('forbidden')
  })

  it('maps a 422 (e.g. a forged owner role / bad ttl) to `validation-error`', async () => {
    const server = new FakeSyncServer()
    server.adminError = invalid
    const http = new FakeHttpClient(server)

    expect(await codeOf(createAdminInvite(http, { role: 'admin', ttl_seconds: 0 }))).toBe(
      'validation-error',
    )
  })
})

describe('admin.invites.revoke (DELETE /v1/admin/invites/{id})', () => {
  it('DELETEs the right id; the 204 folds to a plain { ok: true }', async () => {
    const server = new FakeSyncServer()
    server.adminInvites = [invite()]
    const http = new FakeHttpClient(server)

    const res = await revokeAdminInvite(http, { id: 'a'.repeat(64) })

    expect(http.delCalls).toEqual([`/v1/admin/invites/${'a'.repeat(64)}`])
    expect(res).toEqual({ ok: true })
    expect(server.adminInvites).toHaveLength(0)
  })

  it('maps the uniform 404 (unknown/used/already-revoked) to `not-found`', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    expect(await codeOf(revokeAdminInvite(http, { id: 'nope' }))).toBe('not-found')
  })
})

describe('token boundary (R1)', () => {
  it('admin params/paths never carry a token/bearer/authorization field', async () => {
    const server = new FakeSyncServer()
    server.adminMembers = [member()]
    server.adminInvites = [invite()]
    const http = new FakeHttpClient(server)

    await listAdminMembers(http)
    await updateAdminMember(http, { user_id: 'u_1', role: 'admin' })
    await listAdminInvites(http)
    await createAdminInvite(http, { role: 'member', ttl_seconds: 3600 })
    await revokeAdminInvite(http, { id: 'a'.repeat(64) })

    // NOTE: the create RESPONSE deliberately carries the one-time join URL —
    // what must stay clean is everything the TAB sends: params, paths, bodies.
    const surfaces = [
      ...http.getCalls,
      ...http.delCalls,
      ...http.patchCalls.map((c) => c.path + JSON.stringify(c.body)),
      ...http.postCalls.map((c) => c.path + JSON.stringify(c.body)),
    ]
    for (const s of surfaces) {
      expect(s).not.toMatch(/token|bearer|authorization/i)
    }
  })
})

describe('admin.workspace.get (GET /v1/admin/workspace)', () => {
  it('GETs the settings row and returns the server fields verbatim', async () => {
    const server = new FakeSyncServer()
    server.adminWorkspace = {
      workspace_id: 'w_1',
      name: 'Acme',
      description: 'About us',
      icon_sha256: null,
    }
    const http = new FakeHttpClient(server)

    const res = await getAdminWorkspace(http)

    expect(http.getCalls).toEqual(['/v1/admin/workspace'])
    expect(res).toEqual({
      workspace_id: 'w_1',
      name: 'Acme',
      description: 'About us',
      icon_sha256: null,
    })
  })

  it('folds a 403 (member/guest caller) into the coded `forbidden`', async () => {
    const server = new FakeSyncServer()
    server.adminError = forbidden
    const http = new FakeHttpClient(server)

    expect(await codeOf(getAdminWorkspace(http))).toBe('forbidden')
  })
})

describe('admin.workspace.update (PATCH /v1/admin/workspace)', () => {
  it('PATCHes only the defined fields and returns the updated row', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    const res = await updateAdminWorkspace(http, { name: 'Acme Corp' })

    // Presence-significant body: an untouched description is ABSENT, not null.
    expect(http.patchCalls).toEqual([{ path: '/v1/admin/workspace', body: { name: 'Acme Corp' } }])
    expect(res.name).toBe('Acme Corp')
    expect(res.description).toBeNull()
  })

  it("sends `description: ''` verbatim — the explicit clear is never dropped", async () => {
    const server = new FakeSyncServer()
    server.adminWorkspace = {
      workspace_id: 'w_1',
      name: 'Acme',
      description: 'Old',
      icon_sha256: null,
    }
    const http = new FakeHttpClient(server)

    const res = await updateAdminWorkspace(http, { description: '' })

    expect(http.patchCalls).toEqual([{ path: '/v1/admin/workspace', body: { description: '' } }])
    expect(res).toEqual({ workspace_id: 'w_1', name: 'Acme', description: '', icon_sha256: null })
  })

  it('folds a 422 (bad name / empty PATCH) into the coded `validation-error`', async () => {
    const server = new FakeSyncServer()
    server.adminError = invalid
    const http = new FakeHttpClient(server)

    expect(await codeOf(updateAdminWorkspace(http, { name: '' }))).toBe('validation-error')
  })
})

describe('admin.workspace.uploadIcon / clearIcon (ENG-152)', () => {
  it('POSTs the raw icon bytes + content type and returns the row with the new sha', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

    const res = await uploadWorkspaceIcon(http, blob)

    expect(http.postBlobCalls).toEqual([
      { path: '/v1/admin/workspace/icon', body: blob, contentType: 'image/png' },
    ])
    expect(typeof res.icon_sha256).toBe('string')
    expect(res.icon_sha256).not.toBeNull()
  })

  it('DELETEs the icon and returns the row with a null sha', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)
    await uploadWorkspaceIcon(http, new Blob([new Uint8Array([9])], { type: 'image/png' }))

    const res = await clearWorkspaceIcon(http)

    expect(http.delCalls).toContain('/v1/admin/workspace/icon')
    expect(res.icon_sha256).toBeNull()
  })

  it('folds a 403 (member/guest caller) into the coded `forbidden`', async () => {
    const server = new FakeSyncServer()
    server.adminError = forbidden
    const http = new FakeHttpClient(server)
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' })

    expect(await codeOf(uploadWorkspaceIcon(http, blob))).toBe('forbidden')
  })
})

describe('admin RPC (WorkerCore round trip)', () => {
  it('answers `admin.members.list` with the roster (plain data only)', async () => {
    const server = new FakeSyncServer()
    server.adminMembers = [member()]
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(new MemoryDb(), sink, { http, wsFactory: inertWsFactory })
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'a1',
      clientId: 'c1',
      req: { method: 'admin.members.list', params: {} },
    })

    const res = lastRes(frames, 'a1')
    expect(res.t === 'res' && res.ok).toBe(true)
    if (res.t === 'res' && res.ok) {
      const result = res.result as AdminMembersResult
      expect(result.members[0]?.user_id).toBe('u_1')
      // The frame carries plain roster data — nothing token-ish.
      expect(JSON.stringify(result)).not.toMatch(/token|bearer|authorization/i)
    }
    expect(http.getCalls).toContain('/v1/admin/members')
  })

  it('answers `admin.invites.create` with the one-time join URL', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(new MemoryDb(), sink, { http, wsFactory: inertWsFactory })
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'a3',
      clientId: 'c1',
      req: { method: 'admin.invites.create', params: { role: 'admin', ttl_seconds: 86400 } },
    })

    const res = lastRes(frames, 'a3')
    expect(res.t === 'res' && res.ok).toBe(true)
    if (res.t === 'res' && res.ok) {
      const result = res.result as { url: string; expires_at: string }
      expect(result.url).toContain('/join/')
      expect(result.expires_at).toBeTruthy()
    }
    expect(http.postCalls[0]).toEqual({
      path: '/v1/admin/invites',
      body: { role: 'admin', ttl_seconds: 86400 },
    })
  })

  it('answers `admin.workspace.update` with the updated row (plain data only)', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(new MemoryDb(), sink, { http, wsFactory: inertWsFactory })
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'a4',
      clientId: 'c1',
      req: {
        method: 'admin.workspace.update',
        params: { name: 'Acme Corp', description: 'About us' },
      },
    })

    const res = lastRes(frames, 'a4')
    expect(res.t === 'res' && res.ok).toBe(true)
    if (res.t === 'res' && res.ok) {
      const result = res.result as { name: string; description: string | null }
      expect(result.name).toBe('Acme Corp')
      expect(result.description).toBe('About us')
      // The frame carries plain settings data — nothing token-ish (R1).
      expect(JSON.stringify(result)).not.toMatch(/token|bearer|authorization/i)
    }
    expect(http.patchCalls).toEqual([
      { path: '/v1/admin/workspace', body: { name: 'Acme Corp', description: 'About us' } },
    ])
  })

  it('frames a 403 as a structured coded error, not a bare throw', async () => {
    const server = new FakeSyncServer()
    server.adminError = forbidden
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(new MemoryDb(), sink, { http, wsFactory: inertWsFactory })
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'a2',
      clientId: 'c1',
      req: { method: 'admin.invites.revoke', params: { id: 'x' } },
    })

    const res = lastRes(frames, 'a2')
    expect(res.t === 'res' && !res.ok).toBe(true)
    if (res.t === 'res' && !res.ok) {
      expect(res.error.code).toBe('forbidden')
    }
  })
})

function lastRes(frames: Array<{ clientId: string; msg: FromWorker }>, id: string): FromWorker {
  const found = frames.find((f) => f.msg.t === 'res' && f.msg.id === id)?.msg
  if (!found) throw new Error(`no res frame for id ${id}`)
  return found
}
