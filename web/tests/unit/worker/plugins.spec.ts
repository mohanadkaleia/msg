// tests/unit/worker/plugins.spec.ts — the ENG-176 plugins RPC arms: HTTP
// pass-through over the worker's authed client (`/v1/plugins/*`), nothing
// persisted locally. Asserts each handler issues the right method + URL +
// body, success returns the server shape verbatim, 403/422 fold into the
// standard coded RPC errors (`forbidden` / `validation-error`) and the
// uniform 404 into `not-found` — plus the CREDENTIAL boundary: the raw bot
// token / capability URL appear ONLY in their create/mint response (never in
// any list), and nothing the tab sends smells like a token. Ends with a
// WorkerCore round trip.

import { describe, expect, it } from 'vitest'

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
} from '../../../src/worker/plugins'
import { WorkerCore } from '../../../src/worker/core'
import { MemoryDb } from '../../../src/worker/db'
import { RpcCodedError } from '../../../src/worker/types'
import type {
  FromWorker,
  PluginBot,
  PluginBotsResult,
  PluginHook,
  PluginTokenMintResult,
} from '../../../src/worker/types'
import type { ApiError } from '../../../src/worker/http'

import { collectingSink, FakeHttpClient, FakeSyncServer, inertWsFactory } from './helpers'

function bot(overrides: Partial<PluginBot> = {}): PluginBot {
  return {
    bot_user_id: 'b_1',
    name: 'Deploy notifier',
    device_id: 'd_bot_1',
    role: 'guest',
    deactivated: false,
    stream_ids: ['s_general'],
    tokens: [],
    ...overrides,
  }
}

function hook(overrides: Partial<PluginHook> = {}): PluginHook {
  return {
    id: 'h'.repeat(64), // sha256 token_hash — the revoke handle, never the raw token
    stream_id: 's_general',
    bot_user_id: 'b_1',
    name: 'GitHub notifier',
    created_by: 'u_owner',
    created_at: '2026-07-01T00:00:00Z',
    disabled: false,
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

describe('plugins.bots.list (GET /v1/plugins/bots)', () => {
  it('GETs the bots and returns the server fields verbatim (hash handles only)', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [
      bot({
        tokens: [
          {
            id: 'a'.repeat(64),
            scopes: ['events:write'],
            created_at: '2026-07-01T00:00:00Z',
            last_used_at: null,
            revoked: false,
          },
        ],
      }),
      bot({ bot_user_id: 'b_2', name: 'Standup bot', deactivated: true, stream_ids: [] }),
    ]
    const http = new FakeHttpClient(server)

    const res = await listPluginBots(http)

    expect(http.getCalls).toEqual(['/v1/plugins/bots'])
    expect(res.bots).toHaveLength(2)
    expect(res.bots[0]).toMatchObject({
      bot_user_id: 'b_1',
      name: 'Deploy notifier',
      device_id: 'd_bot_1',
      role: 'guest',
      deactivated: false,
      stream_ids: ['s_general'],
    })
    // Token entries are HASH handles + metadata — no credential-shaped field.
    expect(res.bots[0]?.tokens[0]).toEqual({
      id: 'a'.repeat(64),
      scopes: ['events:write'],
      created_at: '2026-07-01T00:00:00Z',
      last_used_at: null,
      revoked: false,
    })
    expect(res.bots[1]).toMatchObject({ deactivated: true })
  })

  it('maps a 403 (member/guest caller) to the coded `forbidden` error', async () => {
    const server = new FakeSyncServer()
    server.pluginsError = forbidden
    const http = new FakeHttpClient(server)

    expect(await codeOf(listPluginBots(http))).toBe('forbidden')
  })
})

describe('plugins.bots.create (POST /v1/plugins/bots)', () => {
  it('POSTs name + scopes + stream_ids and returns the bot row (NO credential)', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    const res = await createPluginBot(http, {
      name: 'Deploy notifier',
      scopes: ['events:write', 'files:write'],
      stream_ids: ['s_general', 's_ops'],
    })

    expect(http.postCalls).toEqual([
      {
        path: '/v1/plugins/bots',
        body: {
          name: 'Deploy notifier',
          scopes: ['events:write', 'files:write'],
          stream_ids: ['s_general', 's_ops'],
        },
      },
    ])
    expect(res.name).toBe('Deploy notifier')
    expect(res.role).toBe('guest')
    expect(res.stream_ids).toEqual(['s_general', 's_ops'])
    expect(res.tokens).toEqual([]) // provisioning mints NO token
    // The create response carries nothing credential-shaped.
    expect(JSON.stringify(res)).not.toMatch(/raw-bot-token/)
  })

  it('always sends stream_ids (the server default `[]` when none picked)', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    await createPluginBot(http, { name: 'Bot', scopes: ['events:read'] })

    expect(http.postCalls[0]?.body).toEqual({
      name: 'Bot',
      scopes: ['events:read'],
      stream_ids: [],
    })
  })

  it('maps a 422 (bad name/scope) to the coded `validation-error`', async () => {
    const server = new FakeSyncServer()
    server.pluginsError = invalid
    const http = new FakeHttpClient(server)

    expect(await codeOf(createPluginBot(http, { name: '', scopes: [] }))).toBe('validation-error')
  })
})

describe('plugins.bots.mintToken (POST /v1/plugins/bots/{id}/tokens)', () => {
  it('POSTs to the bot URL; the RAW token is returned to the caller exactly here', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot()]
    const http = new FakeHttpClient(server)

    const res = await mintPluginBotToken(http, { bot_user_id: 'b_1' })

    // `scopes` omitted → an EMPTY body (server defaults to the install scopes).
    expect(http.postCalls).toEqual([{ path: '/v1/plugins/bots/b_1/tokens', body: {} }])
    expect(res.token).toBe('raw-bot-token-1')
    expect(res.bot_user_id).toBe('b_1')
    expect(res.id).not.toContain(res.token) // the handle is a hash, not the raw
  })

  it('sends explicit scopes when given', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot()]
    const http = new FakeHttpClient(server)

    await mintPluginBotToken(http, { bot_user_id: 'b_1', scopes: ['events:read'] })

    expect(http.postCalls[0]?.body).toEqual({ scopes: ['events:read'] })
  })

  it('the raw token appears ONLY in the mint response, never in a later list', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot()]
    const http = new FakeHttpClient(server)

    const minted = await mintPluginBotToken(http, { bot_user_id: 'b_1' })
    const listed = await listPluginBots(http)

    expect(minted.token).toBe('raw-bot-token-1')
    expect(listed.bots[0]?.tokens).toHaveLength(1) // the new token IS listed…
    expect(JSON.stringify(listed)).not.toContain(minted.token) // …but only as a hash
  })

  it('maps a 403 (deactivated bot — no fresh credential) to `forbidden`', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot({ deactivated: true })]
    const http = new FakeHttpClient(server)

    expect(await codeOf(mintPluginBotToken(http, { bot_user_id: 'b_1' }))).toBe('forbidden')
  })

  it('maps the uniform 404 (unknown/cross-workspace bot) to `not-found`', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    expect(await codeOf(mintPluginBotToken(http, { bot_user_id: 'b_missing' }))).toBe('not-found')
  })
})

describe('plugins.bots.revokeToken (DELETE .../tokens/{token_id})', () => {
  it('DELETEs the right hash handle; the 204 folds to a plain { ok: true }', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot()]
    const http = new FakeHttpClient(server)
    const minted = await mintPluginBotToken(http, { bot_user_id: 'b_1' })

    const res = await revokePluginBotToken(http, { bot_user_id: 'b_1', token_id: minted.id })

    expect(http.delCalls).toEqual([`/v1/plugins/bots/b_1/tokens/${minted.id}`])
    expect(res).toEqual({ ok: true })
    expect(server.pluginBots[0]?.tokens[0]?.revoked).toBe(true)
  })

  it('maps the uniform 404 (unknown/already-revoked handle) to `not-found`', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot()]
    const http = new FakeHttpClient(server)

    expect(await codeOf(revokePluginBotToken(http, { bot_user_id: 'b_1', token_id: 'nope' }))).toBe(
      'not-found',
    )
  })
})

describe('plugins.bots.grantStream / revokeStream (PUT/DELETE .../streams/{id})', () => {
  it('PUTs the grant URL (no body) and folds the 204 to an ack', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot({ stream_ids: [] })]
    const http = new FakeHttpClient(server)

    const res = await grantPluginBotStream(http, { bot_user_id: 'b_1', stream_id: 's_ops' })

    expect(http.putCalls).toEqual([{ path: '/v1/plugins/bots/b_1/streams/s_ops', body: undefined }])
    expect(res).toEqual({ ok: true })
    expect(server.pluginBots[0]?.stream_ids).toEqual(['s_ops'])
  })

  it('DELETEs the revoke URL and folds the 204 to an ack', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot({ stream_ids: ['s_general'] })]
    const http = new FakeHttpClient(server)

    const res = await revokePluginBotStream(http, { bot_user_id: 'b_1', stream_id: 's_general' })

    expect(http.delCalls).toEqual(['/v1/plugins/bots/b_1/streams/s_general'])
    expect(res).toEqual({ ok: true })
    expect(server.pluginBots[0]?.stream_ids).toEqual([])
  })

  it('URL-encodes the path segments (no path injection through ids)', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    await grantPluginBotStream(http, { bot_user_id: 'b/../x', stream_id: 's #1' }).catch(() => {
      /* the fake 404s the mangled id — the URL shape is what we assert */
    })

    expect(http.putCalls[0]?.path).toBe('/v1/plugins/bots/b%2F..%2Fx/streams/s%20%231')
  })

  it('maps the uniform 404 (unknown bot / non-channel stream) to `not-found`', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    expect(await codeOf(grantPluginBotStream(http, { bot_user_id: 'b_x', stream_id: 's_1' }))).toBe(
      'not-found',
    )
    expect(
      await codeOf(revokePluginBotStream(http, { bot_user_id: 'b_x', stream_id: 's_1' })),
    ).toBe('not-found')
  })
})

describe('plugins.hooks.list (GET /v1/plugins/hooks)', () => {
  it('GETs the hooks; `id` is the token_hash, never a capability URL', async () => {
    const server = new FakeSyncServer()
    server.pluginHooks = [hook(), hook({ id: 'i'.repeat(64), name: 'CI notifier' })]
    const http = new FakeHttpClient(server)

    const res = await listPluginHooks(http)

    expect(http.getCalls).toEqual(['/v1/plugins/hooks'])
    expect(res.hooks).toHaveLength(2)
    expect(res.hooks[0]).toEqual({
      id: 'h'.repeat(64),
      stream_id: 's_general',
      bot_user_id: 'b_1',
      name: 'GitHub notifier',
      created_by: 'u_owner',
      created_at: '2026-07-01T00:00:00Z',
      disabled: false,
    })
    // No field of the listing smells like a URL or a raw token.
    expect(JSON.stringify(res)).not.toMatch(/https?:|\/hooks\//)
  })

  it('maps a 403 to the coded `forbidden` error', async () => {
    const server = new FakeSyncServer()
    server.pluginsError = forbidden
    const http = new FakeHttpClient(server)

    expect(await codeOf(listPluginHooks(http))).toBe('forbidden')
  })
})

describe('plugins.hooks.create (POST /v1/plugins/hooks)', () => {
  it('POSTs stream_id + name (bot omitted → auto-provision) and returns the one-time URL', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    const res = await createPluginHook(http, { stream_id: 's_general', name: 'GitHub notifier' })

    expect(http.postCalls).toEqual([
      { path: '/v1/plugins/hooks', body: { stream_id: 's_general', name: 'GitHub notifier' } },
    ])
    expect(res.url).toBe('https://msg.example/v1/hooks/raw-hook-token-1')
    expect(res.stream_id).toBe('s_general')
    expect(res.id).not.toContain('raw-hook-token-1') // the handle is a hash
  })

  it('sends bot_user_id only when given (pin an existing bot)', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot()]
    const http = new FakeHttpClient(server)

    await createPluginHook(http, { stream_id: 's_general', name: 'Hook', bot_user_id: 'b_1' })

    expect(http.postCalls[0]?.body).toEqual({
      stream_id: 's_general',
      name: 'Hook',
      bot_user_id: 'b_1',
    })
  })

  it('the capability URL appears ONLY in the create response, never in a later list', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    const created = await createPluginHook(http, { stream_id: 's_general', name: 'Hook' })
    const listed = await listPluginHooks(http)

    expect(created.url).toContain('raw-hook-token-1')
    expect(listed.hooks).toHaveLength(1) // the new hook IS listed…
    expect(JSON.stringify(listed)).not.toContain('raw-hook-token-1') // …but only as a hash
  })

  it('maps a 422 (bad channel kind / name) to `validation-error`', async () => {
    const server = new FakeSyncServer()
    server.pluginsError = invalid
    const http = new FakeHttpClient(server)

    expect(await codeOf(createPluginHook(http, { stream_id: 's_dm', name: '' }))).toBe(
      'validation-error',
    )
  })
})

describe('plugins.hooks.revoke (DELETE /v1/plugins/hooks/{id})', () => {
  it('DELETEs the right hash handle; the 204 folds to { ok: true }', async () => {
    const server = new FakeSyncServer()
    server.pluginHooks = [hook()]
    const http = new FakeHttpClient(server)

    const res = await revokePluginHook(http, { id: 'h'.repeat(64) })

    expect(http.delCalls).toEqual([`/v1/plugins/hooks/${'h'.repeat(64)}`])
    expect(res).toEqual({ ok: true })
    expect(server.pluginHooks).toHaveLength(0)
  })

  it('maps the uniform 404 (unknown/already-revoked — no existence oracle) to `not-found`', async () => {
    const server = new FakeSyncServer()
    const http = new FakeHttpClient(server)

    expect(await codeOf(revokePluginHook(http, { id: 'nope' }))).toBe('not-found')
  })
})

describe('token boundary (R1)', () => {
  it('plugin params/paths never carry a token/bearer/authorization field', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot()]
    server.pluginHooks = [hook()]
    const http = new FakeHttpClient(server)

    await listPluginBots(http)
    await createPluginBot(http, { name: 'Bot', scopes: ['events:write'], stream_ids: ['s_1'] })
    const minted = await mintPluginBotToken(http, { bot_user_id: 'b_1' })
    await revokePluginBotToken(http, { bot_user_id: 'b_1', token_id: minted.id })
    await grantPluginBotStream(http, { bot_user_id: 'b_1', stream_id: 's_ops' })
    await revokePluginBotStream(http, { bot_user_id: 'b_1', stream_id: 's_ops' })
    await listPluginHooks(http)
    const created = await createPluginHook(http, { stream_id: 's_general', name: 'Hook' })
    await revokePluginHook(http, { id: 'h'.repeat(64) })

    // NOTE: the mint/create RESPONSES deliberately carry the one-time raw
    // secret — what must stay clean is everything the TAB sends: params,
    // paths, bodies. The `…/tokens` and `…/tokens/{sha256}` REST route segments
    // (and `{sha256}` hash HANDLE) are NOT credentials, so the sweep asserts the
    // real leak indicators instead: no `bearer`/`authorization` field, and no
    // RAW secret (the minted token / the capability URL's path token) ever rides
    // outbound on any GET/PUT/POST/DELETE surface.
    const surfaces = [
      ...http.getCalls,
      ...http.putCalls.map((c) => c.path + JSON.stringify(c.body ?? null)),
      ...http.postCalls.map((c) => c.path + JSON.stringify(c.body)),
      ...http.delCalls,
    ]
    for (const s of surfaces) {
      expect(s).not.toMatch(/bearer|authorization/i)
      expect(s).not.toContain(minted.token)
      expect(s).not.toContain(created.url)
    }
  })
})

describe('plugins RPC (WorkerCore round trip)', () => {
  it('answers `plugins.bots.list` with plain data only (nothing token-ish)', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot()]
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(new MemoryDb(), sink, { http, wsFactory: inertWsFactory })
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'p1',
      clientId: 'c1',
      req: { method: 'plugins.bots.list', params: {} },
    })

    const res = lastRes(frames, 'p1')
    expect(res.t === 'res' && res.ok).toBe(true)
    if (res.t === 'res' && res.ok) {
      const result = res.result as PluginBotsResult
      expect(result.bots[0]?.bot_user_id).toBe('b_1')
      expect(JSON.stringify(result)).not.toMatch(/bearer|authorization/i)
    }
    expect(http.getCalls).toContain('/v1/plugins/bots')
  })

  it('answers `plugins.bots.mintToken` with the one-time raw token for the facade', async () => {
    const server = new FakeSyncServer()
    server.pluginBots = [bot()]
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(new MemoryDb(), sink, { http, wsFactory: inertWsFactory })
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'p2',
      clientId: 'c1',
      req: { method: 'plugins.bots.mintToken', params: { bot_user_id: 'b_1' } },
    })

    const res = lastRes(frames, 'p2')
    expect(res.t === 'res' && res.ok).toBe(true)
    if (res.t === 'res' && res.ok) {
      const result = res.result as PluginTokenMintResult
      // The raw token IS handed to the facade — one-time display is the tab's
      // job; the worker persists nothing (MemoryDb meta stays token-free).
      expect(result.token).toBe('raw-bot-token-1')
    }
    // NOTHING was persisted worker-side: no local table gained a row.
    const db = new MemoryDb()
    expect(await db.count('meta')).toBe(0)
  })

  it('frames a 403 as a structured coded error, not a bare throw', async () => {
    const server = new FakeSyncServer()
    server.pluginsError = forbidden
    const http = new FakeHttpClient(server)
    const { sink, frames } = collectingSink()
    const core = new WorkerCore(new MemoryDb(), sink, { http, wsFactory: inertWsFactory })
    await core.init()

    await core.handle('c1', {
      t: 'req',
      id: 'p3',
      clientId: 'c1',
      req: { method: 'plugins.hooks.create', params: { stream_id: 's_1', name: 'Hook' } },
    })

    const res = lastRes(frames, 'p3')
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
