# ENG-81 — M2 Outbox + optimistic send

Branch: `mohanad/eng-81-m2-outbox-optimistic-send-buildhash-in-worker-pending-render` (off origin/main @ 085ab79)
Implementer: single `ui-engineer` agent. All work under `web/`.
Delivers §12 invariant 5 (pending settling) + folds in the ENG-79/80 projection-seam wiring gap.

---

## Implementation Plan

### 0. Grounding — the seams that already exist (reuse, do not reinvent)

- **Core send spine (ENG-76):** `@/core` exports `buildMessageCreatedBody(opts) → Body`, `finalizeEnvelope(body) → { body, event_hash }` (awaits `hashEvent` = SHA-256 over JCS of `body` only, D1), `newEventId()`, `newMessageId()`. The worker send path uses these verbatim — **no JCS/hash/id reimplementation.**
- **Projection apply (ENG-80):** `applyEventsToProjection(db, streamId, events)` upserts `MessageRow` by `message_id` (idempotent, D9-safe skip). `applyMessageCreatedV1(event, body)` is the pure event→row map with `created_seq = event.server_sequence`. `rebuildMessagesProjection(db)` / `rebuildProjections(db)` replay `events`. `dumpMessages(db)` is the ENG-83 equivalence surface.
- **Sync engine (ENG-79):** owns `cursors`, the `events` write path, and the state machine `idle→connecting→syncing→live→degraded`. WS `message.created` frames land via `onEventFrame → withStreamLock → applyForward → verifyAndStore(putEvents) → callSeam(applyToProjection)`. Backoff `backoffDelay(attempt)` = `min(cap, base·2^attempt)` jittered to `[base/2, base]`, consts `RECONNECT_BASE_MS=1000` / `RECONNECT_CAP_MS=30000` ("mirrors the outbox numbers").
- **HTTP (ENG-78):** injected `HttpClient.post<T>(path, body)` attaches `Authorization: Bearer` worker-side; never throws, folds every failure into `ApiResult`. The token never crosses the RPC surface.
- **Schema (ENG-77):** the `outbox` table already exists — `outbox: 'event_id, created_at'`, row `{ event_id, created_at, body, state }`. `MsgDb` already has `putOutbox` / `listOutbox`. `clearDerivedTables`/`evictStream` structurally cannot touch `outbox` (it is a source table).
- **Server batch contract (ENG-66):** `POST /v1/events/batch` `{ events:[{body,event_hash}] }` → 200 `{ accepted:[{event_id,stream_id,server_sequence,server_received_at}], rejected:[{event_id,code,detail}] }`. `event_id` is UNIQUE per workspace; re-POST of an accepted event returns the **original** accepted record (same sequence) — this is what makes the outbox a dumb retry loop. Reject codes: `permission_denied | invalid_schema | hash_mismatch | payload_too_large | unknown_stream`.

### 1. Files to change / create (all under `web/`)

Create:
- `src/worker/outbox.ts` — the `Outbox` class (send / retry / delete / drain), the pure `buildPendingMessageRow`, and `applyOutboxToProjection` (rebuild re-derivation).
- `src/worker/backoff.ts` — the extracted pure `backoffDelay(attempt, {baseMs, capMs, random?})` + `OUTBOX_BASE_MS`/`OUTBOX_CAP_MS` (= 1000 / 30000). Shared by sync + outbox (DRY).
- `tests/unit/worker/outbox.spec.ts` — the outbox test suite.

Edit:
- `src/worker/types.ts` — `MutateParams` → discriminated union; `MutateResult<M>` conditional; new result shapes; extend `OutboxRow` + `MessageRow`; add `MsgDb` methods; bump `PROJECTION_VERSION`.
- `src/worker/db.ts` — implement the new `MsgDb` methods in **both** `DexieDb` and `MemoryDb`; extend `rebuildProjections` to re-derive pending rows from `outbox`.
- `src/worker/projection.ts` — no logic change to settled apply; `dumpMessages`/`serializeRow` stay byte-identical (pending rows serialize through the existing field set — see §5).
- `src/worker/sync.ts` — refactor `backoffDelay` to call the shared helper (delete the divergent-risk local copy; keep the existing exported `RECONNECT_*` consts pointing at it).
- `src/worker/core.ts` — construct `Outbox`; replace the `mutate` stub with a real dispatcher; **change the default `applyToProjection` to the real projection (the FOLD-IN fix, §7)**; kick the drain on the rising edge to `live`; update `RpcResultMap['mutate']`.
- `tests/unit/worker/core.spec.ts` + `tests/unit/worker/client.spec.ts` — update the two tests that assert the `mutate` `not_implemented` stub (ENG-81 replaces it, as the type comment predicted). Add the live-WS-event→`messages` wiring test.
- `tests/unit/worker/projection-equivalence.spec.ts` — add the rebuild-reproduces-pending case.
- `tests/unit/worker/helpers.ts` — extend `FakeHttpClient.post` + `FakeSyncServer` with a batch responder (assigns sequences, enforces `event_id` idempotency, configurable rejects).

**No edits to `client.ts` (WorkerClient surface) beyond the two-test fix, and no edits to the three transport entry files** — see §7 for why the DRY seam fix lives in `WorkerCore`.

### 2. Data model — outbox row + pending/settled state on `messages`

**`OutboxRow`** (extend the ENG-77 shape; new fields are non-indexed so no Dexie version bump):

```ts
interface OutboxRow {
  event_id: string                              // bare ULID (envelope.body.event_id) — PK, UNIQUE server-side
  created_at: number                            // ms epoch, minted at send; oldest-first drain key + pending order
  body: Record<string, unknown>                 // the §2.1 hashed body (verbatim, the exact bytes hashed)
  event_hash: string                            // NEW: sha256:… computed at send (so drain re-POSTs {body,event_hash} with zero rework)
  message_id: string                            // NEW (denormalized from body.payload.message_id) — links to the projection row
  stream_id: string                             // NEW (denormalized from body.stream_id) — publish + settle target
  state: 'queued' | 'sending' | 'rejected'      // queued=to send; sending=in-flight (crash-recover as queued); rejected=parked
  error_code?: string                           // NEW: rejection code when state==='rejected' (surfaced as failed)
}
```

**`MessageRow`** — add an optional lifecycle marker (absent = settled/normal, the steady state):

```ts
interface MessageRow {
  … existing fields …
  state?: 'pending' | 'failed'                  // NEW: absent = settled
  error_code?: string                           // NEW: rejection code when state==='failed'
}
```

- **Pending `created_seq` = `created_at` (ms epoch).** A pending row has no server sequence yet, so it reuses `created_seq` as a client-only ordering sentinel = its `created_at` (ms). ms-epoch (~1.75e12) is orders of magnitude above any realistic per-stream `server_sequence`, so pending rows sort **after** every settled row (`listMessagesByStream` is DESC `created_seq` → newest-first → pending renders at the bottom, §5.3). Among themselves pending rows order by `created_at`. This value is a pure function of the outbox row, so rebuild reproduces it exactly. It is **never** written into `events.server_sequence` (D2 respected — it is not a server sequence).
- **On settle**, `created_seq` is overwritten with the real `server_sequence` and `state` is dropped — the row moves from "bottom / greyed" into true server order (§5.3), in place (same `message_id` PK).
- Provisional timestamp / greyed render is a tab-side concern (ENG-82) keyed off `state === 'pending'`; the worker only sets the `state` field.

### 3. RPC surface — carried on the existing `mutate` verb (D-7)

The four-verb taxonomy routes durable mutations through `mutate`; `types.ts` already flags "ENG-81 replaces the stub member with real mutations." So instead of minting new RPC methods we specialize `MutateParams` (no `WorkerClient`/transport surface change — tabs call `client.mutate({...})`):

```ts
type MutateParams =
  | { m: 'outbox.send'; stream_id: string; text: string;
      format?: 'markdown' | 'plain'; thread_root_id?: string; mentions?: string[]; file_ids?: string[] }
  | { m: 'outbox.retry'; event_id: string }
  | { m: 'outbox.delete'; event_id: string }

interface SendResult { message_id: string; event_id: string; created_seq: number }  // enough for the tab to locate its optimistic row
interface OutboxActionResult { ok: true }

type MutateResult<M extends MutateParams> =
  M extends { m: 'outbox.send' } ? SendResult :
  M extends { m: 'outbox.retry' | 'outbox.delete' } ? OutboxActionResult : never
```

`RpcResultMap['mutate']` (core.ts) becomes `SendResult | OutboxActionResult`. `WorkerCore` registers `mutate` as a dispatcher on `params.m` (exhaustive `switch`, mirroring `handleQuery`), each arm delegating to the `Outbox`.

**`outbox.send`** (worker-side, all identity read worker-side — never from the tab):
1. Require auth: `my_user_id`/`workspace_id` from `this.auth.status()`, `author_device_id` from `db.metaGet(META_DEVICE_ID)`. If unauthenticated → throw a coded RPC error (`not_authenticated`).
2. `body = buildMessageCreatedBody({ workspace_id, stream_id, author_user_id, author_device_id, client_created_at: new Date().toISOString(), text, format?, thread_root_id?, mentions?, file_ids? })` — mints `event_id` + `message_id` inside core.
3. `{ body, event_hash } = await finalizeEnvelope(body)`.
4. `putOutbox([{ event_id, created_at, body, event_hash, message_id, stream_id, state:'queued' }])`.
5. `putMessages([ buildPendingMessageRow(outboxRow) ])` (state `'pending'`, `created_seq = created_at`).
6. `publishStream(stream_id)` → subscribed tabs re-query and see the pending row instantly.
7. Kick `drain()` (fire-and-forget; coalesced).
8. Return `{ message_id, event_id, created_seq }`.

**`outbox.retry(event_id)`:** if the row is `rejected` → set `state:'queued'`, clear `error_code`; re-put the projection row as `pending` (clear `failed`/`error_code`); `publishStream`; kick `drain()`. `{ ok:true }`.

**`outbox.delete(event_id)`:** `deleteOutbox(event_id)` + delete the projection row by `message_id` (only if not settled — a settled row keeps living in `events`; a `failed`/`pending` row is removed). `publishStream`. `{ ok:true }`.

### 4. Drain loop

`Outbox` deps (all injected → browser-free unit tests): `{ db, http, publishStream, setTimeout?, clearTimeout? }`. It is transport-agnostic and sits behind the `WorkerCore(db, sink)` + injected-HTTP seam like the sync engine.

- **Coalescing (one in flight):** a `draining` boolean + a `rerun` flag. `drain()` returns immediately if `draining`, setting `rerun=true`; the running loop re-checks `rerun` on completion and re-enters. Guarantees exactly one `POST /v1/events/batch` sequence at a time regardless of how many `send`s/live-kicks fire.
- **Oldest-first batch:** `listOutbox()` → filter `state !== 'rejected'` → sort by `created_at` asc → take up to `MAX_BATCH = 100` (server cap). Mark them `sending`. POST `{ events: rows.map(r => ({ body:r.body, event_hash:r.event_hash })) }`.
- **Per-event outcome** (200 with accepted/rejected arrays):
  - **accepted:** settle (§6), then `deleteOutbox(event_id)`.
  - **rejected:** set outbox `state:'rejected'` + `error_code=code`; set the projection row `state:'failed'` + `error_code`; `publishStream`. The row is **parked** — future drains skip it (filter above) so a poison event never wedges the queue; the rest of the batch still settles.
- **Transient whole-request failure** (`ApiResult.ok===false`: `network`/`timeout`/`http-5xx`): revert the in-flight rows `sending → queued`, schedule a retry via `backoffDelay(attempt, {baseMs:1000, capMs:30000})` on the injected clock, increment `attempt`. A `401` clears the session app-wide via the shared http client's `onUnauthorized` (already wired) and stops the loop.
- **Success resets `attempt = 0`.**
- **Backoff reuse:** both sync.ts and outbox.ts import `backoffDelay` from the new `backoff.ts`. sync.ts's private `backoffDelay` is refactored to call it (same formula, same 1s→30s+jitter) — one source of truth, no divergent duplication.
- **Connectivity hook (auto-send on reconnect):** the drain is kicked on the **rising edge into `live`**. `WorkerCore` already routes sync status through `emitStatus: (status) => this.publish({kind:'sync'}, status)`; wrap it to also call `this.outbox.drain()` when `status.state === 'live'` (track prior state for the edge; a redundant call is a cheap no-op via coalescing). A message composed offline sits `queued`; when connectivity resumes the sync engine reconnects → `syncing` → `live`, which fires the kick and the message sends itself. No separate navigator-online plumbing is introduced (the existing `notifyOnline` gap is pre-existing ENG-79 scope, out of band here).

### 5. Ack-vs-WS-frame convergence — exactly one row (the critical design)

**Dedup keys:** `message_id` (PK of `messages`) for the projection; `[stream_id+server_sequence]` and the `event_id` index for `events`. Both are upserts.

**Why exactly one row, in any interleaving:** the client mints `message_id` and `event_id` once, at send. The server stores `body` **verbatim** (raw-hash discipline, D1) and returns the same `server_sequence` for that `event_id` on every accept (idempotent, D2). Therefore the WS `event` frame the sync engine applies and the batch `accepted` record the outbox settles describe the **same event, same body bytes, same server_sequence**. Both settle paths derive the `MessageRow` through the **same** `applyMessageCreatedV1`/`applyEventsToProjection` code, so the settled row is a byte-identical pure function of (body, server_sequence). "Whoever writes second" is a no-op overwrite of an identical row keyed by the same `message_id`. The pending row shares that `message_id`, so settling **replaces it in place** — there is never a second row and never a pending+settled pair.

**Ordering within the outbox settle (§6):** `putEvents([eventRow])` → `applyEventsToProjection(db, streamId, [eventRow])` → `deleteOutbox(event_id)`. `applyEventsToProjection` reads the in-memory `EventRow` (not the db), so the settle does not depend on the event already being stored.

**The two races, resolved:**
- **WS frame lands before ack:** the sync engine has already put the event into `events` and overwritten the pending row with the settled row. The ack then re-puts the identical event (idempotent `bulkPut` on the same `[stream_id+server_sequence]` key) and re-settles (identical upsert) — both no-ops — and its remaining real work is `deleteOutbox(event_id)`. One row.
- **Ack lands before WS frame:** the ack settled the row and stored the event. The later WS frame enters `onEventFrame`; either the cursor already covers this seq (`seq <= cur` → ignored as a duplicate) or it is `cur+1` and `applyForward` re-applies the identical row / `> cur+1` triggers a gap pull that re-fetches it idempotently. One row.

**Cursor ownership:** the ack path deliberately does **not** advance `cursors` — cursor advancement stays the sync engine's single-writer job (a WS frame or the next reconnect reconciles). The ack storing an event at seq N ahead of the cursor is a normal "stored-but-uncursored" state the engine already tolerates (`rederiveCursorsFromEvents`, gap pulls). This avoids two writers racing on the cursor. `messages.list` reads the `messages` table (not cursors), so the settled row is visible immediately regardless.

### 6. Settle (`accepted` → move outbox into events + settle projection)

Given an `AcceptedEvent { event_id, stream_id, server_sequence, server_received_at }` and the outbox row it matches:
1. Build the stored `EventRow`: `{ stream_id, server_sequence, event_id, type: body.type, envelope: { body, event_hash, server: { server_sequence, server_received_at } } }` — the same shape the sync engine stores, so a later WS frame is a true idempotent duplicate.
2. `putEvents([eventRow])` (idempotent by `[stream_id+server_sequence]`).
3. `applyEventsToProjection(db, stream_id, [eventRow])` → settled `MessageRow` (`created_seq = server_sequence`, no `state`), upsert by `message_id` — replaces the pending row in place.
4. `deleteOutbox(event_id)`.
5. `publishStream(stream_id)`.

### 7. FOLD-IN — projection-seam wiring fix (the inert seam)

**Root cause:** all three transports (`shared-worker.ts:22`, `leader.ts:148`, `client.ts:124` solo) call `new WorkerCore(db, sink)` with no `applyToProjection`, so the sync engine gets `noopApplyToProjection` — live WS events land in `events` but never in `messages`. The `messages` table only refills on a version-bump rebuild, not from live sync.

**Fix (DRY, single site):** in `WorkerCore`'s constructor, change the default from `noopApplyToProjection` to a real bound default:

```ts
applyToProjection: options.applyToProjection ??
  ((streamId, events) => applyEventsToProjection(this.db, streamId, events)),
```

This fixes **all three** entry points at once (they share this constructor) with zero duplication — the DRY-est possible resolution of "wire it across all three." `WorkerCore` is already the composition root that owns `db` and constructs the sync engine (and now the outbox), and it already imports from `projection.ts`, so no new import cycle. Tests that need the no-op still inject it explicitly; existing `new WorkerCore(db, sink)` tests never open a socket, so the default never fires spuriously.

> Fallback (only if review insists the wiring be explicit at each composition root): add `createWorkerCore(db, sink, opts?)` to a shared module that binds the seam, and call it from the three entry files. Not preferred — it re-introduces three call sites for something the constructor default already covers.

**Wiring test** (`core.spec.ts`): construct `WorkerCore(db, sink)` with a fake `wsFactory` + fake authed `http`, `init()`, drive sync to `live`, feed a `message.created` WS `event` frame, then `query { q:'messages.list', stream_id }` returns the message. Asserts the seam is live (fails against the pre-fix noop default).

### 8. Rebuild reproduces settled + pending state (keep rebuild ≡ incremental green)

Bump `PROJECTION_VERSION` 1 → 2 (MessageRow shape changed → existing clients rebuild on boot).

`rebuildProjections(db)` gains a second step after `rebuildMessagesProjection`:
1. Replay `events` → settled rows (existing).
2. `applyOutboxToProjection(db)`: for each `outbox` row whose `event_id` is **not** present in `events` (i.e. not yet settled), upsert the derived row via the **same** `buildPendingMessageRow` used by the incremental send path — `state:'pending'`, or `state:'failed'`+`error_code` when the outbox row is `rejected`. Rows whose `event_id` **is** in `events` are skipped (the crash-between-putEvents-and-deleteOutbox case → the settled row already won, exactly as in the incremental state).

Because both the pending derivation (`buildPendingMessageRow`) and the settled derivation (`applyEventsToProjection`) are shared verbatim between incremental and rebuild, **rebuild ≡ incremental holds by construction** and `dumpMessages(incremental) === dumpMessages(rebuild)` stays byte-equal — including the (now possibly present) pending/failed rows. `serializeRow` is left unchanged: a pending row serializes with `created_seq = created_at` and the existing field set; determinism is preserved on both sides. `evictStream`/`clearDerivedTables` never touch `outbox`, so a rebuild always has the full outbox to re-derive from.

New `MsgDb` methods (implement in `DexieDb` + `MemoryDb`):
- `deleteOutbox(eventId: string): Promise<void>`
- `getOutbox(eventId: string): Promise<OutboxRow | undefined>`
- `hasEvent(eventId: string): Promise<boolean>` (Dexie: `events.where('event_id').equals(id).count() > 0`; Memory: scan) — the rebuild "already settled?" guard.

### 9. Test plan (`web/tests/unit/worker/`, `MemoryDb` + fake authed HTTP + fake WS; browser-free)

Harness prerequisite: extend `helpers.ts` — `FakeSyncServer.uploadBatch(events)` assigns per-stream sequences, enforces `event_id` UNIQUE (re-POST returns the original `accepted`, never a dup), supports a configurable per-event reject; `FakeHttpClient.post` routes `/v1/events/batch` to it (today it returns `undefined`).

1. **send → pending → ack settling** (`outbox.spec.ts`): `mutate outbox.send` → `messages.list` returns 1 row, `state:'pending'`, `created_seq === created_at` (renders at bottom), `outbox.count === 1`, `events.count === 0`. Drive `drain` (server accepts, assigns seq N). After: 1 row, `state` absent, `created_seq === N`, `outbox.count === 0`, `events.count === 1`.
2. **pending is readable immediately** with no network: after `send` (before any drain), `dumpMessages`/`messages.list`/`message.get` all include the pending row; assert `http.postCalls` still empty until the drain kick resolves offline (see #4).
3. **ack-vs-WS-frame dedup race — BOTH orders:**
   - (a) WS frame first: feed the WS `event` frame for the sent `event_id`/seq N through the sync engine, then run the drain ack. Assert `getAllMessages().length === 1`, `events.count === 1`, `outbox.count === 0`, `row.created_seq === N`.
   - (b) Ack first: run the drain ack, then feed the same WS frame. Assert identical end state (`length === 1`, one event, settled).
4. **offline compose → reconnect drain:** `isOnline=false` (sync `degraded`); `send` → pending, `http.postCalls.length === 0`. Flip online, drive sync to `live`. Assert the `live` edge kicks the drain → `postCalls.length === 1`, row settles.
5. **reject → failed + retry/delete, no wedge:** queue two sends A (server rejects `permission_denied`) + B (accepts). Drain: A → `messages` row `state:'failed'`+`error_code`, `outbox` row `state:'rejected'`; **B still settles** (queue not wedged). `outbox.retry(A.event_id)` → re-queued, next drain accepts → A settles. Separately `outbox.delete(B'.event_id)` on a failed row removes both the projection row and the outbox row.
6. **idempotent double-drain / crash-mid-send:** leave a row in `state:'sending'` (simulated crash) and run drain twice / re-enter; the fake server's UNIQUE returns the original `accepted` (same seq). Assert exactly one settled row, `events.count === 1`, `outbox.count === 0`, and the server consumed only one sequence.
7. **eviction never touches outbox:** enqueue outbox rows; run `evictStream` and `clearDerivedTables` (logout wipe). Assert `outbox.count` unchanged and rows intact.
8. **rebuild reproduces settled + pending** (`projection-equivalence.spec.ts`): build an incremental state mixing settled rows, a `pending` row, and a `failed` row → `dumpMessages` A. `clearDerivedTables` + `rebuildProjections` (replays events + re-derives outbox) → `dumpMessages` B. Assert `A === B`. Add a teeth check: a settled `event_id` still present in `outbox` re-derives to the **settled** row (skip guard), not a duplicate pending.
9. **live WS event → messages wiring** (FOLD-IN, `core.spec.ts`): §7 wiring test — a live `message.created` frame appears in a `messages.list` query through `WorkerCore(db, sink)` with the real default seam.
10. **backoff reuse + coalescing** (`outbox.spec.ts`): transient `network` failure → drain schedules a retry at a delay in `[500, 1000]` then grows toward the 30s cap on repeated failures (same `backoffDelay` as sync; assert via the injected `FakeClock`). Concurrent `send`s during an in-flight drain produce a single `POST` (coalesced) — assert `http.maxInFlight <= 1` for the batch path / a single drain generation.
11. **token never leaks:** assert no `mutate` result and no `{kind:'stream'}` push payload contains a token; the drain body carries only `{body, event_hash}` (author fields, no token) and auth rides the shared http client's worker-side `Authorization` header.
12. **stub-replacement fixups:** update `core.spec.ts` (`mutate {m:'message.send'}`) and `client.spec.ts` (`mutate {m:'send'}`) — they assert the retired `not_implemented` stub; replace with a real `outbox.*` assertion.

### 10. Locked-decision (D1–D14) check — no relitigation

- **D1** (hash over `body` only): send hashes via `finalizeEnvelope`→`hashEvent`; body stored/POSTed verbatim, never re-serialized. Respected.
- **D2** (gapless/monotonic `server_sequence`): the client never invents a `server_sequence`; the pending `created_seq` sentinel is a client-only ordering value and is never written to `events.server_sequence`. Settle uses the server's assigned sequence. Respected.
- **D14 / D2** (ordering + display time from server; `client_created_at` untrusted): pending render is provisional/greyed; final order is `created_seq = server_sequence`. Respected.
- **D4** (every projection rebuildable; rebuild ≡ incremental permanent gate): pending re-derivation from `outbox` (§8) keeps it green; `PROJECTION_VERSION` bumped so shape-change clients rebuild.
- **D3** (message classes): `message.created` is a durable event — unchanged.
- **D9** (unknown types skip, never crash): unchanged; the outbox only emits `message.created` v1.
- **D-1/D-3** (one WorkerClient, transport-agnostic core): outbox lives in `WorkerCore` behind `(db, sink)` + injected HTTP; no browser dep added; RPC carried on the existing `mutate` verb — transports unchanged.

### 11. Risks / open questions

- **Pending `created_seq` sentinel collision.** Using `created_at` (ms epoch ≈ 1.75e12) as the pending sort key assumes no real per-stream `server_sequence` reaches that magnitude — safe at this scale, but it is an assumption, not a guarantee. Alternative (heavier) is a dedicated `pending` flag + secondary sort in every query and index. Accepting the sentinel for M2; flagged.
- **Convergence-with-server (invariant 2) while pending rows exist.** Pending rows are client-only and absent server-side, so the simulation must assert cross-client/server convergence **at quiescence** (drain drained, acks settled) — the natural steady state. The within-client rebuild≡incremental gate (invariant 6) holds at all times via §8. Coordinate the exact assertion point with ENG-83.
- **Logout leaves `outbox` populated.** `clearDerivedTables` (logout) intentionally does not touch the `outbox` source table, so a shared-machine user's un-sent pending sends persist to the next login. This is consistent with "eviction never touches outbox," but logout ≠ eviction — clearing outbox on logout may be desirable for a shared machine. **Open question — do not change here;** flag for a follow-up decision (out of ENG-81 scope).
- **Ack does not advance the cursor** → a just-acked event may be re-pulled once on the next reconnect/gap (idempotent, cheap). Deliberate, to keep the cursor single-writer. Accepted.
- **`navigator.onLine` → `SyncEngine.notifyOnline` is still unwired** (pre-existing ENG-79 gap). The drain-on-`live` hook covers reconnect regardless (sync's own backoff reconnect emits `live`), so ENG-81 does not depend on it; noted so it is not mistaken for new breakage.
- **Two-test fixup** (`core.spec.ts`, `client.spec.ts`) is expected churn — those tests pin the `mutate` stub the ticket explicitly retires.
