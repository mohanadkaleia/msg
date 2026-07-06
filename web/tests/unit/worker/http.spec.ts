import { describe, expect, it, vi } from 'vitest'

import { createHttpClient, type HttpClientDeps } from '../../../src/worker/http'

interface Recorded {
  url: string
  init: RequestInit | undefined
}

/** A fake `fetch` that records every call and returns the queued Response. */
function fakeFetch(responder: (rec: Recorded) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const rec: Recorded = { url, init }
    calls.push(rec)
    return Promise.resolve(responder(rec))
  }) as typeof fetch
  return { fetchImpl, calls }
}

function deps(
  overrides: Partial<HttpClientDeps> & Pick<HttpClientDeps, 'fetchImpl'>,
): HttpClientDeps {
  return {
    getToken: () => 'tok-123',
    onUnauthorized: () => {},
    ...overrides,
  }
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const h = init?.headers as Record<string, string> | undefined
  return h?.[name] ?? null
}

describe('createHttpClient', () => {
  it('attaches the bearer header on an authed request when a token exists', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('{}', { status: 200 }))
    const http = createHttpClient(deps({ fetchImpl }))

    await http.get('/v1/auth/sessions')

    expect(headerOf(calls[0]?.init, 'Authorization')).toBe('Bearer tok-123')
  })

  it('omits the bearer header when the request is not authed', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('{}', { status: 200 }))
    const http = createHttpClient(deps({ fetchImpl }))

    await http.post('/v1/auth/login', { email: 'a@b.co' }, { authed: false })

    expect(headerOf(calls[0]?.init, 'Authorization')).toBeNull()
    expect(headerOf(calls[0]?.init, 'Content-Type')).toBe('application/json')
  })

  it('omits the bearer header when there is no token', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('{}', { status: 200 }))
    const http = createHttpClient(deps({ fetchImpl, getToken: () => null }))

    await http.get('/v1/auth/sessions')

    expect(headerOf(calls[0]?.init, 'Authorization')).toBeNull()
  })

  it('parses problem+json into a typed ApiError (code = /problems/<slug> tail)', async () => {
    const problem = {
      type: '/problems/invalid-credentials',
      title: 'Invalid email or password',
      status: 401,
      detail: 'invalid email or password',
    }
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(JSON.stringify(problem), {
          status: 401,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
    )
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.post('/v1/auth/login', {}, { authed: false })

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected error')
    expect(res.error).toMatchObject({
      status: 401,
      code: 'invalid-credentials',
      title: 'Invalid email or password',
      detail: 'invalid email or password',
    })
  })

  it('calls onUnauthorized on a 401', async () => {
    const onUnauthorized = vi.fn()
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ type: '/problems/unauthenticated', title: 'x', status: 401 }),
          {
            status: 401,
          },
        ),
    )
    const http = createHttpClient(deps({ fetchImpl, onUnauthorized }))

    await http.get('/v1/auth/sessions')

    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('does NOT call onUnauthorized on a 401 from an unauthed request', async () => {
    const onUnauthorized = vi.fn()
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ type: '/problems/invalid-credentials', title: 'x', status: 401 }),
          { status: 401 },
        ),
    )
    const http = createHttpClient(deps({ fetchImpl, onUnauthorized }))

    // A wrong-password login is an unauthed 401 — the caller handles it; a live
    // session (if any) must not be wiped.
    const res = await http.post('/v1/auth/login', {}, { authed: false })

    expect(onUnauthorized).not.toHaveBeenCalled()
    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('invalid-credentials')
  })

  it('returns a typed invalid-response error for a non-JSON 2xx body', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('not json at all', { status: 200 }))
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.get('/v1/auth/sessions')

    if (res.ok) throw new Error('expected error')
    expect(res.error).toMatchObject({ status: 200, code: 'invalid-response' })
  })

  it('returns a typed timeout ApiResult when the request exceeds the timeout', async () => {
    // A fetch that never resolves but honors the abort signal.
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })) as typeof fetch
    const http = createHttpClient(deps({ fetchImpl, timeoutMs: 10 }))

    const res = await http.get('/v1/slow')

    if (res.ok) throw new Error('expected error')
    expect(res.error).toMatchObject({ status: 0, code: 'timeout' })
  })

  it('parses Retry-After on a 429', async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ type: '/problems/rate-limited', title: 'Too many', status: 429 }),
          {
            status: 429,
            headers: { 'Retry-After': '30' },
          },
        ),
    )
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.post('/v1/auth/login', {}, { authed: false })

    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('rate-limited')
    expect(res.error.retryAfter).toBe(30)
  })

  it('synthesizes http-<status> for a non-JSON / opaque failure', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>boom</html>', { status: 502 }))
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.get('/v1/auth/sessions')

    if (res.ok) throw new Error('expected error')
    expect(res.error).toMatchObject({ status: 502, code: 'http-502', title: 'Request failed' })
  })

  it('folds a network/fetch rejection into ApiError{status:0, code:network}', async () => {
    const fetchImpl = (() => Promise.reject(new Error('offline'))) as typeof fetch
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.get('/v1/auth/sessions')

    if (res.ok) throw new Error('expected error')
    expect(res.error).toMatchObject({ status: 0, code: 'network' })
  })

  it('returns ok/void for a 204 on del', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }))
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.del('/v1/auth/sessions/abc')

    expect(res.ok).toBe(true)
    expect(calls[0]?.init?.method).toBe('DELETE')
  })

  it('prefixes a non-empty baseUrl', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('{}', { status: 200 }))
    const http = createHttpClient(deps({ fetchImpl, baseUrl: 'https://api.example.com' }))

    await http.get('/v1/auth/sessions')

    expect(calls[0]?.url).toBe('https://api.example.com/v1/auth/sessions')
  })
})
