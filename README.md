# Serin

**A self-hostable, local-first team messenger where your workspace is a folder you own.**

Serin is a Slack-style team chat for small technical teams (5–50 people) that you run on a
single box. The source of truth is an **append-only event log**; every surface — server
tables, client caches, search — is a **rebuildable projection** of it. A self-hosted sync
server validates, sequences, stores, and fans out events over WebSocket; clients replicate
per-stream and render locally, so reads are instant.

- **Local-first, offline-capable** — reads serve from a local projection; the desktop client works fully offline (SQLite + FTS5 search, queued sends that drain on reconnect).
- **Your workspace is a folder** — the whole workspace exports to portable files (NDJSON logs + content-addressed blobs + a manifest) and is cryptographically re-verifiable with one command.
- **Event-sourced** — an append-only log with client-minted IDs and gapless per-stream sequencing; drop any projection and replay the log to reproduce it byte-for-byte.
- **Single box, no moving parts** — one FastAPI process + Postgres. No Redis, no message queue, no CDN. `docker compose up` and you're running.

Status: **M0–M6 shipped** — protocol, sync server, web client, messaging core, files/search/presence, portability, plugins, and the desktop offline layer. See the [roadmap](docs/technical-design.md#13-milestones) for the exact state of each.

## Quick start

Requires **Docker**. One container serves both the API and the web client from a single
origin (the image bakes the built SPA in — no separate web host, CDN, or CORS to configure).

```bash
cp .env.example .env            # set MSG_SECRET_KEY + POSTGRES_PASSWORD
docker compose up -d --build    # Postgres + migrations + API + web client
curl -fsS http://127.0.0.1:8080/healthz   # -> {"status":"ok"}
```

Then open **http://127.0.0.1:8080** and create the workspace + owner on the first-run
**`/setup`** page (available only while no users exist). You land in `#general` — send a
message and it renders optimistically, then settles once the server sequences it. Invite
teammates from the app; they join via a single-use link, and messages fan out live over
WebSocket.

> **Use `127.0.0.1`, not `localhost`.** The server binds to **`127.0.0.1:8080`** (loopback
> only, deliberately — Docker port-publishing bypasses host firewalls, so a `0.0.0.0` bind
> would expose the plain-HTTP API on every interface). For anything beyond localhost, front
> it with a TLS reverse proxy — see [`docs/deploy.md`](docs/deploy.md).

## What's in the box

| Path | What it is |
|---|---|
| [`server/`](server/) | `msgd` — the FastAPI sync server: auth, events/batch upload, sync, WebSocket fanout, Postgres + Alembic, server-side full-text search. |
| [`web/`](web/) | The Vue 3 SPA. A SharedWorker owns the session token, sync engine, projection cache, and optimistic-send outbox. Also hosts the desktop storage/offline seams. |
| [`cli/`](cli/) | `msgctl` — the admin + scripting CLI: a scriptable sync client, a standalone offline workspace tool, and the `export`/`verify`/`import` portability commands. |
| [`plugins/`](plugins/) | Out-of-process integrations. Ships `github_notifier`, the reference plugin. |
| [`docs/`](docs/) | Design, deployment, and plugin docs (see below). |

The **desktop** offline layer (SQLite + FTS5, workspace-as-a-folder mirror) ships as
headless-proven seams inside `web/src/worker/`; the native Tauri shell is still in progress
(see [Desktop](#desktop)).

## Portability — your workspace is a folder

A Serin workspace exports to a portable, self-describing bundle: NDJSON event logs
(`streams/<id>/<YYYY-MM>.ndjson`), content-addressed blobs, and a `manifest.json`. Three
server-side `msgctl` commands own the round-trip:

```bash
msgctl export ./bundle    # write a portable bundle from the live instance
msgctl verify ./bundle    # recompute every hash, check gapless sequences, seal digest
msgctl import ./bundle    # restore into a fresh instance
```

`export → import → export` is byte-identical (modulo timestamps and the tool tag), and
`verify` is the ownership pitch made testable — it re-derives every `event_hash` from the
stored bytes and proves per-stream sequence contiguity. The round-trip runs as a permanent
CI gate.

## Plugins & integrations

Plugins are **external processes** that talk to Serin over HTTP — there is no in-process
runtime and nothing to import. Two surfaces:

- **Incoming webhooks** — a capability URL that turns `POST {"text": …}` into a message in one channel. Zero-auth (the URL is the credential), write-only — ideal for notifiers.
- **Bot tokens** — a scoped bearer credential for the events/files API: a bot is a `guest` identity that can author, pull, sync, and stream live events within its explicit grants.

The bundled **`github_notifier`** posts GitHub `pull_request` events into a channel as the
reference implementation. *(Outgoing event subscriptions are designed but deferred —
[ENG-160](docs/technical-design.md#10-plugins-m5-d12).)*

See **[`plugins/README.md`](plugins/README.md)** for the plugin guide, the GitHub notifier,
and the SDK, and [`docs/plugins.md`](docs/plugins.md) for the full HTTP API contract.

## Desktop

The desktop client is the same Vue app running over native storage, giving true offline use:
a real **SQLite** projection with **FTS5** local search, queued sends that drain on
reconnect, and an on-disk workspace folder that stays `msgctl verify`-green at all times
(with the session token kept in the OS keychain, never in the folder).

The offline substance ships **headless-proven** — every storage/fs/secret seam has a Node
implementation exercised in CI. The native **Tauri shell** (window, packaging, real-network
airplane demo, OS keychain wiring) is the remaining layer that needs manual per-platform
sign-off, so it's **in progress** and not yet tagged.

## Development & docs

```bash
uv sync
uv run pytest                  # full Python suite (core, api/db/ws, simulation, exit gates)
uv run ruff check . && uv run ruff format --check .
uv run mypy

# web client (in web/)
pnpm install && pnpm test && pnpm build
```

CI (`.github/workflows/ci.yml`) runs lint, strict types, the property-based simulation
suite, the rebuild-equivalence gate, Playwright golden paths, and the per-milestone exit
gates on every push and PR.

Docs:

- [`docs/technical-design.md`](docs/technical-design.md) — the architecture and the locked decision table (D1–D14); the implementation contract.
- [`docs/deploy.md`](docs/deploy.md) — self-hosted compose deployment + TLS reverse proxy.
- [`docs/plugins.md`](docs/plugins.md) — the full plugin HTTP API contract.
- [`docs/schemas/`](docs/schemas/) — published JSON Schemas for the event envelope and payloads.

Contribution conventions: work is tracked in Linear (`ENG-xx`); commits follow
`<type>[ENG-xx]: description`; protocol changes require amending
[`docs/technical-design.md`](docs/technical-design.md), not drive-by PRs — the D1–D14
decision table is the contract.
