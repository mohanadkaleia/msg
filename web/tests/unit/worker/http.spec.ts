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

// A fetch that never resolves but honors the abort signal (drives timeout/abort tests).
const neverResolvesHonorsAbort = ((_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })) as typeof fetch

describe('createHttpClient binary transfer (putBlob/getBlob, ENG-119)', () => {
  it('putBlob sends the RAW body (never JSON) with the bearer + declared content type', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    const http = createHttpClient(deps({ fetchImpl }))
    const blob = new Blob(['\x00\x01binary'], { type: 'image/png' })

    const res = await http.putBlob('/v1/files/f_1/blob', blob, { contentType: 'image/png' })

    expect(res.ok).toBe(true)
    // The exact Blob is handed to fetch — NOT JSON.stringify'd.
    expect(calls[0]?.init?.body).toBe(blob)
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(headerOf(calls[0]?.init, 'Authorization')).toBe('Bearer tok-123')
    expect(headerOf(calls[0]?.init, 'Content-Type')).toBe('image/png')
  })

  it('putBlob defaults the content type to application/octet-stream (never json)', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }))
    const http = createHttpClient(deps({ fetchImpl }))

    await http.putBlob('/v1/files/f_1/blob', new ArrayBuffer(4))

    expect(headerOf(calls[0]?.init, 'Content-Type')).toBe('application/octet-stream')
  })

  it('putBlob folds a 413 into a typed ApiResult error (never throws)', async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ type: '/problems/file-too-large', title: 'Too large', status: 413 }),
          { status: 413 },
        ),
    )
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.putBlob('/v1/files/f_1/blob', new Blob(['x']))

    if (res.ok) throw new Error('expected error')
    expect(res.error).toMatchObject({ status: 413, code: 'file-too-large' })
  })

  it('putBlob folds a network reject into ApiError{code:network}', async () => {
    const fetchImpl = (() => Promise.reject(new Error('offline'))) as typeof fetch
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.putBlob('/v1/files/f_1/blob', new Blob(['x']))

    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('network')
  })

  it('putBlob has NO default timer — an external signal abort folds to network, not timeout', async () => {
    // Default putBlob timeout is null (no timer); only the caller signal can abort.
    // Getting `network` (not `timeout`) here proves our internal timer never fired.
    const controller = new AbortController()
    const http = createHttpClient(deps({ fetchImpl: neverResolvesHonorsAbort }))

    const pending = http.putBlob('/v1/files/f_1/blob', new Blob(['x']), {
      signal: controller.signal,
    })
    controller.abort()
    const res = await pending

    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('network')
  })

  it('putBlob honors an explicit per-call timeoutMs', async () => {
    const http = createHttpClient(deps({ fetchImpl: neverResolvesHonorsAbort }))

    const res = await http.putBlob('/v1/files/f_1/blob', new Blob(['x']), { timeoutMs: 10 })

    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('timeout')
  })

  it('putBlob attaches the bearer through the SAME authed path (401 → onUnauthorized)', async () => {
    const onUnauthorized = vi.fn()
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(JSON.stringify({ type: '/problems/unauthenticated', status: 401 }), {
          status: 401,
        }),
    )
    const http = createHttpClient(deps({ fetchImpl, onUnauthorized }))

    await http.putBlob('/v1/files/f_1/blob', new Blob(['x']))

    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('getBlob returns the response Blob + mime type, bypassing the JSON path', async () => {
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response('not-json-just-bytes', {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        }),
    )
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.getBlob('/v1/files/f_1/thumbnail')

    if (!res.ok) throw new Error('expected ok')
    // A Blob is returned verbatim (never JSON.parse'd) with its content type intact.
    expect(res.value.blob).toBeInstanceOf(Blob)
    expect(res.value.blob.size).toBe('not-json-just-bytes'.length)
    expect(res.value.mimeType).toBe('image/webp')
    expect(headerOf(calls[0]?.init, 'Authorization')).toBe('Bearer tok-123')
  })

  it('getBlob folds a 404 into a typed ApiResult error', async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ type: '/problems/not-found', title: 'Not found', status: 404 }),
          {
            status: 404,
          },
        ),
    )
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.getBlob('/v1/files/f_1')

    if (res.ok) throw new Error('expected error')
    expect(res.error).toMatchObject({ status: 404, code: 'not-found' })
  })

  it('getBlob folds a network reject (never throws)', async () => {
    const fetchImpl = (() => Promise.reject(new Error('offline'))) as typeof fetch
    const http = createHttpClient(deps({ fetchImpl }))

    const res = await http.getBlob('/v1/files/f_1')

    if (res.ok) throw new Error('expected error')
    expect(res.error.code).toBe('network')
  })
})
