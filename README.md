# msg

**Best-in-class team messaging where the workspace is portable, self-hostable, scriptable, and syncs like Git.**

msg is a local-first, file-based team messaging app for 5–50-person technical teams. The source of truth is an **append-only event log**; every rendering surface — server tables, client caches, search — is a **rebuildable projection** of it. A self-hosted sync server validates, sequences, stores, and fans out events; clients replicate per-stream and render locally.

> **Local-first *architecture* is universal. Local-first *storage* is per-platform.**
> The protocol (client-minted event IDs, per-stream cursors, idempotent upload, outbox, projection rebuild) applies to every client. The files (NDJSON logs, SQLite, "workspace is a folder") live on the server as the export format, and later on the desktop client.

## Status

**M0 — Protocol spike: complete** (tagged [`m0`](https://github.com/mohanadkaleia/msg/releases/tag/m0)). The event protocol is proven end-to-end in miniature: envelope schema locked, cross-language hash vectors frozen, and the rebuild ≡ incremental equivalence gate running permanently in CI.

**M1 — Sync server: complete** (tagged `m1`). msg is now a client-server system: token auth + sessions + single-use invites, streams + membership with a §3.6 read/write permission predicate, a `workspace-meta` stream, idempotent batch upload with gapless per-stream sequencing, pull/sync bootstrap, permission-scoped WebSocket fanout, Postgres + Alembic migrations, one-command compose self-host, and a simulation-suite skeleton (four of six §12 invariants) green in CI. The M1 exit gate proves two `msgctl` clients converge over the *real* server under interleaved bidirectional traffic.

**M2 — Web client + sync proof: complete** (tagged `m2`). There is now a browser client: a Vue shell (sidebar, virtualized message list, plain-textarea composer, Cmd+K workspace switcher) backed by a SharedWorker that owns the session token, the authed HTTP client, the sync engine, the Dexie projection cache, and an optimistic-send outbox that drains on reconnect. Reads are instant and local (the projection); sends render optimistically and settle under their hash-bound `stream_id`. The Docker image now **bakes the built SPA** and serves it single-origin from the same origin as `/v1` — `docker compose up -d --build` yields a working web client at `http://localhost:8080`. The M2 exit gate is **all six §12 invariants green in CI** (Python sim owns 1–4 + server rebuild-equivalence; a TS `fast-check` suite owns pending-settling + client Dexie rebuild-equivalence, driving the real worker) plus a Playwright golden path — login → send → reload → history intact → a second browser sees the message live via WS fanout — on uvicorn's **default** WebSocket backend (ENG-92).

**M3 — Messaging core: complete** (tagged `m3`). The chat surface is now real: **reactions** (emoji chips with an idempotent optimistic toggle), **edit** and **delete** on your own messages (an `(edited)` marker; a soft-delete tombstone), **threads** (a right-hand reply pane rooted on any message), **@mentions** with `@`/`#` autocomplete from a zero-network directory projection, and **channel & DM management** (create a public/private channel, browse channels, start a 1:1 DM) — all authored worker-side and fanned out live over WS. The composer is now TipTap (markdown shortcuts, mention chips) at the same seam, still sending markdown SOURCE text (never HTML). The six §12 invariants now exercise the M3 event types end to end — the Python simulation folds reactions/edits/deletes/threads/`dm.created` into convergence + permission-isolation, and the TS `fast-check` client-rebuild gate proves out-of-order (windowed newest-first + backfill) delivery still converges — and the Playwright **`e2e`** job drives the whole messaging-core golden path (react → edit → delete → thread reply → @mention → create channel → start DM) with a second browser seeing message + reaction + thread-reply live, on the default WS backend.

**M3.5 — Files, search, presence, notifications: complete** (tagged `m3.5`). The workspace now carries **file attachments** (drag/drop/paste onto the composer → content-addressed upload; messages render an image thumbnail or a file card, and download streams the bytes through the SharedWorker so the token never touches the tab), **message search** (server-side Postgres full-text, readable-scoped in-query so you never see a hit from a stream you can't read; a top-bar overlay with `in:#channel`/`from:@name` filters, match highlighting, and jump-to-message), **read-state + notification prefs** that sync per-user across your devices (monotonic read markers; per-channel `all`/`mentions`/`mute`), **live presence + typing** (an online dot on avatars; an "X is typing…" line — both ephemeral, WS-only, never written to the log), and **notifications** (in-app toasts + an unread tab-title count + a permission-gated browser Notification, gated by your per-channel prefs; opening a channel marks it read and clears its badge). `file.uploaded` is the only new event type (additive under D9 — no envelope or decision changed); read-state, prefs, presence, and typing are deliberately non-event state. The §12 gates grew to match — the simulation drives real upload/attach ops + a file/search isolation adversary, the client rebuild gate replays `file.uploaded` under out-of-order delivery, and a fourth Playwright leg drives files, search, presence/typing, and notifications over the real stack on the default WS backend.

| Milestone | Scope | Status |
|---|---|---|
| **M0 — Protocol spike** | `core/` envelope + JCS + hashing; `msgctl` append → project → rebuild → verify | ✅ Done |
| **M1 — Sync server** | Auth, streams, batch upload, sync, WebSocket fanout, Postgres | ✅ Done |
| **M2 — Web client + sync proof** | Vue shell, SharedWorker + Dexie, six invariants green in CI | ✅ Done |
| **M3 — Messaging core** | Reactions, edit/delete, threads, @mentions, channel & DM management | ✅ Done |
| **M3.5 — Files, search, presence, notifications** | Attachments + thumbnails, server search, read-state + prefs sync, presence/typing, notifications | ✅ Done |
| M4 — Portability | `export` / `import` / `verify` round-trip | ⏭ Next |
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
        testdata/     # frozen cross-language hash vectors (60 cases: + reactions, edits, deletes, file.uploaded)
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
  --email owner@example.com --password 'correct-horse-battery-staple' \
  --workspace-name Acme --display-name Owner
```

Passwords must be **at least 12 characters** (that demo passphrase clears the bar). For real use, omit `--password` to be prompted, or set `MSGCTL_PASSWORD` — either keeps the secret out of your shell history and the process list.

**3. Open the web client** at **http://localhost:8080** and log in as `owner@example.com`. You land in `#general`; send a message — it renders **optimistically** the instant you hit send and settles once the server sequences it. Reads are instant (served from the local projection, not a round-trip). Press <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> to fuzzy-jump between channels.

**4. Invite a teammate.** Mint an invite and hand over the join URL:

```bash
uv run msgctl invite ./acme --role member
# -> {"url": "http://localhost:8080/join/<token>", "expires_at": "..."}
```

Open that **join URL** in another browser (or an incognito window) — it loads the accept-invite page, where the teammate sets a display name, email, and password to register and join. (The bare `http://localhost:8080` just redirects to login; a brand-new teammate has no account yet, so the `/join/<token>` link is what registers them.) Now post from either side and the other browser receives it **live via WebSocket fanout**, no reload. Drop the network mid-send and the outbox holds the message as pending; restore it and it flushes — reads stay instant and local throughout.

> msg is **online-first** in the browser (full browser offline is desktop, M6). "Offline-ish" means the outbox survives a transient disconnect and drains on reconnect, and every read is served from the local projection — not that the app runs fully offline.

## What you can do (M3 — messaging core)

Once you're in, the chat surface is a real one. Everything below authors an event in the worker (the token never leaves it), renders **optimistically**, settles when the server sequences it, and fans out **live** to everyone else over WebSocket:

- **React** — hover a message for the quick 👍 ❤️ 😂 bar or the emoji picker; chips aggregate with a who-reacted tooltip, and clicking your own chip removes it. Reactions are an idempotent toggle, so a double-tap or a racing duplicate can never double-count.
- **Edit** — edit your own message inline (ArrowUp on an empty composer jumps to your last one); an `(edited)` marker appears. Concurrent edits converge to the last writer by server sequence.
- **Delete** — soft-delete your own message: it's replaced by a muted "message deleted" tombstone for everyone, and its text is redacted from the read model. This **removes it from view**; it is *not* a cryptographic erasure — the append-only log still holds the original, and true redaction is a tracked follow-up (ENG-111). The confirm dialog says so honestly.
- **Threads** — "Reply in thread" opens a right-hand pane rooted on any message; the root shows a live reply count + participant avatars. Threads are flat (one level), and the count is delete-aware (deleting a reply decrements it).
- **@mentions** — type `@` for people or `#` for channels; the autocomplete is served instantly from a local directory projection (no round-trip per keystroke). Mentioned users get a badge on the channel.
- **Channels & DMs** — create a public or private channel, browse and open public channels, and start a 1:1 direct message with any teammate — all from the sidebar. Invited teammates auto-join `#general`, so nobody lands in an empty workspace.

Every hostile input path — message text, author and reactor and participant display names, opaque reaction bytes — is rendered through escaping-only bindings (no `v-html`), so a `<img onerror>` display name is inert.

## What you can do (M3.5 — files, search, presence, notifications)

M3.5 fills in the surfaces a real workspace needs day to day:

- **Attach files** — drag, drop, or paste a file onto the composer; it uploads to **content-addressed** blob storage (behind a `BlobStore` interface, so S3/MinIO is a later config change) and sends with your message. Images render an inline **server-generated thumbnail** (best-effort WEBP, decoded from untrusted bytes behind a decompression-bomb guard and always re-encoded); other files render a download card. Every fetch — thumbnail, preview, download — runs in the SharedWorker and hands the tab a local `blob:` URL, so the session token never reaches page code.
- **Search messages** — a top-bar search overlay runs **server-side Postgres full-text** search, scoped **in the SQL itself** to streams you can read (a term that appears only in a private channel or DM you're not in returns nothing — no existence oracle). Narrow with `in:#channel` / `from:@name`, see the matched terms highlighted, and click a hit to **jump** to that message.
- **Read-state + notification prefs, synced** — your read markers and per-channel notification level (`all` / `mentions` / `mute`) sync across your own devices with a same-user WebSocket echo. Read markers only ever move forward (monotonic); prefs are last-write-wins. Neither is an event — they're synced per-user KV, exempt from log rebuild.
- **Presence + typing** — teammates show a live **online dot** on their avatars, and an "X is typing…" line appears above the composer while someone types. Both are **ephemeral**: relayed over the WebSocket only, held in memory with a short TTL, and **never written to the log** (a reload starts them blank by design).
- **Notifications** — a new message you should see raises an in-app **toast**, bumps an unread count in the **tab title**, and (if you grant permission) fires a browser **Notification** — all gated by the per-channel pref, and never for your own messages or the conversation you're already looking at. Opening a channel marks it read and clears its badge.

Hostile input stays inert here too: file names, MIME types, search snippets, and display names all render through escaping-only bindings (no `v-html`); the matched-term highlight is plain text segments wrapped in `<mark>`, never built from an HTML string.

**Deferred out of M3.5** (tracked, not shipped): **pins** (a fast-follow, ENG-119), **Web Push** (server-side push to a closed tab), and **group DMs** (DMs are 1:1 for now), plus the remaining Ranin UI follow-ups.

## The `msgctl` CLI

`msgctl` is the admin tool you used above (bootstrap + invites) — and also a scriptable sync client and a standalone offline workspace tool. It has two modes.

**Remote** — drive a running server. `push` is only a hint that new events are queued; **cursors are the truth** — `pull` is idempotent and converges every client to the same gapless per-stream sequence the server assigned.

```bash
uv run msgctl login ./bob --invite-token <token-from-the-join-url> \
  --server-url http://localhost:8080 \
  --email bob@example.com --password 'correct-horse-battery-staple' --display-name Bob
uv run msgctl send ./bob --stream general --text "hi, owner"
uv run msgctl push ./bob      # upload queued events to the server
uv run msgctl pull ./bob      # mirror the server's streams locally
```

Passwords must be **12+ characters**. Omit `--password` to be prompted, or set `MSGCTL_PASSWORD`, to keep it out of your shell history.

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

Invariants 5 and client-6 are [`fast-check`](https://github.com/dubzzz/fast-check) property suites that drive the **real** worker engine (`web/tests/unit/worker/invariant{5,6}-*.property.spec.ts`). The `e2e · golden path` job additionally runs Playwright over the real production stack — the ENG-83 smoke (login → send → reload → history intact → a second browser sees the message live via WS fanout) **and** the ENG-105 messaging-core golden path (react → edit → delete → thread reply → @mention → create channel → start DM, second browser sees message + reaction + thread reply live). The suites have **teeth**: `MSG_MUTATE=inv5-drop-ack` and `MSG_MUTATE=inv6-rebuild-skew` flip in a client bug that turns the respective suite red (green by default).

> **The six invariants exercise the M3 event types (M3).** The gate steps and their names are unchanged, but their coverage now spans the M3 surface: the Python **Simulation suite** interleaves reactions, edits, deletes, threaded replies and `dm.created` and folds them into convergence + a permission-isolation adversary that also cannot react into, edit in, reply into, or read a stream/DM it may not; the server **Equivalence gate** replays reactions/edits/deletes/threads through `messages_proj` + `reactions_proj` + `thread_participants_proj`; and the client **Invariant suite (§12)** exercises the M3 optimistic ops and proves `rebuild ≡ incremental` under **out-of-order windowed** (newest-first + backfill) delivery, with deterministic teeth for reply-before-root, reaction `removed@lo`+`added@hi`, and edit-before-create. The frozen cross-language vectors grew 47→55 (adding `reaction.added/removed` + `message.edited/deleted`, byte-identical in Python and TS); `channel.created`/`dm.created` vectors are deferred to ENG-110.

> **The gates extend again for M3.5 (files/search/presence/notifications).** Same steps, same names, wider coverage: the Python **Simulation suite** now also drives real file **upload + attach** ops (`message.created.file_ids`) and a file/search **isolation adversary** (a non-member's search returns zero private hits; a borrowed cross-stream file binding → `unknown_file`); the client **Invariant suite (§12)** replays `file.uploaded` under the same out-of-order windowed delivery with its own deterministic teeth; and the frozen cross-language vectors grew 55→60 (adding `file.uploaded`, byte-identical in Python and TS, `VECTORS_SHA256` bumped in lock-step). Read-state, prefs, presence, and typing are **non-event** state (never appended/projected/rebuilt), guarded by a negative test asserting a full presence/typing + read-state/prefs session leaves the `events` count and every projection dump byte-identical. The `e2e` job gains a fourth Playwright leg over the real single-origin stack — attach → render → byte-identical download → image thumbnail; search token → highlighted hit → jump; two-browser presence + typing; and @mention-while-unfocused → in-app toast + mention badge → open-to-clear.

> **Live WS on the default self-host config (ENG-92, resolved).** The "second browser sees the message live via WS fanout" leg runs against uvicorn's **default/shipped `websockets` backend** — exactly what a real self-host runs — with **no `--ws` override**. ENG-92 fixed the server's bearer-subprotocol WS auth to normalize the un-split `["bearer, <token>"]` that the default backend surfaces in the ASGI scope, so the WS upgrade authenticates out of the box. Live sync is therefore certified on the default config, not a workaround.

**Required checks (branch protection).** The M2/M3 gate is the conjunction of the jobs whose names are **`lint · type · test`** (inv 1–4 + server-6), **`web · lint · type · test · build`** (inv 5 + client-6), and **`e2e · golden path`**. Marking these "required" in GitHub branch protection is a repo-settings change (outside CI-file scope) — a maintainer must set it.

Contribution conventions: work is tracked in Linear (`ENG-xx`); commits follow `<type>[ENG-xx]: description`; protocol changes require amending `docs/technical-design.md`, not drive-by PRs — the D1–D14 decision table is the contract.
