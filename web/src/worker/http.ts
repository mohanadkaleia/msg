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
 * Default `getBlob` timeout — a download is bounded, but a large blob over a slow
 * link needs more headroom than a JSON round trip (ENG-119). `null` disables it.
 */
const GET_BLOB_TIMEOUT_MS = 60_000

/**
 * Default `putBlob` timeout — DELIBERATELY `null` (no timer). A 50 MB upload over a
 * slow uplink must not be killed at 15s; cancellation is caller-driven via
 * `opts.signal` (the FileManager's per-job AbortController), not a wall clock.
 */
const PUT_BLOB_TIMEOUT_MS: number | null = null

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

/** Per-call knobs for the binary transfer methods (ENG-119). */
export interface BlobRequestOptions {
  /**
   * Per-call timeout in ms, or `null` to DISABLE the timer entirely (cancellation
   * then rides `signal` only). `undefined` → the method's own default (`putBlob`:
   * none; `getBlob`: {@link GET_BLOB_TIMEOUT_MS}).
   */
  timeoutMs?: number | null
  /** Caller abort (a per-upload/download AbortController) — merged with the timer. */
  signal?: AbortSignal
}

export interface HttpClient {
  /** POST a JSON body. `authed` defaults true; login/setup/accept-invite pass false. */
  post<T>(path: string, body: unknown, opts?: { authed?: boolean }): Promise<ApiResult<T>>
  /**
   * Authed PUT of a JSON body (ENG-126, mirrors {@link post}): `Content-Type:
   * application/json`, bearer attached, 401 → `onUnauthorized`, never throws. Used
   * by the synced-KV writes (`/v1/read-state`, `/v1/prefs`). NOT the raw-bytes
   * {@link putBlob} — that path is `application/octet-stream` and never JSON.
   */
  put<T>(path: string, body: unknown): Promise<ApiResult<T>>
  /**
   * Authed PATCH of a JSON body (ENG-151, mirrors {@link put}): same bearer /
   * problem+json / never-throw discipline. Used by the admin pass-through RPCs
   * (`PATCH /v1/admin/members/{user_id}`).
   */
  patch<T>(path: string, body: unknown): Promise<ApiResult<T>>
  /** Authed GET returning parsed JSON. */
  get<T>(path: string): Promise<ApiResult<T>>
  /** Authed DELETE expecting 204 No Content. */
  del(path: string): Promise<ApiResult<void>>
  /**
   * Authed PUT of RAW bytes (ENG-119). The `Blob`/`ArrayBuffer` is handed straight
   * to `fetch` (the browser chunk-streams it — NEVER JSON.stringify'd); the
   * `Content-Type` is `opts.contentType ?? 'application/octet-stream'`, NEVER
   * `application/json`. A 2xx (empty body) → `{ ok: true, value: undefined }`.
   */
  putBlob(
    path: string,
    body: Blob | ArrayBuffer,
    opts?: BlobRequestOptions & { contentType?: string },
  ): Promise<ApiResult<void>>
  /**
   * Authed GET of RAW bytes (ENG-119). On 2xx returns the response `Blob` + its
   * `Content-Type` (bypassing the JSON path entirely); a 404 folds through the
   * shared `parseError`. Same bearer / never-throw / 401 discipline as the rest.
   */
  getBlob(
    path: string,
    opts?: BlobRequestOptions,
  ): Promise<ApiResult<{ blob: Blob; mimeType: string }>>
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

  /**
   * The ONE authed transport core (ENG-119 refactor): attach the bearer, bound the
   * call (an internal timer AND/OR a caller `signal`, merged into one
   * AbortController), fire the single `authed && 401 → onUnauthorized` choke point,
   * and fold every fetch reject/abort into a typed `network`/`timeout` error so the
   * client NEVER throws. The response BODY is interpreted by the `onOk` callback —
   * the only thing that differs between JSON (`request`) and binary (`putBlob`/
   * `getBlob`) — while the timer still covers the body read (`foldReadError`
   * distinguishes a mid-read abort from a genuine parse failure).
   *
   * `timeoutMs: null` disables the internal timer (a large `putBlob` bounded only by
   * `signal`); otherwise the timer + the external signal both abort the same
   * controller, and `finally` always clears the timer + detaches the listener.
   */
  async function send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: { headers: Record<string, string>; body?: BodyInit; authed: boolean },
    timeout: number | null,
    externalSignal: AbortSignal | undefined,
    onOk: (res: Response, foldReadError: () => ApiError) => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> {
    const headers = { ...init.headers }
    if (init.authed) {
      const token = deps.getToken()
      if (token) headers['Authorization'] = `Bearer ${token}`
    }

    const controller = new AbortController()
    let timedOut = false
    const timer =
      timeout === null
        ? undefined
        : setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeout)
    // Merge the caller's signal (per-upload/download cancel) into the same
    // controller so either source aborts the one in-flight fetch.
    const onExternalAbort = (): void => controller.abort()
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', onExternalAbort)
    }
    const foldReadError = (): ApiError => (timedOut ? TIMEOUT_ERROR : NETWORK_ERROR)

    try {
      let res: Response
      try {
        res = await doFetch(baseUrl + path, {
          method,
          headers,
          signal: controller.signal,
          ...(init.body !== undefined ? { body: init.body } : {}),
        })
      } catch {
        // A network/fetch reject or our own abort — timeout is distinct from network.
        return { ok: false, error: foldReadError() }
      }

      // The single choke point that turns an expired/revoked session into a
      // re-login state for the whole app (R2). Fired only for AUTHED requests: an
      // unauthed 401 is a wrong password, not a dead session, so it must not clear.
      if (init.authed && res.status === 401) {
        await deps.onUnauthorized()
      }

      if (res.ok) return await onOk(res, foldReadError)
      return { ok: false, error: await parseError(res) }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }

  function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    authed: boolean,
  ): Promise<ApiResult<T>> {
    const hasBody = body !== undefined
    return send<T>(
      method,
      path,
      {
        authed,
        headers: hasBody ? { 'Content-Type': 'application/json' } : {},
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
      },
      timeoutMs,
      undefined,
      async (res, foldReadError) => {
        if (res.status === 204) return { ok: true, value: undefined as T }
        let text: string
        try {
          text = await res.text()
        } catch {
          return { ok: false, error: foldReadError() }
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
      },
    )
  }

  return {
    post: <T>(path: string, body: unknown, opts?: { authed?: boolean }) =>
      request<T>('POST', path, body, opts?.authed ?? true),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body, true),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body, true),
    get: <T>(path: string) => request<T>('GET', path, undefined, true),
    del: (path: string) => request<void>('DELETE', path, undefined, true),

    putBlob: (path, body, opts) =>
      send<void>(
        'PUT',
        path,
        {
          authed: true,
          // NEVER application/json — raw bytes, streamed by the browser as-is.
          headers: { 'Content-Type': opts?.contentType ?? 'application/octet-stream' },
          body,
        },
        opts?.timeoutMs === undefined ? PUT_BLOB_TIMEOUT_MS : opts.timeoutMs,
        opts?.signal,
        // A successful blob upload has an empty (or ignorable) body — 2xx is enough.
        () => Promise.resolve({ ok: true, value: undefined }),
      ),

    getBlob: (path, opts) =>
      send<{ blob: Blob; mimeType: string }>(
        'GET',
        path,
        { authed: true, headers: {} },
        opts?.timeoutMs === undefined ? GET_BLOB_TIMEOUT_MS : opts.timeoutMs,
        opts?.signal,
        async (res, foldReadError) => {
          try {
            const blob = await res.blob()
            return { ok: true, value: { blob, mimeType: res.headers.get('content-type') ?? '' } }
          } catch {
            return { ok: false, error: foldReadError() }
          }
        },
      ),
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

/** A fetch reject (offline / DNS / connection drop) — status 0, never a throw. */
const NETWORK_ERROR: ApiError = { status: 0, code: 'network', title: 'Network error' }

/** Our own AbortController fired the internal timer — distinct from `network`. */
const TIMEOUT_ERROR: ApiError = { status: 0, code: 'timeout', title: 'Request timed out' }
