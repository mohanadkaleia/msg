# src/core — TS envelope / JCS / hashing (ENG-76)

Documented seam. This directory holds the browser-side envelope construction,
JCS canonicalization, and hashing that must agree **byte-for-byte** with the
Python implementation (TDD §5.1). Its Vitest suite runs against the shared
vectors in `core/testdata/vectors.json` — the same fixtures the server proves.

Filled by ENG-76:

- `jcs.ts` — RFC 8785 canonicalization (`canonicalize`), the parse-time
  ±(2^53−1) integer interop cap (`parseJcsJson`, fail-closed on runtimes without
  JSON source-text access), `MAX_DEPTH`, `JCSError`, `JSONValue`.
- `hashing.ts` — async `hashEvent` → `"sha256:<hex>"` over `crypto.subtle`.
- `ids.ts` — typed-ULID mint (CSPRNG, monotonic) / validate / parse.
- `envelope.ts` + `payloads/message.ts` — the `message.created` v1 body builder
  and `{ body, event_hash }` finalizer.
- `index.ts` — public barrel.

Scope is the send/hash path only; read-side projections, Dexie, the worker, and
non-`message.created` payloads land in later M2 tickets (ENG-77+).
