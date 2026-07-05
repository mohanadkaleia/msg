# Tech Lead Assessment: Local-First, File-Based Team Messaging App

**Reviewer role:** Staff engineer / tech lead, pre-implementation review
**Doc reviewed:** `design-doc.md` (Draft, 2026-07-03)
**Verdict summary:** Approve direction, block implementation until the decisions below are folded into the TDD.

---

## 1. Overall Verdict

**Sound and buildable — with one honest correction to its own framing.** The core technical bet (§30: append-only event log + local SQLite projection + self-hosted sync relay) is the right architecture for this product, and the doc correctly resists the two classic failure modes: syncing SQLite files directly (§22) and building on Git (§23). The scope discipline (§4, §5.5 — federation later, no E2EE, no voice/video) is exactly right.

**Strongest part:** The event-sourcing foundation (§9, §12, §22). Immutable events with client-generated IDs, server-assigned sequence, idempotent upload, tombstone deletes, last-write-wins edits — this is the correct, minimal conflict model for chat, and the doc articulates *why* better than most design docs I review.

**Weakest part:** The collision between "web-only first" (Open Q1) and "local-first" (§5.2, §8). The entire §8 local storage model — NDJSON files on disk, workspace folders, hidden files (Open Q2) — **does not exist in a browser**. A browser has IndexedDB and OPFS, storage that can be evicted, no user-visible files, and no `workspace-acme/` folder. The doc designed a desktop client's storage layer and then chose web as the first client without reconciling the two. This isn't fatal — the fix is a clean layering decision (see §4 below) — but the TDD must not inherit this confusion, or Milestone 1 will burn weeks fighting SQLite-WASM/OPFS instead of shipping chat.

Second-weakest: several **must-have features (§20.1) have no design at all** — unread state, threads, presence, notifications, auth mechanics. These are exactly the features the doc itself says make or break the polished-chat feel (§25.1). They need real designs in the TDD, not line items.

---

## 2. Strengths

1. **Correct source-of-truth split (§5.3, §5.4, §22).** "Immutable events, mutable projections" with SQLite as a rebuildable cache is the right call, and explicitly rejecting SQLite-file sync shows the author understands why (permissions, partial sync, auditability).
2. **Client-generated IDs + server sequencing (§9.2, §9.3, §11.4).** ULID/UUIDv7 from the client enables offline creation; server-assigned sequence gives deterministic final order. This two-layer identity is the load-bearing insight of the whole doc.
3. **Idempotency as a first-class protocol property (§11.3).** Retry-safe upload by `event_id` is what makes the outbox trivial. Many teams discover this in production; the doc has it up front.
4. **Simple, honest conflict model (§12).** Reactions as idempotent set-ops keyed on `(message_id, user_id, emoji)`, edits as LWW-by-server-order, deletes as tombstones. No CRDT theater. §12.5 correctly defers rich merge to post-MVP.
5. **Content-addressed attachments with hash-first upload flow (§13).** Compute sha256 → request upload → attach by `file_id`. Correct shape; enables dedup, integrity verification, and portable export.
6. **Server remains the authority in MVP (§11.4, §25.2).** "Local-first" here means local *replica*, not peer-to-peer consensus. That single decision removes ~80% of distributed-systems risk.
7. **Scope discipline (§4, §18, §20.1).** Federation is a roadmap (§18), not a requirement; the envelope carries just enough (origin, client IDs, hash fields) to not paint federation into a corner.
8. **Realistic competitive framing (§6) and positioning (§24 Option C/D).** The wedge — commercial-grade chat polish + Git-like ownership for 5–50-person technical teams — is a real gap, and §25.1's "the architecture must not make the UX worse" is the right #1 risk.
9. **Milestone 0 (§26) — CLI event-log prototype.** Cheap, fast validation of the format and replay semantics before any UI exists. Keep it.

---

## 3. Gaps, Inconsistencies, and Risks

### 3.1 Web-first vs. local-first: the doc's storage model can't run in a browser (Critical)

- §8's `workspace-acme/` folder, NDJSON logs, and `indexes/local.db` assume a filesystem. Browsers offer **IndexedDB** and **OPFS** (Origin Private File System). Neither is user-visible; both are subject to **storage eviction** unless `navigator.storage.persist()` is granted (and even then, clearing site data wipes everything).
- SQLite in the browser means **SQLite-WASM over OPFS** (official `sqlite3` WASM build with OPFS VFS, or wa-sqlite). It works, but: requires cross-origin isolation headers (COOP/COEP) for the fast SAH-pool VFS, is single-tab-writer or needs careful multi-tab coordination, adds ~1MB WASM, and FTS5 index size can be significant in browser storage quotas.
- **NDJSON event log files cannot be the browser client's durable store.** The "workspace is a folder" promise is deliverable only by (a) the server's export and (b) a future desktop app.
- **Consequence:** the doc must split "local-first architecture" (event log protocol, cursors, projections — applies everywhere) from "local-first storage" (real files — desktop/server only). My decision in §4 below.

### 3.2 Per-workspace sequencing breaks permission-scoped sync (Critical — reverse the §11.4 recommendation)

§11.4 recommends per-workspace sequence for MVP. This is wrong for this product, and the doc is internally inconsistent about it: the cursor example (§10.3), the pull API (`stream_id=...&after=`), and the client `sync_cursors` schema (§14) are all **per-stream** already.

Why per-workspace fails:

- **Private channels and DMs mean every user sees a different subset of the log.** With one workspace-wide sequence, a user's pull of `after=9283` returns a gap-filled subsequence. Either the server leaks metadata (sequence gaps reveal the existence and volume of private traffic) or the client must treat sequences as sparse and can never distinguish "gap because private" from "gap because lost event" — which destroys the simplest integrity check you have.
- **Membership changes make workspace cursors incoherent:** join a private channel and its history is *behind* your cursor; you need backfill logic anyway, so the workspace-wide cursor buys nothing.
- Per-stream sequencing at 5–50 users is trivially cheap (a counter per stream in one Postgres row or `INSERT ... RETURNING`).

**Decision: per-stream `server_sequence`, per-stream cursors, plus one special `workspace-meta` stream** (channel created/archived/renamed, user joined/left workspace, membership changes, profile updates) that every member subscribes to. Add a `GET /v1/sync` endpoint returning `{stream_id: latest_seq}` for all streams the user can read, so a reconnecting client learns what to pull in one round trip.

### 3.3 Permission changes vs. the immutable log (unspecified)

The doc checks permissions at upload time (§17) and never addresses read-side semantics over time. The TDD must state:

- **Rule (MVP): access to a stream's events requires *current* membership.** Removed from a private channel ⇒ server stops serving that stream entirely, including history. This matches mainstream team-chat semantics and is the simplest correct rule.
- **Be honest about local copies:** events already synced to a removed member's device cannot be retracted. Document this as a property of local-first, not a bug.
- **Message deletion vs. immutability:** tombstones (§12.4) hide messages in projections, but the original text stays in the log forever — on the server *and on every member's replica*. That is a real product/GDPR problem. MVP: accept it, but design the envelope now for **redaction**: server may null the payload of a referenced event and set `payload_redacted: true`; `event_hash` is defined over the client-authored portion and a redacted event is explicitly exempt from hash verification. Ship the mechanism post-MVP, reserve the field now.

### 3.4 `prev_event_hash` is unmaintainable — drop it from MVP (§9.1)

Chained by what? The doc never says. Walk through it: a client creating an event offline cannot know the true predecessor (another user or device may be writing concurrently to the same stream). If the chain is over *server* order, the server would have to inject `prev_event_hash` after sequencing — mutating the event after the client hashed/signed it, which breaks `event_hash` and any future signature. There is no assignment of `prev_event_hash` that works with concurrent offline writers.

**Decision:** remove `prev_event_hash` from the client envelope. Keep `event_hash` (content hash over canonical JSON of client-authored fields — see §3.10) for idempotency and export integrity. If tamper-evidence is wanted later, add a **server-computed transparency chain** over `(stream_id, server_sequence)` stored server-side — it's a server artifact, not a client field, and can be added without protocol changes. Same logic: `signature` stays a reserved-null field per Open Q5's "no."

Related envelope bug: §9.1 mixes client-authored fields (`event_id`, `payload`, `client_created_at`) with server-authored fields (`server_sequence`, `server_received_at`) in one object. The TDD must define the envelope as **two sections — client body (hashed) and server metadata (not hashed)** — or hashing/signing can never work.

### 3.5 Unread state: must-have feature, absent from the model

"Unread counts" is must-have (§20.1) and a top UX risk (§25.1), yet there is no `read` anything in the event model. Decide it now:

- **Read markers are NOT events in the shared log.** Every channel view would append an event; at 50 users that's the single highest-volume event type, it's per-user-private, and it pollutes the portable export with noise.
- **Decision:** per-user read-state is a separate lightweight synced KV: `(user_id, stream_id) → {last_read_seq, mention_cleared_seq}`, exposed via `PUT/GET /v1/read-state`, pushed over the same WebSocket so devices converge. Unread count = `stream_head_seq − last_read_seq` (computed from projection). Mention badges come from indexing `@mentions` at projection time.

### 3.6 Presence and typing indicators: absent

A polished chat feel is impossible without them. They must be **ephemeral protocol messages, never logged events**: WebSocket frames (`presence.update`, `typing.start/stop`), server keeps them in memory (per-connection registry; no Redis needed single-process at this scale), TTL-expired. The TDD needs a section distinguishing the three message classes: **durable events** (the log), **synced state** (read markers), **ephemeral signals** (presence/typing). The doc currently only has the first class.

### 3.7 Auth and invites: hand-waved (§16)

"Passwordless email code or password" hides an SMTP dependency that self-hosters hate on day one. Decide:

- MVP auth: **email + password (argon2id)**, opaque **per-device session tokens** (random 256-bit, server-side table `sessions(token_hash, user_id, device_id, created, last_seen, expires)`), sent as `Authorization: Bearer` for API and as the WebSocket auth param. No JWT — revocation must be instant and there's one server.
- Device ID is minted at first login per browser/app install and bound to the session; keep the §16.2 keypair fields as reserved, don't implement.
- Invites: **admin generates a single-use, expiring invite link** (token in URL). Email delivery of that link is optional (SMTP config optional). Invite acceptance = account creation + workspace membership event in `workspace-meta`.

### 3.8 Attachments: dedup has an authorization consequence; GC and quotas unaddressed

- **Content-addressing dedups across users and channels — so the blob store must never be directly addressable by hash alone.** If knowing a file's sha256 lets you download it, private-channel files leak (and "did this hash upload already?" dedup responses leak file existence). Rule: blob download is authorized through a `file_id` → stream → membership check; the server proxies or issues short-lived signed URLs. Dedup check must return only "upload needed / not needed" after the caller is already authorized to create the file record.
- **GC:** unreferenced blobs (upload without attach, deleted messages) accumulate. MVP: **no GC**, but enforce max file size (e.g., 100 MB) and per-workspace quota, and write the refcount design (blob refcount from `file.uploaded`/message references; sweep unreferenced blobs older than N days) into the TDD as post-MVP.
- Per Open Q10: local disk day one, behind a small blob-store interface so S3/MinIO slots in later. Cut MinIO from the MVP compose file (§19.1) — it contradicts Q10's answer.

### 3.9 Schema evolution: field exists, strategy doesn't

`schema_version: 1` with no rules is worse than nothing. TDD rules:

1. Version per event *type*, not just globally.
2. **Additive-only within a version**; readers must ignore unknown fields; unknown event *types* are preserved in the log and skipped by projection (forward compatibility — old clients must not crash on new event types).
3. Breaking changes = new version; server can up-convert at read time; clients declare max supported version at connect.
4. **Projection version number**: bumping it forces a local rebuild from the log — this is your escape hatch for projection bugs, and it's cheap because rebuild-from-log is already a requirement (§5.3). Make "rebuild" a tested, first-class operation from Milestone 0 onward.

### 3.10 Canonical JSON is named but not specified

`event_hash` over "canonical JSON" (§21) without a spec means every implementation disagrees. **Decide: RFC 8785 (JCS)** over the client-authored body only. One line in the TDD, saves weeks of cross-client hash mismatches.

### 3.11 Search for the web MVP

FTS5 is a client-side answer (§14.1), but the web client's storage is a cache, not a full replica (per §4 decision below), so client-side FTS can't search history the client never downloaded. **Decision: server-side search is the MVP search** — Postgres FTS (`tsvector` on message text, or a server-side SQLite FTS5 index if you go single-binary later) with filters (`from:`, `in:`, date). Client-side FTS5 becomes the desktop client's feature. The doc already anticipates this (§7.2 "optional server-side search for web clients") — make it non-optional for MVP.

### 3.12 Threads: must-have, model unspecified

Decide: **`thread_root_id` (the root `message_id`) as an optional field on `message.created`.** Threads are *not* separate streams in MVP — they share the channel's stream and sequence (the flat-channel thread model, not topic-first threading). Projection maintains `reply_count`, `last_reply_at`, participant set per root. Drop the `thread.created` event from §9's list — the first reply *is* thread creation. Thread-follow/notification granularity: post-MVP.

### 3.13 Notifications for web MVP

Nothing in the doc. MVP: **in-app** (sidebar badges, mention highlights), **tab title unread count**, and **browser Notification API** while the app is open. **Web Push (VAPID + service worker)** works fine self-hosted and needs no vendor account — make it a Milestone-3 stretch goal, not MVP-blocking. Notification *preferences* (per-channel mute, mentions-only) need a tiny settings store — same synced-KV mechanism as read state.

### 3.14 Other findings

- **Cold-start/backfill:** a new device joining a workspace with 200k events must not replay everything before rendering. Pull must support *backwards* pagination (`before=seq`) so clients fetch recent-first and lazily backfill history. This changes the pull API of §10.3/§11.1 — design it now. (True snapshots/compaction: post-MVP, per Open Q4's answer.)
- **File layout by name (§8):** `events/channels/general/…` breaks on channel rename; DM folder `alice_bob` breaks on any collision. Key everything by `stream_id`, render names in UI only. Applies to the export format.
- **Multi-tab web:** two tabs = two WebSockets and two writers to the same cache. Use a `SharedWorker` (or leader election via Web Locks) owning the socket and cache; tabs are dumb views. Cheap to do early, miserable to retrofit.
- **Server fanout at this scale:** single process, in-memory connection registry keyed by user/stream. No Redis, no queue (§19.2 already says optional — make it "absent"). Note the constraint this creates: **run one server process** (one uvicorn worker) until you outgrow it; document it in the compose file.
- **Rate limiting / event size caps:** absent. Cap event payloads (e.g., 64 KB), messages/user/minute, batch sizes. One paste of a 10 MB log into the composer shouldn't take down sync.
- **Clock skew:** `client_created_at` is untrusted; ordering and display timestamps must derive from server sequence/`server_received_at`. Say so explicitly — someone will sort by client timestamp otherwise.
- **Testing sync:** the highest-risk logic (outbox retry, cursor catch-up, idempotency, convergence) is perfectly suited to **property-based/simulation tests** (random interleavings of two clients + drops/retries ⇒ identical projections). Budget for this in Milestone 2; it's the cheapest insurance in the project.
- **Backups:** the ownership pitch demands a documented answer: server data dir (event store + blobs) is rsync/snapshot-friendly; `export` command produces the portable folder. One TDD paragraph.

---

## 4. Deferred Decisions — Decided

### Open Q3: Browser offline mode in MVP? — **No. Online-first web client on a local-first protocol; full offline is the desktop client's job.**

The MVP web client:
- keeps a **local cache** (IndexedDB via Dexie — see below) of recent events per stream + cursors, so channel switching is instant and reconnects are cheap delta pulls;
- keeps an **outbox** with idempotent retry, so transient disconnects (bad Wi-Fi, sleeping laptop) never lose a message;
- **requires connectivity for login and initial load**, and does not promise airplane-mode operation.

Rationale: full browser offline means SQLite-WASM + OPFS + COOP/COEP headers + eviction handling + multi-tab writer coordination + client-side FTS — weeks of platform work that delivers the *least* credible version of the offline promise (browsers evict storage; users clear site data). The local-first *architecture* (event log, cursors, projections, outbox, rebuild) is fully exercised by this client; the local-first *storage* promise ("workspace is a folder you own") is delivered by server export (Milestone 4) and the Tauri desktop client (Milestone 6), where real files, real SQLite, and true offline are natural. Do not use SQLite-WASM in the MVP web client — IndexedDB as a simple event/message cache is sufficient and removes the largest platform risk in the doc.

### Open Q7: Plugins server-side only at first? — **Yes. Server-side only, out-of-process, webhook-shaped.**

MVP plugin surface: (1) **incoming webhooks** (compatible with the de-facto standard incoming-webhook payload shape — instant ecosystem familiarity), (2) **outgoing event subscriptions** (server POSTs matching events to a registered plugin URL), (3) **bot users** with scoped tokens whose events are marked plugin-authored. Plugins are separate processes/containers talking HTTP — no in-process runtime, no sandbox to build, and crash isolation for free. Local/WASM plugin runtime (§15.5) is explicitly post-MVP. This makes Milestone 5 small: the manifest (§15.3) becomes a registration record, permissions map to token scopes.

### Open Q9: Durable event log file format? — **NDJSON, one file per stream per month, as the canonical export/archival format. SQLite for all hot-path storage.**

- NDJSON is greppable, appendable, streamable, diff/backup-friendly, and trivially versioned — it *is* the ownership story ("your history is lines of JSON you can read in 30 years").
- But NDJSON is the **durability/export format, not the runtime store**: the server's runtime event store is Postgres (MVP); the desktop client's is SQLite with the events table as-designed (§14). The server writes/streams NDJSON for `export`; desktop maintains NDJSON logs alongside SQLite (§8's model, verbatim). The web client has no NDJSON at all (see Q3).
- Rejected: SQLite-as-export (opaque to humans, version-coupled, not diffable) and custom binary/protobuf (kills the readability pitch). Define the export layout keyed by `stream_id` (§3.14) with a `manifest.json` (workspace metadata, format version, stream index, blob index + hashes).

### §28 Recommended Initial Decision Set — affirmed with four amendments

| Area | Doc's decision | Verdict |
| -- | -- | -- |
| MVP target: 5–50 technical teams | ✅ Affirm | |
| Client: web first | ✅ Affirm | With Q3 caveat: online-first web; offline = desktop |
| Local store: SQLite + NDJSON | ⚠️ **Amend** | True for desktop/server. Web client: IndexedDB cache only |
| Sync: client-server-client relay | ✅ Affirm | |
| Server authority: assigns final order | ✅ Affirm | |
| Offline: send offline w/ pending state | ⚠️ **Amend** | MVP: outbox survives disconnects; full offline deferred to desktop |
| Conflicts: simple deterministic rules | ✅ Affirm | |
| Attachments: content-addressed | ✅ Affirm | Add: authz by file_id not hash; no GC in MVP but quota/size caps |
| Search: SQLite FTS5 | ⚠️ **Amend** | MVP search is **server-side** (Postgres FTS). FTS5 = desktop client |
| Plugins: server-side first | ✅ Affirm | Webhook-shaped, out-of-process |
| Federation: not MVP | ✅ Affirm | |
| Deployment: Docker Compose | ✅ Affirm | Two services: app + Postgres. **Cut MinIO** (local disk per Q10) |
| Encryption: TLS first, E2EE later | ✅ Affirm | |
| **Sequencing (add)** | doc said per-workspace | ❌ **Reverse: per-stream** + `workspace-meta` stream (see §3.2) |
| **Hash chain (add)** | prev_event_hash in envelope | ❌ **Drop from MVP** (see §3.4) |

---

## 5. Stack Recommendation

**Backend: Python 3.12 + FastAPI + Postgres + SQLAlchemy (async) + uvicorn, single process. Frontend: Vue 3 + TypeScript + Pinia + Tailwind + TipTap, with Dexie (IndexedDB) for the local cache. Desktop later: Tauri wrapping the same Vue app, with real SQLite + NDJSON.**

Justification:

- **The project's existential risk is product velocity, not server throughput** (§25.1 says so itself). At 5–50 users, peak load is tens of events/second and a few hundred WebSocket connections — FastAPI handles this with an order of magnitude of headroom. Go's advantages (single binary, raw perf) solve problems this project won't have for 18 months.
- **Familiarity compounds:** the author ships Python + Vue daily (kurras). An unfamiliar Go/Rust stack taxes exactly the milestones where speed matters most (M1–M3), and this is (apparently) a solo/small-team effort where there's no one to absorb the learning curve.
- FastAPI gives WebSockets, Pydantic-validated event schemas (your event envelope becomes typed models with versioning nearly for free), and OpenAPI docs for the plugin/webhook surface.
- **Postgres over server-side SQLite** for MVP: per-stream sequence assignment under concurrent writers is a one-liner with row-level locking/`RETURNING`, and you already committed to Compose deployment. (The §19.1 "single binary + SQLite server" variant is a nice v2 packaging goal; don't build two storage backends now.)
- The single-process constraint (in-memory WebSocket fanout, §3.14) is acceptable at this scale and should be documented. If/when it isn't, that's a good problem, and the event-log architecture makes a Go rewrite of *just the sync path* feasible without touching the protocol.
- **Vue 3 + Pinia + TipTap:** as-proposed (§21), affirmed. TipTap for the composer is the right call — the composer is a top-3 UX surface (§25.1).

---

## 6. Revised Milestone Plan

§26's biggest flaw: **Milestone 1 builds a single-user local app whose storage layer (local event log in the browser) is exactly what we just cut from the web MVP.** Under the online-first web decision, the server must come before the web UI. Revised plan:

**M0 — Protocol spike (1 week, keep from doc).** CLI + library: event envelope (client-body/server-meta split), canonical JSON (JCS) hashing, NDJSON append, SQLite projection, `rebuild` command. *Exit: rebuild from log is byte-identical to incremental projection; envelope frozen enough to write the TDD schema section.*

**M1 — Sync server core (~3 weeks).** Auth (password + device sessions), invites (link-based), workspace/channel/membership model, `workspace-meta` stream, `POST /v1/events/batch` with per-stream sequencing + idempotency, `GET /v1/events` with `after=` and `before=` pagination, `GET /v1/sync` heads endpoint, WebSocket push with permission-scoped fanout, Postgres schema, Compose file (app + Postgres). *No UI; tested via the M0 CLI acting as two clients.*

**M2 — Web client + sync proof (~3 weeks).** Vue app: login, channel list, message view, composer; Dexie cache + cursors; outbox with retry; SharedWorker-owned WebSocket; reconnect catch-up; pending→acked message settling.

**M2 must prove, with automated tests, all of:** (1) idempotent retry — kill the network mid-send, retry, no duplicates; (2) two clients converge to identical order after concurrent sends; (3) reconnect after N missed events catches up via cursors with no gaps/dupes, verified against server sequence; (4) a user with no access to a private stream can neither pull nor receive its events via any endpoint (fanout included); (5) pending messages reorder correctly to server order without visible jank; (6) projection rebuild from pulled events matches incremental state. **If M2 can't demonstrate these, stop and fix the protocol before adding features.** This is the project's go/no-go gate.

**M3 — Messaging core (~5 weeks, the long one).** Threads (`thread_root_id`), reactions, edits/deletes, mentions + in-app/tab/Notification-API notifications, **read-state sync + unread badges**, **presence/typing (ephemeral)**, file upload/download (local disk, authz via file_id), server-side search, channel management, member management UI. *Exit: dogfood — the team building it uses it as its only chat for two weeks.*

**M4 — Portability (~1–2 weeks, moved up from doc's M5).** `export` → workspace folder (NDJSON per stream/month + blobs + manifest), `import`, rebuild, blob hash verification. Moved before plugins because it's small, it's *the differentiating promise*, and it hardens the same replay code M2 depends on — cheap insurance that the log really is the source of truth.

**M5 — Plugins (from doc's M4).** Incoming webhooks (de-facto-standard payload shape), outgoing event subscriptions, bot users + scoped tokens, GitHub plugin as the reference implementation.

**M6 — Desktop (Tauri) = the true local-first release.** Real SQLite + FTS5, NDJSON logs on disk, full offline, "workspace is a folder" made literal.

**Cut from the plan: Milestone 6 (federation experiment).** Per §5.5's own logic it earns nothing until the product has users; the envelope reserves what federation needs. Revisit after desktop ships.

---

## 7. Top 10 Concrete Recommendations for the Implementation TDD

1. **Split the event envelope into a hashed client body and unhashed server metadata**; specify RFC 8785 (JCS) canonicalization; **remove `prev_event_hash`**, keep `event_hash`, reserve `signature` as null. Write the full JSON Schema for every MVP event type in the TDD.
2. **Per-stream sequencing + `workspace-meta` stream + `GET /v1/sync` heads endpoint**; specify cursor semantics, `before=` backfill pagination, and the private-stream visibility rule (current-membership-gated, removal cuts all history server-side).
3. **Define the three message classes explicitly** — durable events (log), synced per-user state (read markers, notification prefs, via a KV API), ephemeral signals (presence/typing, WebSocket-only) — and which store/API owns each. This resolves unread state, presence, and settings in one framework.
4. **Web client = online-first with IndexedDB (Dexie) cache + outbox + SharedWorker-owned WebSocket; no SQLite-WASM, no browser NDJSON.** Desktop (Tauri, M6) owns full offline, SQLite+FTS5, and file-based logs. State this layering on page 1 of the TDD.
5. **Stack: FastAPI + Postgres + single-process uvicorn; Vue 3 + TS + Pinia + Tailwind + TipTap.** Document the single-writer-process fanout constraint in the compose file. Two containers only (app, Postgres); blob storage = local disk behind a storage interface.
6. **Specify auth end-to-end:** argon2id passwords, opaque per-device session tokens (server table, revocable), single-use expiring invite links (email optional), device registration at first login. No JWT, no SMTP hard dependency.
7. **Threads = `thread_root_id` on `message.created`, same stream, flat-channel semantics**; drop `thread.created` from the event list; projection maintains reply counts/participants.
8. **Attachment rules:** blob access authorized via `file_id`→stream membership, never by hash; dedup responses only post-authz; max file size + per-workspace quota; no GC in MVP but the refcount design written down; server proxies downloads in MVP.
9. **Schema evolution contract:** per-type versions, additive-only within a version, unknown fields ignored, unknown event types preserved-but-skipped, projection version bump forces rebuild. Make `rebuild` a tested first-class operation from M0.
10. **Make M2's six convergence proofs (see §6) the acceptance suite**, implemented as property-based/simulation tests (two simulated clients, random interleavings, drops, retries ⇒ identical projections), and add operational guardrails to the TDD: event size cap (~64 KB), per-user rate limits, batch limits, server-time-only ordering/display, and a one-paragraph backup story (data dir snapshot + export).

**Bottom line:** green-light the architecture; the event-log core is right and the scope discipline is real. The TDD's job is to resolve the web/local-first layering honestly, flip sequencing to per-stream, drop the hash chain, and give first-class designs to the unglamorous features — unread, presence, auth, threads — because §25.1 is correct: the architecture only matters if the chat feels better than the alternatives on day one.
