# msg

**Best-in-class team messaging where the workspace is portable, self-hostable, scriptable, and syncs like Git.**

msg is a local-first, file-based team messaging app for 5–50-person technical teams. The source of truth is an **append-only event log**; every rendering surface — server tables, client caches, search — is a **rebuildable projection** of it. A self-hosted sync server validates, sequences, stores, and fans out events; clients replicate per-stream and render locally.

> **Local-first *architecture* is universal. Local-first *storage* is per-platform.**
> The protocol (client-minted event IDs, per-stream cursors, idempotent upload, outbox, projection rebuild) applies to every client. The files (NDJSON logs, SQLite, "workspace is a folder") live on the server as the export format, and later on the desktop client.

## Status

**M0 — Protocol spike: complete** (tagged [`m0`](https://github.com/mohanadkaleia/msg/releases/tag/m0)). The event protocol is proven end-to-end in miniature: envelope schema locked, cross-language hash vectors frozen, and the rebuild ≡ incremental equivalence gate running permanently in CI.

**M1 — Sync server: complete** (tagged `m1`). msg is now a client-server system: token auth + sessions + single-use invites, streams + membership with a §3.6 read/write permission predicate, a `workspace-meta` stream, idempotent batch upload with gapless per-stream sequencing, pull/sync bootstrap, permission-scoped WebSocket fanout, Postgres + Alembic migrations, one-command compose self-host, and a simulation-suite skeleton (four of six §12 invariants) green in CI. The M1 exit gate proves two `msgctl` clients converge over the *real* server under interleaved bidirectional traffic.

**M2 — Web client + sync proof: complete** (tagged `m2`). There is now a browser client: a Vue shell (sidebar, virtualized message list, plain-textarea composer, Cmd+K workspace switcher) backed by a SharedWorker that owns the session token, the authed HTTP client, the sync engine, the Dexie projection cache, and an optimistic-send outbox that drains on reconnect. Reads are instant and local (the projection); sends render optimistically and settle under their hash-bound `stream_id`. The Docker image now **bakes the built SPA** and serves it single-origin from the same origin as `/v1` — `docker compose up -d --build` yields a working web client at `http://localhost:8080`. The M2 exit gate is **all six §12 invariants green in CI** (Python sim owns 1–4 + server rebuild-equivalence; a TS `fast-check` suite owns pending-settling + client Dexie rebuild-equivalence, driving the real worker) plus a Playwright golden path — login → send → reload → history intact → a second browser sees the message live via WS fanout — on uvicorn's **default** WebSocket backend (ENG-92).

| Milestone | Scope | Status |
|---|---|---|
| **M0 — Protocol spike** | `core/` envelope + JCS + hashing; `msgctl` append → project → rebuild → verify | ✅ Done |
| **M1 — Sync server** | Auth, streams, batch upload, sync, WebSocket fanout, Postgres | ✅ Done |
| **M2 — Web client + sync proof** | Vue shell, SharedWorker + Dexie, six invariants green in CI | ✅ Done |
| M3 — Messaging core | Threads, reactions, mentions, files, search, presence | Next |
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
      api/            # FastAPI app: auth, /v1/events(/batch), /v1/sync, /v1/ws
      db/             # SQLAlchemy models + Alembic migrations (Postgres)
      ws/             # WebSocket hub — permission-scoped fanout, heartbeat
      projections/    # server messages_proj: incremental apply + rebuild
    tests/            # core + api/db/ws tests, schema/vector freeze guards, simulation suite
  cli/
    msgctl/           # workspace CLI: init, send, project, verify, rebuild;
                      #   remote verbs: login, push, pull, invite
    tests/            # rebuild ≡ incremental gate + the M1 exit-gate E2E (integration)
  docs/
    schemas/          # published JSON Schemas (envelope + message.created & meta payloads)
    deploy.md         # self-hosted compose deployment guide
  docker-compose.yml  # one-command self-host: Postgres + the sync server
  .github/workflows/  # CI: ruff, mypy (strict), equivalence gate, pytest (incl. integration E2E), simulation suite
```

## Quickstart

Run everything — Postgres, the sync server, and the web client — with one command, then use it from your browser. Requires **Docker**, plus **Python 3.12 + [uv](https://docs.astral.sh/uv/)** for the `msgctl` admin CLI (used once, to create the first account).

**1. Start the server.** One container serves the API *and* the web client from a single origin — the image bakes the built SPA in, so there's no separate web host, CDN, or CORS to configure:

```bash
cp .env.example .env            # set MSG_SECRET_KEY + POSTGRES_PASSWORD
docker compose up -d --build    # Postgres + migrations + API + web client
curl -fsS http://localhost:8080/healthz   # -> {"status":"ok"}
```

The server binds to **`127.0.0.1:8080`** (loopback only, deliberately — Docker port-publishing bypasses host firewalls, so a `0.0.0.0` bind would expose the plain-HTTP API on every interface). For anything beyond localhost, front it with the TLS reverse proxy in [`docs/deploy.md`](docs/deploy.md).

**2. Create the workspace + owner.** There is no self-serve signup — the first account is minted from the CLI:

```bash
uv sync
uv run msgctl login ./acme --setup \
  --server-url http://localhost:8080 \
  --email owner@example.com --password '…' \
  --workspace-name Acme --display-name Owner
```

**3. Open the web client** at **http://localhost:8080** and log in as `owner@example.com`. You land in `#general`; send a message — it renders **optimistically** the instant you hit send and settles once the server sequences it. Reads are instant (served from the local projection, not a round-trip). Press <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> to fuzzy-jump between channels.

**4. Invite a teammate.** Mint an invite and hand over the join URL:

```bash
uv run msgctl invite ./acme --role member
# -> {"url": "http://localhost:8080/join/<token>", "expires_at": "..."}
```

Open that **join URL** in another browser (or an incognito window) — it loads the accept-invite page, where the teammate sets a display name, email, and password to register and join. (The bare `http://localhost:8080` just redirects to login; a brand-new teammate has no account yet, so the `/join/<token>` link is what registers them.) Now post from either side and the other browser receives it **live via WebSocket fanout**, no reload. Drop the network mid-send and the outbox holds the message as pending; restore it and it flushes — reads stay instant and local throughout.

> msg is **online-first** in the browser (full browser offline is desktop, M6). "Offline-ish" means the outbox survives a transient disconnect and drains on reconnect, and every read is served from the local projection — not that the app runs fully offline.

## The `msgctl` CLI

`msgctl` is the admin tool you used above (bootstrap + invites) — and also a scriptable sync client and a standalone offline workspace tool. It has two modes.

**Remote** — drive a running server. `push` is only a hint that new events are queued; **cursors are the truth** — `pull` is idempotent and converges every client to the same gapless per-stream sequence the server assigned.

```bash
uv run msgctl login ./bob --invite-token <token-from-the-join-url> \
  --server-url http://localhost:8080 \
  --email bob@example.com --password '…' --display-name Bob
uv run msgctl send ./bob --stream general --text "hi, owner"
uv run msgctl push ./bob      # upload queued events to the server
uv run msgctl pull ./bob      # mirror the server's streams locally
```

**Offline / local** — no server. A workspace is just a folder (`workspace.json` + `streams/<stream_id>/<YYYY-MM>.ndjson`, the same tree the M4 export format uses):

```bash
uv run msgctl init ./demo
uv run msgctl send ./demo --stream general --text "hello, world"
uv run msgctl project ./demo   # materialize the SQLite projection (idempotent)
uv run msgctl rebuild ./demo   # drop it + replay the whole log (temp DB + atomic swap)
uv run msgctl verify ./demo    # recompute every hash, check gapless sequences (--json for CI)
```

`verify` is the ownership pitch made testable — on any workspace, local or synced, it re-derives every `event_hash` from the stored bytes and proves per-stream sequence contiguity.

## Development

```bash
uv sync
uv run pytest                  # full suite
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

CI runs all of the above on every push and PR, plus a dedicated **`Equivalence gate (rebuild ≡ incremental)`** step — a hypothesis property test proving that dropping the projection and replaying the log always reproduces the incremental state byte-for-byte. That gate is the M0 exit criterion and is kept forever (TDD §5); it extends to server projections at M1 and the browser cache at M2. At M1 the `pytest` step also runs the `integration`-marked E2Es — including the exit-gate test that stands up a real Postgres + the live server and drives two `msgctl` clients to convergence — and a separate **`Simulation suite`** step runs the §12 property-based harness (four of six invariants at M1).

### The M2 hard gate — all six §12 invariants green in CI

M2's exit criterion (TDD §13) is that **all six §12 invariants** are asserted green in CI. They are split across two languages, each owning the property in the language it lives in (see [`.claude/chat/eng-83-acceptance-architecture.md`](.claude/chat/eng-83-acceptance-architecture.md)):

| # | Invariant | CI job · step |
|---|---|---|
| 1 | Idempotency | `lint · type · test` · **Simulation suite** |
| 2 | Convergence | `lint · type · test` · **Simulation suite** |
| 3 | Cursor integrity | `lint · type · test` · **Simulation suite** |
| 4 | Permission isolation | `lint · type · test` · **Simulation suite** |
| 5 | Pending settling | `web · lint · type · test · build` · **Invariant suite (§12)** |
| 6 | Rebuild equivalence — client (Dexie) | `web · lint · type · test · build` · **Invariant suite (§12)** |
| 6 | Rebuild equivalence — server (`messages_proj`) | `lint · type · test` · **Equivalence gate** |

Invariants 5 and client-6 are [`fast-check`](https://github.com/dubzzz/fast-check) property suites that drive the **real** worker engine (`web/tests/unit/worker/invariant{5,6}-*.property.spec.ts`). The `e2e · golden path` job additionally runs a Playwright smoke over the real production stack (login → send → reload → history intact → a second browser sees the message live via WS fanout). The suites have **teeth**: `MSG_MUTATE=inv5-drop-ack` and `MSG_MUTATE=inv6-rebuild-skew` flip in a client bug that turns the respective suite red (green by default).

> **Live WS on the default self-host config (ENG-92, resolved).** The "second browser sees the message live via WS fanout" leg runs against uvicorn's **default/shipped `websockets` backend** — exactly what a real self-host runs — with **no `--ws` override**. ENG-92 fixed the server's bearer-subprotocol WS auth to normalize the un-split `["bearer, <token>"]` that the default backend surfaces in the ASGI scope, so the WS upgrade authenticates out of the box. Live sync is therefore certified on the default config, not a workaround.

**Required checks (branch protection).** The M2/M3 gate is the conjunction of the jobs whose names are **`lint · type · test`** (inv 1–4 + server-6), **`web · lint · type · test · build`** (inv 5 + client-6), and **`e2e · golden path`**. Marking these "required" in GitHub branch protection is a repo-settings change (outside CI-file scope) — a maintainer must set it.

Contribution conventions: work is tracked in Linear (`ENG-xx`); commits follow `<type>[ENG-xx]: description`; protocol changes require amending `docs/technical-design.md`, not drive-by PRs — the D1–D14 decision table is the contract.
