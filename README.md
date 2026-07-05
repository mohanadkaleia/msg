# msg

**Best-in-class team messaging where the workspace is portable, self-hostable, scriptable, and syncs like Git.**

msg is a local-first, file-based team messaging app for 5–50-person technical teams. The source of truth is an **append-only event log**; every rendering surface — server tables, client caches, search — is a **rebuildable projection** of it. A self-hosted sync server validates, sequences, stores, and fans out events; clients replicate per-stream and render locally.

> **Local-first *architecture* is universal. Local-first *storage* is per-platform.**
> The protocol (client-minted event IDs, per-stream cursors, idempotent upload, outbox, projection rebuild) applies to every client. The files (NDJSON logs, SQLite, "workspace is a folder") live on the server as the export format, and later on the desktop client.

## Status

**M0 — Protocol spike: complete** (tagged [`m0`](https://github.com/mohanadkaleia/msg/releases/tag/m0)). The event protocol is proven end-to-end in miniature: envelope schema locked, cross-language hash vectors frozen, and the rebuild ≡ incremental equivalence gate running permanently in CI.

| Milestone | Scope | Status |
|---|---|---|
| **M0 — Protocol spike** | `core/` envelope + JCS + hashing; `msgctl` append → project → rebuild → verify | ✅ Done |
| M1 — Sync server | Auth, streams, batch upload, sync, WebSocket fanout, Postgres | Next |
| M2 — Web client + sync proof | Vue shell, SharedWorker + Dexie, six invariants green in CI | — |
| M3 — Messaging core | Threads, reactions, mentions, files, search, presence | — |
| M4 — Portability | `export` / `import` / `verify` round-trip | — |
| M5 — Plugins | Industry-standard incoming webhooks, bot tokens | — |
| M6 — Desktop (Tauri) | True offline; "workspace is a folder" | — |

Full design docs: [`docs/design-doc.md`](docs/design-doc.md) (product), [`docs/tech-lead-assessment.md`](docs/tech-lead-assessment.md) (pre-implementation review), [`docs/technical-design.md`](docs/technical-design.md) (the implementation contract — locked decisions D1–D14 live here).

## The protocol in one paragraph

Every event is an envelope with a client-authored `body` and server-assigned `server` metadata. `event_hash = sha256(JCS(body))` — SHA-256 over the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonicalization of the body only; the server never mutates an accepted body. All entity IDs are typed ULIDs (`w_`, `u_`, `s_`, `m_`, `f_`, `d_`), client-mintable and offline-safe. The server assigns a **gapless, monotonic `server_sequence` per stream**; a gap means data loss, not permissions. Uploads are idempotent by `event_id` — retries can never duplicate. Unknown event types are preserved in the log, skipped in projections, and never crash anything. The canonical JSON test vectors that every implementation (Python today, TypeScript at M2) must pass byte-for-byte are frozen in [`server/msgd/core/testdata/vectors.json`](server/msgd/core/testdata/vectors.json); JSON Schemas for the envelope and payloads are published in [`docs/schemas/`](docs/schemas/).

## Repository layout

```text
msg/
  server/
    msgd/
      core/           # event envelope, JCS canonicalization, hashing, payload schemas
        testdata/     # frozen cross-language hash vectors (47 cases)
    tests/            # core tests + schema/vector freeze guards
  cli/
    msgctl/           # workspace CLI: init, send, project, verify, rebuild
    tests/            # incl. the permanent rebuild ≡ incremental equivalence gate
  docs/
    schemas/          # published JSON Schemas (envelope, message.created v1)
  .github/workflows/  # CI: ruff, mypy (strict), equivalence gate, pytest
```

## Quickstart (M0: local workspace via `msgctl`)

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/).

```bash
uv sync

# Create a workspace folder
uv run msgctl init ./demo

# Append messages (envelope built, hashed, sequenced, fsync'd — one NDJSON line per event)
uv run msgctl send ./demo --stream general --text "hello, world"
uv run msgctl send ./demo --stream general --text "second message"

# Materialize the SQLite projection incrementally (idempotent — run it twice)
uv run msgctl project ./demo

# Drop the projection and replay the whole log (temp DB + atomic swap)
uv run msgctl rebuild ./demo

# Recompute every hash, check gapless sequences, validate schemas
uv run msgctl verify ./demo            # human report
uv run msgctl verify ./demo --json     # machine-readable, CI-friendly exit codes
```

The workspace is just a folder: `workspace.json` plus `streams/<stream_id>/<YYYY-MM>.ndjson` — the same tree the M4 export format uses. `verify` is the ownership pitch made testable: it re-derives every `event_hash` from the stored bytes and proves per-stream sequence contiguity.

## Development

```bash
uv sync
uv run pytest                  # full suite
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

CI runs all of the above on every push and PR, plus a dedicated **`Equivalence gate (rebuild ≡ incremental)`** step — a hypothesis property test proving that dropping the projection and replaying the log always reproduces the incremental state byte-for-byte. That gate is the M0 exit criterion and is kept forever (TDD §5); it extends to server projections at M1 and the browser cache at M2.

Contribution conventions: work is tracked in Linear (`ENG-xx`); commits follow `<type>[ENG-xx]: description`; protocol changes require amending `docs/technical-design.md`, not drive-by PRs — the D1–D14 decision table is the contract.
