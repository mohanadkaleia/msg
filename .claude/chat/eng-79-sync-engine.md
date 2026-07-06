# ENG-79 — M2: Sync engine (connect→syncing→live state machine, /v1/sync + catch-up pulls, WS delivery contract)

**Tech lead plan. Do NOT implement from this file directly — it is the contract the `ui-engineer` implements against.**

This is the heart of the M2 client: the piece that turns cursors + pulls + WS push into a gapless, self-healing local `events` log. It is the mechanism the ENG-83 six-invariant simulation suite drives. Its correctness is load-bearing for the whole product (§14 risk: "sync bugs erode trust").

Owner: **ui-engineer** (all of it — `web/`).

---

## 1. Goal, in one paragraph

Own the worker's replication loop. On every (re)connect, run `GET /v1/sync`, diff each readable stream's `head_seq` against the local cursor, and pull the gap closed (`GET /v1/events?after=…` in a loop, bounded-parallel across streams; newest-page `before=head+1` for cold streams; `workspace-meta` always from seq 1). Then hold a WebSocket open and apply `{"t":"event"}` frames — but **only when contiguous**; any sequence discontinuity triggers a targeted pull instead of blind application (§3.3 delivery contract). Every envelope, pulled or pushed, is **hash-verified before storage** (ENG-76 `hashEvent`). Verified envelopes go verbatim into the `events` table; the `cursors.last_contiguous_seq` advances only for gapless application; then a **projection-apply seam** (ENG-80's, injected, default no-op) is called. Expose a `connecting→syncing→live→degraded` status to tabs and a backward-backfill RPC for scrollback.

## 2. Scope boundary — what ENG-79 does NOT do

- **No projection.** ENG-79 never writes `messages`. It writes `events` + `streams` + `cursors` and calls the injected seam. ENG-80 owns `worker/projection.ts` and the `events → messages` build.
- **No outbox / send path.** §5.3 step 3–4 (optimistic send, outbox drain) is ENG-81. ENG-79 reads nothing from `outbox` and never `POST`s events. (It *does* re-run bootstrap on reconnect, which is what lets a send acked-during-disconnect self-heal — but the drain loop itself is ENG-81.)
- **No M3 signal frames.** `read_state`/`presence`/`typing` frames are reserved (server `frames.py` names them, not built). ENG-79's receive loop ignores every non-`event`/non-`ping`/non-`pong` frame (D9 tolerance), leaving the `t`-space open for M3.
- **No UI.** The scroll-top trigger is ENG-82; ENG-79 only exposes the `sync.backfill` RPC it will call.

---

## 3. THE COORDINATION SEAM with ENG-80 (implemented in parallel)

Partition (as directed):

| Owner | Files | Writes | Reads |
|---|---|---|---|
| **ENG-79** | `worker/sync.ts`, `worker/ws.ts` | `events`, `streams`, `cursors` | `cursors` (diff), `streams` |
| **ENG-80** | `worker/projection.ts` | `messages` (+ any ENG-80 derived) | `events` |

**The interface is one injected function.** ENG-79 defines it, defaults it to a no-op, and calls it after every gapless apply. ENG-80 provides the real implementation and wires it in at construction.

```ts
// types.ts — the coordination contract. LOCK THIS SIGNATURE; both tickets import it.
/**
 * Called by the sync engine AFTER it has written a contiguous run of verified
 * envelopes into `events` for one stream and advanced that stream's cursor.
 * `events` is ascending by server_sequence, gapless, already hash-verified and
 * persisted. ENG-80 projects them into `messages`. Default: no-op (ENG-79 ships
 * and tests standalone; ENG-80 fills it).
 *
 * Contract:
 *  - called once per applied batch per stream (bootstrap page, catch-up page, or
 *    a single live frame), NOT once per event;
 *  - only ever receives events the cursor now covers (never a gap/duplicate —
 *    ENG-79 filters those out before calling);
 *  - awaited: the cursor write and this call are sequenced so a projection read
 *    after `sync.status == live` reflects everything applied. Must not throw for
 *    control flow (ENG-79 logs+continues on throw; a projection error must not
 *    corrupt the cursor, which is already committed).
 */
export type ApplyEventsToProjection = (
  streamId: string,
  events: readonly StoredEvent[],
) => Promise<void>
export const noopApplyToProjection: ApplyEventsToProjection = () => Promise.resolve()
```

- `StoredEvent` is the verified envelope shape ENG-79 defines (see §7). ENG-80 consumes it read-only.
- Injection point: `WorkerCore` grows an optional constructor knob `applyToProjection?: ApplyEventsToProjection` (default `noopApplyToProjection`), forwarded into the `SyncEngine`. `shared-worker.ts`/`leader.ts`/`solo` construct `WorkerCore` with no options today → default no-op → ENG-79 is green before ENG-80 exists. When ENG-80 lands, it passes its real function in one place (the three transport entry points, or better, a single `createWorkerCore()` factory ENG-80 introduces).
- **Also**: after applying, ENG-79 `publish`es a `{kind:'stream', stream_id}` push (already in the `Topic` union) so subscribed tabs re-query. ENG-80/82 subscribe. This is the async "events changed for stream X" signal; the injected function is the synchronous rebuild hook. Both exist; the injected fn is the hard seam, the push is the notification.

**Rebuild interaction:** `checkProjectionVersion`/`rebuildProjections` (db.ts) currently no-op. ENG-80 fills `rebuildProjections` to replay `events → messages`. ENG-79 does NOT touch that path; it only guarantees `events` and `cursors` are populated so a rebuild has raw material. Note the current `rebuildProjections` clears derived tables **including `cursors`** — ENG-79 must treat cursors as reconstructible from `events` on boot (a cursor is `max contiguous server_sequence in events` per stream). Bootstrap re-derives cursors from the `events` cache on cold start, so a dropped-cursors rebuild self-heals via the next `/v1/sync` + catch-up.

---

## 4. File list (all `web/`, all `ui-engineer`)

**New source:**
- `web/src/worker/ws.ts` — `WsConnection` interface + `BrowserWsConnection` (real `WebSocket`) + `WsFactory` type. The transport seam; no sync logic.
- `web/src/worker/sync.ts` — `SyncEngine`: the state machine, bootstrap, catch-up/backfill pull logic, apply+verify+cursor path, delivery-contract gap handling, reconnect/backoff. The brain; no direct `WebSocket`/`fetch`/`self` references (all injected).

**Modified source:**
- `web/src/worker/types.ts` — add: `SyncState`, `SyncStatus`, `StoredEvent`, `ApplyEventsToProjection` + `noopApplyToProjection`, `Topic` gets `{kind:'sync'}`, `RpcRequest` gets `sync.status`/`sync.backfill`/`sync.start`/`sync.stop`, `PushPayload` maps the sync topic. Grow `MsgDb` (see §8). Add wire types `SyncStreamMeta`, `WireEvent`, `EventsPageResponse`.
- `web/src/worker/db.ts` — implement the new `MsgDb` reads (`getCursor`, `listStreams`, `getEventSeqRange`/`maxContiguousSeq`) in **both** `DexieDb` and `MemoryDb`.
- `web/src/worker/core.ts` — construct a `SyncEngine`, forward the injected `applyToProjection` + a `WsFactory`, register the four `sync.*` RPCs via `register()`, add `SyncEngine` results to `RpcResultMap`, start the engine in `init()` when authenticated, stop it on logout. Wire `SyncEngine`'s status emitter to `publish({kind:'sync'}, …)`.
- `web/src/worker/http.ts` — **likely no change**; `get<T>(path)` already accepts a full path incl. query string. (Confirm query building lives in `sync.ts`.)

**New tests:**
- `web/tests/unit/worker/ws.spec.ts` — `FakeWsConnection` behavior + real-impl frame parse (jsdom `WebSocket` optional; the fake is the workhorse).
- `web/tests/unit/worker/sync.spec.ts` — the bulk: state machine, bootstrap concurrency, hash-verify reject, delivery contract (contiguous/gap/duplicate), reconnect self-heal, backfill.
- `web/tests/unit/worker/helpers.ts` — extend with a `FakeHttpClient` (scripted `/v1/sync` + `/v1/events` responses) and `FakeWsConnection` (test drives frames in, asserts closes/reconnects out). Reuse existing `collectingSink`, `fakeIdbOptions`.

---

## 5. The WsConnection abstraction (testability — item 6)

The real `WebSocket` never appears in `sync.ts`. `ws.ts` defines a minimal interface `sync.ts` drives; tests supply a fake.

```ts
// ws.ts
export type WsFrame =
  | { t: 'event'; event: WireEvent }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: string } // tolerated/ignored (D9): read_state/presence/typing (M3), unknown

export interface WsConnection {
  send(frame: { t: 'ping' } | { t: 'pong' }): void   // client→server M1 surface only
  close(code?: number): void
  onFrame(cb: (f: WsFrame) => void): void             // parsed JSON text frames
  onOpen(cb: () => void): void
  onClose(cb: (info: { code: number; wasClean: boolean }) => void): void
  onError(cb: () => void): void
}

/** Injected into SyncEngine. Prod builds a BrowserWsConnection; tests build a fake. */
export type WsFactory = (url: string, token: string) => WsConnection
```

- `BrowserWsConnection`: `new WebSocket(url, ['bearer', token])` (from `auth.getToken()` worker-side — never `?token=`, per ENG-78/ENG-68). Parses `message.data` as JSON → `WsFrame`; a non-text / non-JSON / non-object frame is dropped (never crash). Maps `onclose`/`onerror`. URL is same-origin: derive `ws(s)://<host>/v1/ws` from `location` in prod; injectable base for tests.
- `FakeWsConnection` (tests): `open()`, `emit(frame)`, `serverClose(code)` drive the engine; records `send`/`close` calls. Lets a test feed synthetic `{"t":"event", "event":{seq…}}` frames to exercise gap→pull with zero browser.
- **The token flows factory-side, not URL-side**: `WsFactory(url, token)` keeps the token out of `sync.ts` string building; `BrowserWsConnection` passes it as the subprotocol.

`SyncEngine` is constructed with `{ http: HttpClient, wsFactory: WsFactory, db: MsgDb, getToken, applyToProjection, emitStatus, publishStream, now?, setTimeout? }` — every side effect injected → fully unit-testable. (Backoff timers use an injectable clock so tests advance time deterministically; default = real `setTimeout`.)

---

## 6. State machine (§5.3 — item 1)

States: `connecting → syncing → live → degraded`. `SyncState = 'connecting' | 'syncing' | 'live' | 'degraded'`.

```
            start()/reconnect
 (idle) ─────────────────────▶ connecting
                                  │ WS onOpen
                                  ▼
                               syncing ──── bootstrap: GET /v1/sync + catch-up pulls
                                  │ bootstrap complete (all streams caught up)
                                  ▼
                                 live ◀──── apply WS event frames (contiguous)
                                  │            gap frame ⇒ targeted pull, stay live
                                  │
   WS onClose / heartbeat miss / │ onError
   navigator offline             ▼
                              degraded ──── backoff timer ──▶ connecting (reconnect)
```

Transitions & triggers:

| From | Trigger | To | Action |
|---|---|---|---|
| idle | `start()` (authenticated) | connecting | open WS via factory |
| connecting | WS `onOpen` | syncing | run bootstrap (§7) |
| connecting | WS `onClose`/`onError`, or `offline` | degraded | schedule reconnect (backoff) |
| syncing | bootstrap complete | live | begin applying frames directly |
| syncing | WS `onClose`/`onError`/offline, or a pull hard-fails | degraded | abort in-flight pulls, schedule reconnect |
| live | contiguous `event` frame | live | apply + advance cursor + seam |
| live | gap `event` frame (`seq > cursor+1`) | live | targeted catch-up pull for that stream |
| live | old/dup `event` frame (`seq ≤ cursor`) | live | ignore |
| live | server `{"t":"ping"}` | live | reply `{"t":"pong"}` |
| live | heartbeat miss (no server frame within window) | degraded | `close()` → reconnect |
| live/syncing/connecting | WS `onClose`/`onError` | degraded | schedule reconnect |
| any | `navigator.offline` event | degraded | `close()`, hold until `online` |
| degraded | `online` event OR backoff fires | connecting | reopen WS |
| any | `stop()` / logout | idle | close WS, cancel timers, clear state |

- **`connecting`→`syncing` is gated on WS open**, not on the HTTP call. Rationale (§3.3): opening the socket *first* means no live event can slip through the window between "bootstrap finished" and "socket subscribed" — the socket is buffering (browser-side) while bootstrap runs, and any buffered frame is reconciled by the delivery contract (gap ⇒ pull). If a browser cannot open the socket at all, fall to `degraded` and keep retrying; a future enhancement could allow HTTP-only `syncing`, but M2 ties liveness to the socket.
- **Heartbeat**: the SERVER drives heartbeat (`ws/router.py`: server sends `{"t":"ping"}` every 30 s, expects a client `{"t":"pong"}`; closes `4408` if unanswered). ENG-79 client MUST: (a) reply `pong` to every server `ping`; (b) run its OWN liveness watchdog — reset a timer on *any* inbound frame; if no frame (ping or event) arrives within ~35–45 s (> server's 30 s), treat the socket as dead, `close()`, go `degraded`. Optionally send a client `{"t":"ping"}` when idle to elicit a `pong`. Do not rely solely on `onClose` — a half-open TCP socket may never fire it.
- **Reconnect backoff**: exponential 1 s → 30 s cap with jitter (mirror the §5.3 outbox backoff numbers). Reset to 1 s on a clean `live`. Injectable clock.
- **`degraded` == offline for the tab**: this is the status tabs render as "reconnecting/offline".

**Status exposure (item 1 + item 7).** `SyncEngine` emits `SyncStatus` on every transition. Delivered two ways:
- RPC `sync.status` → returns current `SyncStatus` synchronously (pull).
- Push on `Topic {kind:'sync'}` → tabs `subscribe` and get transitions live.

```ts
export interface SyncStatus {
  state: SyncState                 // connecting | syncing | live | degraded
  online: boolean                  // navigator.onLine snapshot
  streamsTotal?: number            // bootstrap progress (syncing)
  streamsSynced?: number
  lastError?: string               // last transport/pull error, for diagnostics
}
```
This is distinct from `WorkerStatus` (transport/db/role, produced tab-side in `client.ts`). Do **not** overload `WorkerStatus`; add the `{kind:'sync'}` topic (types.ts `Topic` is explicitly an ENG-79 extension point).

---

## 7. Sync bootstrap + concurrency (item 2)

On entering `syncing` (every connect, per §3.3 "re-run bootstrap on every (re)connect"):

1. `GET /v1/sync` → `{ streams: [{stream_id, kind, name, visibility, head_seq, member}] }` (server shape confirmed: `SyncResponse`/`SyncStream`). On error → `degraded` + backoff.
2. **Store stream metadata** into `streams` (`putStreams`): `{stream_id, kind, name, visibility, head_seq, member}`. This is the channel list / browser source (ENG-80/82 read it). `workspace-meta` rows: server sets `member:false` by construction — clients special-case meta (do not treat `member:false` as "not joined").
3. For each stream, read the local cursor (`getCursor(streamId)` → `{last_contiguous_seq, oldest_loaded_seq} | undefined`) and classify:
   - **`workspace-meta`** → full sync from seq 1: `after = last_contiguous_seq` (0 if none), loop `GET /v1/events?stream_id=…&after=N&limit=500` until `has_more == false`. Always from 1 on a cold client (small; client needs full channel/member state).
   - **brand-new stream** (no cursor, `head_seq > 0`) → **newest-page pull** for cold-start render: `GET /v1/events?stream_id=…&before=head_seq+1&limit=500`. Apply the page; set `cursors = { last_contiguous_seq: head_seq, oldest_loaded_seq: firstSeqOfPage }`. This is the ONLY case where the cursor jumps to `head` without walking from 1 — the cold-start rule (§3.2): a new device does not replay full history. (Consequence: `last_contiguous_seq = head_seq` even though seqs `1..firstSeqOfPage-1` are not local. "Contiguous" here means "contiguous from the newest-loaded window forward"; older history is fetched via backfill. Document this precisely — it is subtle and the delivery contract depends on it: a live frame at `head+1` is contiguous with `last_contiguous_seq = head`.)
   - **known stream, behind** (`head_seq > last_contiguous_seq`) → forward catch-up: loop `after = last_contiguous_seq` … until `has_more == false`.
   - **known stream, up to date** (`head_seq == last_contiguous_seq`) → nothing to pull.
4. **Concurrency**: pull streams in parallel with a **bounded pool — limit = 4 concurrent streams** (each stream's own catch-up loop is sequential; the 4-way parallelism is *across* streams). Rationale: `/v1/sync` can list dozens of channels; unbounded parallel loops would burst the server rate limit (§4.3: 60/min sustained) and open too many fetches. 4 balances cold-start latency vs. politeness; make it a named const `BOOTSTRAP_CONCURRENCY = 4`. Within a stream, pages are strictly sequential (each page's `after` depends on the last).
5. Bootstrap is complete when every stream's loop has drained (`has_more == false` / up-to-date). Transition `syncing → live`. Emit progress (`streamsSynced/streamsTotal`) as streams finish.

`StoredEvent` shape (what goes into `events.envelope`, and the seam type):
```ts
export interface WireEvent {          // exactly the server/pull/WS wire shape
  body: Record<string, unknown>       // raw JSONB body — hash is computed over THIS
  event_hash: string                  // "sha256:<hex>"
  signature: null
  server: { server_sequence: number; server_received_at: string; payload_redacted: boolean }
}
export interface StoredEvent extends WireEvent { /* the verified, stored envelope */ }
```
`EventRow` (db.ts) is written as `{ stream_id, server_sequence: server.server_sequence, event_id: body.event_id, type: body.type, envelope: <WireEvent> }`.

---

## 8. Applying events — verify + store + cursor (item 3, the integrity core)

For a page (bootstrap/catch-up) or a single live frame, applying one stream's ascending run of events:

1. **Verify each envelope before storing** (ENG-76): recompute `await hashEvent(ev.body)` and compare to `ev.event_hash`.
   - **Mismatch ⇒ skip + `console.warn`** (`{streamId, seq, expected, got}`); do NOT store it, do NOT advance the cursor past it, do NOT crash. A server serving a bad hash is a bug/attack (§2.1 raw-hash discipline says the server never regenerates a body, so this should never happen — a mismatch is a real signal). Because the cursor stops at the last-good contiguous seq, the next pull re-requests from there — a transient bad byte self-heals; a persistent one wedges that stream in a visible, logged way rather than corrupting the log. (`hashEvent` may also `throw JCSError` on out-of-domain body → same treatment: skip+warn.)
2. **Store verbatim**: `putEvents([EventRow…])` keyed `[stream_id + server_sequence]` — the exact bytes served (raw body straight through; never re-serialize — that would break the hash, mirroring the server's D1 discipline).
3. **Advance cursor only for gapless application.** Walk the ascending verified events; advance a running `next = last_contiguous_seq + 1`; for each event, if `server_sequence == next` accept into the contiguous run and `next++`; on the first hole, **stop advancing** (later events are still stored in `events`, but the cursor does not jump the gap). Write `cursors.last_contiguous_seq = next - 1`. Update `oldest_loaded_seq = min(existing, firstStoredSeq)`.
   - Pull pages from the server are gapless by construction (server sequences are gapless, §3.1), so in the normal path the whole page advances the cursor. The gap-guard matters for the live/interleaving cases and is what the invariant suite (cursor integrity) asserts.
4. **Call the seam** with the contiguous run just applied: `await applyToProjection(streamId, appliedContiguousEvents)`. Then `publish({kind:'stream', stream_id}, {stream_id})`. Wrap the seam in try/catch: log on throw, never roll back the cursor (cursor is committed truth; a projection error is ENG-80's to recover via rebuild).
5. **Persist cursor + events in one Dexie transaction** where possible (so a crash can't leave `events` ahead of `cursors` in a way that skips the seam) — but note cursor-ahead-of-events is the dangerous direction; events-ahead-of-cursor is safe (re-pull re-applies idempotently via `bulkPut`). Keep it simple: write events, then cursor; re-application is idempotent (`putEvents` is `bulkPut`, seam is idempotent per ENG-80 contract).

**Idempotency**: `putEvents` is `bulkPut` on the `[stream_id+server_sequence]` PK, so re-storing the same event is a no-op overwrite of identical bytes. Re-pulling after a gap never duplicates.

---

## 9. WS live + THE delivery contract (item 4 — the crux, §3.3)

Once `live`, on each inbound `{"t":"event", "event": ev}` frame, let `seq = ev.server.server_sequence`, `sid = ev.body.stream_id`, `cursor = getCursor(sid).last_contiguous_seq` (0/unknown if the stream isn't tracked yet):

- **`seq == cursor + 1`** → contiguous: verify+store+advance+seam directly (§8, single-event run). The fast path.
- **`seq > cursor + 1`** → **GAP. Do NOT apply blindly.** Trigger a **targeted catch-up pull** for `sid`: `GET /v1/events?stream_id=sid&after=cursor&limit=500` looped to `has_more=false` (§8 applies each page, advancing the cursor to `seq` and beyond). This closes the gap in order and the buffered frame's data arrives via the pull. **Coalesce**: if a pull for `sid` is already in flight, don't start a second — the in-flight pull will cover this seq (or a follow-up frame re-triggers). One in-flight pull per stream.
- **`seq ≤ cursor`** → duplicate/old (already applied): **ignore.**
- **Unknown stream** (`sid` not in `streams` / no cursor) → could be a newly-created channel the client wasn't a member of at bootstrap. Treat as gap-from-0: run a bootstrap-style newest-page pull for `sid` (and refresh `/v1/sync` so `streams` learns it). Guard against storms (coalesce per stream).

This single rule (`seq != cursor+1 ⇒ pull, never blind-apply`) eliminates the entire missed/duplicate-push bug class — push is a *hint*, cursors are truth. It is directly unit-testable by feeding synthetic frames to the engine over a `FakeWsConnection` and asserting the resulting pull calls on the `FakeHttpClient`.

**Reconnect self-heals the disconnect window** (§3.3): on every reconnect, bootstrap re-runs `/v1/sync` + catch-up, so any events missed while the socket was down are pulled by cursor diff. No special "replay since disconnect" logic — the cursor *is* the resume point.

---

## 10. Backward backfill (item 5)

Expose RPC `sync.backfill(streamId)` (called by ENG-82's scroll-top later; ENG-79 only provides the RPC):

1. Read `cursors.oldest_loaded_seq` for the stream (from `getCursor`).
2. `GET /v1/events?stream_id=…&before=oldest_loaded_seq&limit=500` — server returns the newest page below `oldest_loaded_seq`, ascending, with `has_more` = older events still exist.
3. Verify each (§8 step 1), `putEvents` (prepend into `events` — same table, lower seqs), update `cursors.oldest_loaded_seq = firstSeqOfPage`. **Do NOT touch `last_contiguous_seq`** (that tracks the forward frontier; backfill only extends the window backward).
4. Call the seam with the backfilled events so ENG-80 can prepend to `messages`. Return `{ events: <count>, has_more, oldest_loaded_seq }` so the UI knows whether to keep offering scroll.
5. When `before` reaches 1 (or `has_more=false`), the stream is fully backfilled.

---

## 11. MsgDb additions (db.ts + types.ts) — needed by ENG-79

Current `MsgDb` has `putEvents/putCursors/putStreams` (writes) but **no cursor/stream reads**. Add to the interface and both impls (`DexieDb`, `MemoryDb`):

```ts
getCursor(streamId: string): Promise<CursorRow | undefined>
listCursors(): Promise<CursorRow[]>            // boot: re-derive/inspect all cursors
listStreams(): Promise<StreamRow[]>            // bootstrap diff + status counts
getStream(streamId: string): Promise<StreamRow | undefined>
/** newest server_sequence stored for a stream (backfill floor / oldest checks). */
minStoredSeq(streamId: string): Promise<number | undefined>
```
- `getCursor`/`listStreams`/`getStream`: trivial Dexie `.get`/`.toArray`; `MemoryDb` Map reads.
- `minStoredSeq`: `listEventSequences(streamId)[0]` (already exists, ascending) — or a thin wrapper.
- `putCursors` already exists (upsert). No new write method needed beyond reads.

Keep the interface small; do not add speculative methods. (ENG-80 will add its own `messages` reads.)

---

## 12. RPC additions (item 7) via the typed `register()` seam

Extend `RpcRequest` (types.ts) + `RpcResultMap` (core.ts) + register handlers:

| Method | Params | Result | Notes |
|---|---|---|---|
| `sync.status` | `{}` | `SyncStatus` | current state snapshot (pull) |
| `sync.backfill` | `{ stream_id: string }` | `{ events: number; has_more: boolean; oldest_loaded_seq: number }` | §10 |
| `sync.start` | `{}` | `{ ok: true }` | idempotent; usually auto-started in `init()` |
| `sync.stop` | `{}` | `{ ok: true }` | idempotent; called on logout |

- Register in a new `WorkerCore.registerSync()` (mirrors `registerAuth()`), delegating to the `SyncEngine`.
- **Lifecycle wiring in `WorkerCore`**: after `init()` restores the session, if authenticated → `syncEngine.start()`. `AuthManager.logout()`/`clearSession()` must stop the engine (add a hook: `WorkerCore` calls `syncEngine.stop()` in the logout path, and `start()` after a successful `login/setup/acceptInvite`). Keep this in `core.ts` (the composition root), not in `AuthManager`.
- Push topic: also add `{kind:'sync'}` to `Topic` and `PushPayload<{kind:'sync'}> = SyncStatus`; `SyncEngine`'s `emitStatus` → `core.publish({kind:'sync'}, status)`.

---

## 13. Test plan (item 6 — this is what ENG-83 drives)

All vitest, no browser/server. Extend `tests/unit/worker/helpers.ts`:
- **`FakeHttpClient`**: implements `HttpClient`; scripted per-path responses (`/v1/sync`, `/v1/events?…` keyed by query), records calls, can inject errors/timeouts, can serve a **bad-hash** event (for the verify-reject test), can gate a response on a promise (to test concurrency bounds / in-flight coalescing).
- **`FakeWsConnection` + `fakeWsFactory`**: capture `send`/`close`; expose `open()/emit(frame)/serverClose(code)`.
- Build real envelopes with `@/core` (`buildMessageCreatedBody` + `hashEvent`) so hashes are genuine; corrupt one for the reject test.

`sync.spec.ts` cases (map 1:1 onto the six invariants where possible):
1. **Bootstrap — behind stream**: `/v1/sync` head 10, cursor 3 → pulls `after=3` pages → `events` has 4..10, `cursor.last_contiguous_seq=10`, seam called with the run.
2. **Bootstrap — cold new stream**: no cursor, head 100 → single `before=101` newest-page pull → `last_contiguous_seq=100`, `oldest_loaded_seq=firstSeq`.
3. **Bootstrap — workspace-meta from seq 1**: pulls `after=0` regardless of head.
4. **Bootstrap concurrency**: N streams, assert ≤ `BOOTSTRAP_CONCURRENCY` in-flight (gate responses, count concurrent).
5. **Hash verify reject**: a page containing one bad-hash event → that event NOT stored, `console.warn` fired, cursor stops before it, later good events after the hole not counted contiguous.
6. **Delivery contract — contiguous frame** (`seq==cursor+1`): applied directly, no pull.
7. **Delivery contract — gap frame** (`seq>cursor+1`): NO blind store; a targeted `after=cursor` pull issued; after pull, cursor reaches seq.
8. **Delivery contract — duplicate/old** (`seq≤cursor`): ignored, no store, no pull.
9. **Gap coalescing**: two gap frames for one stream → one in-flight pull.
10. **State machine**: onOpen→syncing→(bootstrap)→live; onClose→degraded→backoff→connecting (advance fake clock); offline event→degraded; online→reconnect.
11. **Heartbeat**: no inbound frame within watchdog window → `close()` + degraded; server `ping` → client `pong` sent + watchdog reset.
12. **Reconnect self-heal**: disconnect, emit nothing, reconnect → bootstrap re-pulls the missed window via cursor diff (cursor integrity invariant).
13. **Backfill**: `sync.backfill` pulls `before=oldest_loaded`, prepends, lowers `oldest_loaded_seq`, leaves `last_contiguous_seq` untouched, seam called.
14. **Seam default no-op**: engine runs green with `noopApplyToProjection` (proves standalone testability); a spy `applyToProjection` receives exactly the contiguous applied runs.
15. **Idempotent re-apply**: re-deliver an already-applied page → no duplicate events, cursor unchanged.

`ws.spec.ts`: `BrowserWsConnection` parses text frames → `WsFrame`; drops non-JSON/binary without throwing; `send` serializes; `close(code)` forwarded. (Uses a minimal fake `WebSocket` global or the fake connection directly.)

Run: `pnpm -C web test` (vitest) + `pnpm -C web typecheck` (vue-tsc) + `pnpm -C web lint`.

---

## 14. Risks / open questions

1. **Cold-start "contiguous from head" subtlety** (§7 case 2): setting `last_contiguous_seq = head_seq` while seqs `1..firstPageSeq-1` are absent from `events` is deliberate but easy to get wrong. The invariant is "contiguous forward from the newest-loaded window"; backfill fills behind it. If misimplemented, a live `head+1` frame would look like a gap and pull needlessly (correct but wasteful) or older backfill would corrupt `last_contiguous_seq`. **Mitigation**: `last_contiguous_seq` only ever moves forward via §8; backfill touches only `oldest_loaded_seq`. Test 2 + 13 pin it.
2. **Heartbeat direction**: the server pings and the client must pong (confirmed in `ws/router.py`). Relying on `onClose` alone is unsafe (half-open sockets). The client-side watchdog (reset on any inbound frame, timeout > 30 s) is required. Risk: watchdog too tight → needless reconnect churn; too loose → slow dead-socket detection. Pick ~40 s; make it a named const.
3. **Bootstrap during high write volume**: `head_seq` from `/v1/sync` is a snapshot; new events arrive via WS during bootstrap. Safe by construction — a frame past the snapshot head is a gap ⇒ pull; the socket-open-before-bootstrap ordering (§6) means no frame is lost. But verify the buffered-frame handling: frames received while still in `syncing` should be **queued or re-derived**, not dropped. **Decision**: while `syncing`, do not apply frames live; after bootstrap→live, the cursor already reflects reality and the next frame's gap-check pulls anything missed. Simplest correct behavior: ignore `event` frames until `live`, rely on cursor+delivery-contract. Document this.
4. **Unknown-stream frame** (new channel mid-session): handled as gap-from-0 + `/v1/sync` refresh, but needs storm-guarding (coalesce). Low frequency; acceptable.
5. **Cursor reconstruction after a projection-version rebuild**: `rebuildProjections` clears `cursors`. ENG-79 must not assume cursors survive; a missing cursor → treated as cold stream → re-bootstrap. Confirm with ENG-80 that a rebuild leaves `events` intact (it must, per D-4) so history isn't refetched from seq 1 unnecessarily — ideally ENG-80's rebuild re-derives `cursors` from `events`, OR ENG-79 re-derives on bootstrap. **Open question for ENG-80 coordination**: who re-derives cursors post-rebuild? Lean answer: ENG-79 re-derives from `events` on bootstrap (max contiguous seq per stream), so rebuild can safely drop cursors. Confirm in the shared chat file.
6. **`WorkerCore` construction knob for `applyToProjection` + `wsFactory`**: adding options must keep the three transport entry points (`shared-worker.ts`, leader, solo) constructing with defaults (no-op seam, `BrowserWsConnection` factory). Verify `new WorkerCore(db, sink)` still compiles unchanged.
7. **Same-origin WS URL derivation**: prod derives `ws(s)://host/v1/ws` from `location`; in a SharedWorker, `location` is the worker script's origin (same as app origin, single-origin per §5.1). Confirm; keep injectable for tests.

---

## 15. Summary (for the caller)

- **State machine** (`sync.ts`): `connecting → syncing → live → degraded`. WS-open enters `syncing`; bootstrap-complete enters `live`; close/heartbeat-miss/offline enters `degraded`; backoff/online reconnects. Status exposed via `sync.status` RPC + a `{kind:'sync'}` subscribe push (distinct from transport `WorkerStatus`).
- **Bootstrap + concurrency**: `GET /v1/sync` → store `streams` → per-stream classify (meta=from 1; new=newest-page `before=head+1`; behind=`after=cursor` loop; up-to-date=skip); **bounded 4-way parallelism across streams**, sequential pages within a stream.
- **Hash-verify-on-apply**: recompute `hashEvent(body)` vs `event_hash` before storing; **mismatch ⇒ skip + warn, never store, never advance cursor, never crash**; store verbatim (raw body, no re-serialize); advance `last_contiguous_seq` only across a gapless run; then call the seam.
- **Delivery contract**: on a live `event` frame, `seq==cursor+1`→apply; `seq>cursor+1`→targeted `after=cursor` pull (coalesced, one in-flight/stream), never blind-apply; `seq≤cursor`→ignore. Reconnect re-runs bootstrap so the disconnect window self-heals via cursor diff.
- **WS abstraction for testability**: `WsConnection` interface + `WsFactory` injected into `SyncEngine`; `BrowserWsConnection` uses `new WebSocket(url, ['bearer', token])` (token from `auth.getToken()`, never in URL); `FakeWsConnection` drives synthetic frames in tests. `SyncEngine` takes injected HTTP client + WS factory + `MsgDb` + clock → fully unit-testable, no browser/WS/server.
- **Projection seam with ENG-80**: `ApplyEventsToProjection(streamId, events) => Promise<void>`, default `noopApplyToProjection`, injected via `WorkerCore`. ENG-79 calls it after each gapless applied run (events already verified + stored + cursor advanced); ENG-80 fills it to build `messages`. Plus a `{kind:'stream'}` push as the async "changed" signal. ENG-79 owns `events/streams/cursors`; ENG-80 owns `messages`.
- **RPC additions**: `sync.status`, `sync.backfill(stream_id)`, `sync.start`, `sync.stop` via `register()`; lifecycle wired in `core.ts` (start after auth, stop on logout).
- **File list**: new `worker/ws.ts`, `worker/sync.ts`; modified `worker/types.ts`, `worker/db.ts` (cursor/stream reads), `worker/core.ts` (compose + register + lifecycle); new `tests/unit/worker/{ws,sync}.spec.ts` + `helpers.ts` (FakeHttpClient, FakeWsConnection). All **ui-engineer**.
- **Top risks**: cold-start "contiguous-from-head" cursor semantics; heartbeat needs a client watchdog (not just `onClose`); frames-during-`syncing` handling (ignore until live, cursor covers it); post-rebuild cursor re-derivation (coordinate with ENG-80 — lean answer: ENG-79 re-derives from `events` on bootstrap).
