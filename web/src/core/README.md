# src/core — TS envelope / JCS / hashing (ENG-76)

Documented seam. This directory holds the browser-side envelope construction,
JCS canonicalization, and hashing that must agree **byte-for-byte** with the
Python implementation (TDD §5.1). Its Vitest suite runs against the shared
vectors in `core/testdata/vectors.json` — the same fixtures the server proves.

Empty by design at ENG-75 (scaffold). ENG-76 fills it.
