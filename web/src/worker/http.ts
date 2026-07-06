// worker/http.ts — the authed HTTP client (ENG-78, R2). A small injectable
// `fetch` wrapper: every ENG-79/81 server call reuses it. Transport-agnostic and
// mockable — no real network is needed to unit-test auth logic (the injected
// `fetchImpl` is the seam). It NEVER throws — every outcome (HTTP error, a
// non-JSON body, a network reject, a timeout) is folded into a typed `ApiResult`.
//
// The token is attached here, worker-side, as `Authorization: Bearer <token>` and
// never leaves this realm (R1). Errors are parsed from RFC 9457 problem+json.

/** Default per-request timeout; aligns with the RPC caller's 15s (rpc.ts). */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * A parsed error. `code` is either a problem `type` slug (e.g. 'invalid-credentials')
 * or one of the synthesized transport codes: `http-<status>` (opaque non-problem
 * error body), `network` (fetch reject), `timeout` (exceeded the request timeout),
 * `invalid-response` (a 2xx body that was not valid JSON).
 */
export interface ApiError {
  status: number
  code: string
  title: string
  detail?: string
  /** Parsed from the `Retry-After` header on a 429. */
  retryAfter?: number
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError }

export interface HttpClient {
  /** POST a JSON body. `authed` defaults true; login/setup/accept-invite pass false. */
  post<T>(path: string, body: unknown, opts?: { authed?: boolean }): Promise<ApiResult<T>>
  /** Authed GET returning parsed JSON. */
  get<T>(path: string): Promise<ApiResult<T>>
  /** Authed DELETE expecting 204 No Content. */
  del(path: string): Promise<ApiResult<void>>
}

export interface HttpClientDeps {
  /** Default '' → relative `/v1/...` paths (served same-origin by FastAPI, §5.1). */
  baseUrl?: string
  /** Injected in tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch
  /** Worker-held token accessor (R1). Returns null when unauthenticated. */
  getToken: () => string | null
  /**
   * Invoked on a 401 to an AUTHED request, before the typed error is returned
   * (an expired/revoked session → clear). NOT fired for an unauthed 401 (a wrong
   * password on login/setup/accept-invite must never wipe a live session).
   */
  onUnauthorized: () => void | Promise<void>
  /** Per-request timeout in ms (AbortController). Default 15s. */
  timeoutMs?: number
}

/** Minimal problem+json shape the client reads (server: msgd/api/problems.py). */
interface ProblemDocument {
  type?: string
  title?: string
  detail?: string
  status?: number
}

export function createHttpClient(deps: HttpClientDeps): HttpClient {
  const baseUrl = deps.baseUrl ?? ''
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const rawFetch = deps.fetchImpl ?? globalThis.fetch
  // Wrap so we never trip an "Illegal invocation" when the platform `fetch`
  // relies on its receiver, and so the injected impl is called uniformly.
  const doFetch: typeof fetch = (input, init) => rawFetch(input, init)

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    authed: boolean,
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {}
    const hasBody = body !== undefined
    if (hasBody) headers['Content-Type'] = 'application/json'
    if (authed) {
      const token = deps.getToken()
      if (token) headers['Authorization'] = `Bearer ${token}`
    }

    // Bound the whole request (headers + body) so a hung server never leaks a
    // pending worker-side promise. The timer is always cleared in `finally`.
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    try {
      let res: Response
      try {
        res = await doFetch(baseUrl + path, {
          method,
          headers,
          signal: controller.signal,
          ...(hasBody ? { body: JSON.stringify(body) } : {}),
        })
      } catch {
        // A network/fetch reject or our own abort — timeout is distinct from network.
        return timedOut ? timeoutError<T>() : networkError<T>()
      }

      // The single choke point that turns an expired/revoked session into a
      // re-login state for the whole app (R2). Fired only for AUTHED requests: an
      // unauthed 401 is a wrong password, not a dead session, so it must not clear.
      if (authed && res.status === 401) {
        await deps.onUnauthorized()
      }

      if (res.ok) {
        if (res.status === 204) return { ok: true, value: undefined as T }
        let text: string
        try {
          text = await res.text()
        } catch {
          return timedOut ? timeoutError<T>() : networkError<T>()
        }
        if (!text) return { ok: true, value: undefined as T }
        try {
          return { ok: true, value: JSON.parse(text) as T }
        } catch {
          // A 2xx with a non-JSON body — surface a typed error, never throw.
          return {
            ok: false,
            error: { status: res.status, code: 'invalid-response', title: 'Invalid response body' },
          }
        }
      }

      return { ok: false, error: await parseError(res) }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    post: <T>(path: string, body: unknown, opts?: { authed?: boolean }) =>
      request<T>('POST', path, body, opts?.authed ?? true),
    get: <T>(path: string) => request<T>('GET', path, undefined, true),
    del: (path: string) => request<void>('DELETE', path, undefined, true),
  }
}

async function parseError(res: Response): Promise<ApiError> {
  const retryAfter = parseRetryAfter(res.headers.get('Retry-After'))
  const fallbackCode = `http-${res.status}`
  try {
    const data = (await res.json()) as ProblemDocument
    const type = typeof data.type === 'string' ? data.type : ''
    const slug = type.split('/').pop()
    const code = slug && slug.length > 0 ? slug : fallbackCode
    return {
      status: res.status,
      code,
      title: typeof data.title === 'string' ? data.title : 'Request failed',
      ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    }
  } catch {
    // Non-JSON / opaque failure — synthesize a stable code from the status.
    return {
      status: res.status,
      code: fallbackCode,
      title: 'Request failed',
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    }
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number.parseInt(header, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

function networkError<T>(): ApiResult<T> {
  return { ok: false, error: { status: 0, code: 'network', title: 'Network error' } }
}

function timeoutError<T>(): ApiResult<T> {
  return { ok: false, error: { status: 0, code: 'timeout', title: 'Request timed out' } }
}
