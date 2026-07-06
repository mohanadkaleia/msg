# ENG-80 — M2: Client projections + client-side rebuild (Dexie `messages` projection, `PROJECTION_VERSION` replay)

**Tech-lead planning doc.** Milestone M2 (§13). Do NOT implement from this file alone — it is the
contract the implementer works against. All inter-agent coordination lives here.
**Agent:** all parts **`ui-engineer`** (everything is under `web/`).

**TDD refs:** §5.2 (Dexie schema — the `messages` derived table, `PROJECTION_VERSION` guarding derived
tables, the "mismatch ⇒ drop derived, re-apply from cached `events`, then resume pulls" client
rebuild), §3.5 (read state + unread/mention badges — client computes from its projection, no server
round trip), §2.3 rule 3 (D9: unknown types / versions above max → preserve in cache, skip in
projection, never crash), §12 invariant 6 (rebuild ≡ incremental — client Dexie side).
**Precedents mirrored:** `.claude/chat/eng-58-projection.md` (M0 SQLite `project`/`dump_messages`/
`_HANDLERS`/idempotency/determinism rulings), `eng-69-server-projection.md` (server `apply_projection`/
`rebuild_projections`/`dump_messages_proj`), `eng-61-equivalence-gate.md` (the rebuild≡incremental
property-gate + mutation-teeth discipline). This ticket is the **Dexie analogue** of those.
**Builds on (merged to main):** ENG-77 (`worker/db.ts` — the §5.2 schema, `MsgDb` interface, `MemoryDb`/
`DexieDb`, `checkProjectionVersion`, the `rebuildProjections` **stub**; `worker/core.ts` — `WorkerCore`
with the `register()` handler seam and the stub `query` handler; `worker/types.ts` — row interfaces,
`QueryParams`/`QueryResult` stubs, `PROJECTION_VERSION`), ENG-76 (`core/` envelope + `payloads/message`),
ENG-78 (auth / `META_MY_USER_ID`).

---

## Goal (restated)

Give the **web client** the same **rebuild ≡ incremental** projection guarantee the M0 CLI (ENG-58/61)
and the M1 server (ENG-69) already have, but against **Dexie/IndexedDB** instead of SQLite/Postgres.
Four deliverables, mirroring the two precedents one-for-one:

1. **Incremental apply** — `applyEventsToProjection(db, streamId, events)` materializes `messages`
   rows from `message.created` v1 events. Idempotent (re-apply = no-op), D9-safe (unknown types /
   above-max versions skip, never crash), deterministic. **This is the seam ENG-79 calls** after it
   writes verified envelopes into `events` and advances cursors.
2. **Client-side rebuild** (invariant 6, the crux) — on `PROJECTION_VERSION` mismatch at boot, drop
   the derived tables and re-apply the `messages` projection from the cached `events`, byte-identical
   to the incremental state. Wire it into ENG-77's `rebuildProjections()` stub.
3. **Deterministic dump** — `dumpMessages(db)`: a normalized, ordered, compact serialization of the
   `messages` projection, the Dexie analogue of ENG-58's `dump_messages`. The equivalence surface
   ENG-83 asserts on (`incremental-dump == rebuild-dump`, byte-equal).
4. **Badges** (§3.5) — unread count + mention badge derived from the projection with no server round
   trip, plus the **projection query RPC** tabs/ENG-82 read (messages-in-stream, stream list with
   badges, single message).

`messages`, `streams`, `cursors`, `read_state`, `events`, `meta`, `outbox` and their indexes
**already exist** on main (§5.2, ENG-77 `db.ts`). This ticket adds **no** Dexie `.stores()` change and
**no** Dexie `version()` bump — it fills the `messages` row shape, the apply/rebuild/dump logic, the
badge derivation, the query handler, and the read methods on `MsgDb` those need.

---

## Coordination with ENG-79 (sync engine) — the seam, and the shared-file protocol

ENG-79 (sync engine) is planned/implemented **in parallel**. Partition:

- **ENG-80 OWNS:** `worker/projection.ts` (events→`messages` apply + client rebuild + deterministic
  dump + the query dispatcher), `worker/badges.ts` (unread/mention derivation), and the ENG-80 tests.
- **ENG-79 OWNS:** the WebSocket / pull loop, writing verified envelopes into `events`, advancing
  `cursors`, refilling `streams`/`read_state` from server pulls, and **publishing** stream-update
  pushes.

### THE SEAM (pin 1) — `applyEventsToProjection`, the function ENG-80 provides and ENG-79 calls

```ts
// worker/projection.ts — the injected hook ENG-79 calls per accepted batch
export async function applyEventsToProjection(
  db: MsgDb,
  streamId: string,
  events: readonly EventRow[],
): Promise<void>
```

- **`db` first, then `streamId`, then the new `EventRow[]`** — matches the pin exactly and the
  `applyEventsToProjection(streamId, events)` shape ENG-79's plan expects (ENG-79 already holds the
  `db` handle; passing it keeps the function pure/injectable and unit-testable with a `MemoryDb`).
- **Contract:** ENG-79 has *already written* these `events` rows into the `events` table and advanced
  `cursors` **before** calling this; `applyEventsToProjection` only writes `messages` rows (it never
  touches `events`, `cursors`, `streams`, or `read_state`). Clean single-writer partition: ENG-79 owns
  the source cache + cursors, ENG-80 owns the `messages` projection derived from it.
- **Idempotent** — re-applying the same events writes byte-identical rows (see Ruling 1). ENG-79 may
  re-hand a batch after a reconnect; that must be a no-op.
- **Never throws on a bad/unknown event** (D9 + client robustness — Ruling 1): a throw here would
  wedge ENG-79's apply loop and the rebuild. Unknown/malformed → skip.

ENG-79 imports it from `worker/projection.ts`. After the call returns, **ENG-79** publishes the
`{ kind: 'stream', stream_id }` push (it owns the loop and knows a batch completed); ENG-80's query
surface is pull-only. Publishing is **not** ENG-80's responsibility — flag confirmed with ENG-79.

### `EventRow.envelope` shape — the one real cross-ticket data contract

`EventRow` (types.ts) today is `{ stream_id, server_sequence, event_id, type, envelope? }` with
`envelope` an opaque `Record<string,unknown>` "filled by ENG-79". `applyEventsToProjection` reads:

- `type` ← `EventRow.type` (top-level), `created_seq` ← `EventRow.server_sequence`, `stream_id` ←
  `EventRow.stream_id` (top-level columns; already populated).
- `type_version`, `author_user_id`, `payload` ← `EventRow.envelope.body.{type_version,
  author_user_id, payload}` (the §2.1 hashed body ENG-79 stores under `envelope.body`).

**RULING:** ENG-80 does **not** add a redundant top-level `type_version` column; apply reads it from
`envelope.body`. The contract is: **ENG-79 populates `EventRow.envelope` with at least `body`
(`{ type_version, author_user_id, payload }`)** for every event it caches. If `envelope`/`envelope.body`
is absent (defensive), apply **skips** that event (no crash). This is the single data dependency on
ENG-79 — record it in both plans. Coordinate the exact `envelope` field names before either merges.

### Shared files — collision protocol

Both tickets touch three shared files. **None of the three collisions is a Dexie schema change**, so
per the coordination brief they merge cleanly:

- **`worker/types.ts`** — both **append** to the `MsgDb` interface (different read/write methods) and to
  the RPC taxonomy. ENG-80 fills `MessageRow`, replaces the `QueryParams`/`QueryResult` stubs with the
  real projection-query union, and adds ENG-80's read methods to `MsgDb`. ENG-79 adds its own methods.
  Additive → mechanical rebase.
- **`worker/db.ts`** — both **add read/write methods to `DexieDb` + `MemoryDb`** (the classes), and
  ENG-80 replaces the `rebuildProjections` stub body. **Neither changes the `version(1).stores({…})`
  schema string** → no index collision (the coordination brief's exact condition: "if neither modifies
  db.ts's schema, no collision"). The `messages` table **schema** is read-only for ENG-80; the db.ts
  **file** is edited additively (new query methods + real rebuild). Second-to-merge rebases the added
  methods below the other's — no semantic conflict.
- **`worker/core.ts`** — ENG-80 replaces the **stub `query` handler** (delegate to the projection query
  dispatcher) and the `RpcResultMap['query']` type; ENG-79 adds sync wiring (WS connect, calls
  `applyEventsToProjection`, publishes). Different lines. Via the `register()` seam ("later
  registration wins"), even a raw ordering conflict is a mechanical reorder. Flag: coordinate who edits
  the `query` registration line (ENG-80) vs. the sync wiring (ENG-79).

ENG-80 is **testable standalone** — call `applyEventsToProjection`/`dumpMessages`/`rebuildProjections`
directly on a `MemoryDb`/fake-indexeddb with synthetic `EventRow`s; **no sync engine, no browser, no
server** needed.

---

## Implementation Plan

### Ruling 1 — `applyEventsToProjection`: dispatch, idempotency, D9

**Dispatch** mirrors ENG-58's `_HANDLERS` and ENG-69's `_HANDLERS`, keyed `(type, type_version)`:

```ts
// worker/projection.ts
type MessageHandler = (row: EventRow, body: EventBody) => MessageRow | null
const HANDLERS: Record<string, MessageHandler> = {
  'message.created@1': applyMessageCreatedV1,
}
```

- For each event (ordered ascending by `server_sequence` — Ruling 3), read `type` (top-level) +
  `type_version` (from `envelope.body`); look up `HANDLERS['`${type}@${type_version}`']`.
- **Handler found** (`message.created` v1) → build a `MessageRow`, collect for a single
  `db.putMessages(rows)` bulk upsert.
- **No handler** → **skip** (no row): unknown types (`widget.exploded`), `message.created` v≥2
  (above-max version, D9), and every meta event (`channel.created`, `user.joined`, …) fall here
  uniformly. The event **stays in `events`** (ENG-79 owns it; apply never deletes) and is never
  projected. **No cursor bookkeeping here** — ENG-79 already advanced `cursors` before calling; unlike
  the CLI/server, the client's apply is not responsible for cursor advance (that is the seam's
  division of labour). Never throw (D9).
- **Malformed known payload** (structurally-valid envelope, `message.created` v1, but `payload`
  missing/`message_id` invalid): **skip with a `console.warn`, do not throw.** This **diverges
  deliberately** from ENG-69's server *hard-error* stance: on the server a malformed known payload is
  corruption worth a 500; on the **client** a throw would wedge ENG-79's apply loop and the boot
  rebuild, so client robustness wins. It is unreachable in practice (the server validated the payload
  at accept, ENG-66), and skipping is deterministic, so rebuild ≡ incremental still holds (both sides
  skip identically). Note it in the module docstring so a reviewer doesn't "fix" it to a throw.

**`applyMessageCreatedV1`** reads `envelope.body.payload` → `{ message_id, text, format,
thread_root_id, mentions }` and `envelope.body.author_user_id`, and builds the `MessageRow` (Ruling 2).

**Idempotency** — collect all handled rows and one `db.putMessages(rows)` per call. `putMessages` is
Dexie `bulkPut` / `Map.set` = **upsert by `message_id` primary key** (put-or-replace). Because
`message.created` is **immutable** in M2 and the derived row is a **pure deterministic function of the
event**, a re-derived row is byte-identical to the stored one → the upsert-replace is observationally a
no-op, exactly matching ENG-58's `INSERT OR IGNORE` / ENG-69's `ON CONFLICT DO NOTHING`. (Dexie has no
"ignore" mode; replace-with-identical is the correct equivalent because the row is immutable. Pin this
with a first-write-equivalence unit test — Ruling 6 — mirroring ENG-58 Finding 3.)

### Ruling 2 — `MessageRow` shape (fill the ENG-77 placeholder)

ENG-77 left `MessageRow` as `{ message_id, stream_id, created_seq, thread_root_id?, body? }` — "render
fields land with ENG-80". Replace the `body?` blob with **explicit typed columns** (ENG-58 discipline:
explicit columns, never an opaque blob, so the dump has a fixed field order and badges can read
mentions):

```ts
export interface MessageRow {
  message_id: string          // pk (indexed)
  stream_id: string           // indexed
  created_seq: number         // = EventRow.server_sequence; [stream_id+created_seq] indexed
  author_user_id: string      // from envelope.body.author_user_id
  text: string                // from payload.text
  format: 'markdown' | 'plain'// from payload.format
  thread_root_id?: string     // from payload.thread_root_id (nullable → omitted when null); indexed
  mention_user_ids: string[]  // from payload.mentions — the "index mentions at apply time" of §3.5
}
```

- The indexed columns (`message_id`, `stream_id`, `[stream_id+created_seq]`, `thread_root_id`) are
  **unchanged** from ENG-77's `.stores()` string — the new fields (`author_user_id`, `text`, `format`,
  `mention_user_ids`) are **non-indexed row fields**, so **no schema/index change** (matches the
  no-collision condition). `thread_root_id` stays optional (Dexie indexes present values; root messages
  omit it — consistent with ENG-77's index).
- **`mention_user_ids` stored verbatim from `payload.mentions`** — the projection stays **independent
  of the signed-in user** (Ruling 4). Storing my-user-relative data here would make the dump depend on
  session identity and break rebuild-equivalence reproducibility. The red/no-red decision is a
  query-time derivation in `badges.ts`, not stored in the row.

### Ruling 3 — Determinism (the ENG-83 equivalence surface)

Mirror ENG-58 Ruling 5 / ENG-69 Ruling 3 exactly:

1. **Final `messages` state is a pure function of the `events` cache** — the set of rows depends only
   on the events, not on apply order, wall-clock, or Map/Dexie iteration order. Holds because rows are
   keyed by the immutable `message_id` and the derived row is a pure function of the event.
2. **Fixed apply order anyway:** within a call, events applied in **ascending `server_sequence`**;
   rebuild replays streams in **lexicographic `stream_id`** order, each stream ascending. State is
   order-independent (invariant 1) but a fixed order keeps a run reproducible.
3. **`dumpMessages(db) -> string`** — the canonical artifact (Dexie analogue of Python `dump_messages`):
   - Read all `messages`, sort in JS by **`(stream_id, created_seq, message_id)`** (total, stable:
     `(stream_id, created_seq)` is already unique per D2; `message_id` is a bulletproof final
     tie-break — mirrors ENG-69's `ORDER BY stream_id, created_seq, message_id`).
   - Each row → **one compact JSON object, fixed key order**, built by constructing the object in the
     canonical field order (JS `JSON.stringify` preserves string-key insertion order and emits compact
     output with no separators by default = ENG-58's `separators=(",",":")`; it leaves non-ASCII raw =
     `ensure_ascii=False`). `\n`-joined. **Never** `JSON.stringify(row)` on the raw row (field order not
     guaranteed) — use an explicit ordered projection.
   - **Dump columns (fixed order):** `message_id, stream_id, created_seq, author_user_id, text, format,
     thread_root_id, mention_user_ids`. `thread_root_id` emitted as `null` when absent (stable). Arrays
     serialize in payload order (stable).
   - **Note the intentional divergence from the server dump (ENG-69):** the client dump **includes**
     `format` and `mention_user_ids` (the client projection holds them; §4.2 `messages_proj` dropped
     `format` and never stored mentions). ENG-83's assertion is **client-incremental == client-rebuild**
     (both Dexie, same apply) — a **within-client** byte-equality, **not** client-dump == server-dump.
     Do **not** try to make the two dumps byte-identical; a cross-side (client Dexie ≡ server
     `messages_proj`) check, if ENG-83 wants one, compares the shared subset semantically. Record this
     so nobody couples the client dump to the server's column set.

`dumpMessages` is the single authoritative serializer; ENG-83 imports it (or reimplements the identical
sort + serialization). Ship it here as the ENG-83 contract surface.

### Ruling 4 — Client-side rebuild (invariant 6): derived-vs-source, and the `rebuildProjections` fill

**Derived-vs-source ruling** (what `PROJECTION_VERSION` mismatch drops vs. keeps) — already encoded in
ENG-77's `DERIVED_TABLES` const and `clearDerivedTables()`, confirmed here:

- **SOURCE (kept, never dropped, never evicted-to-empty):** `events` (the raw envelope cache — the
  rebuild input), `outbox` (pending local sends), `meta` (`projection_version`, session, `my_user_id`).
- **DERIVED (dropped on mismatch, rebuilt):** `messages`, `streams`, `cursors`, `read_state`.

Of the derived set, **what ENG-80's `rebuildProjections` rebuilds locally from `events` vs. what
ENG-79's resumed pulls refill** (§5.2: "drop derived tables, re-apply from cached `events`, **then
resume pulls**"):

- **`messages`** — ENG-80 rebuilds **locally from the cached `events`** (the whole point; it is a pure
  function of the events). This is the only table `rebuildProjections` reconstructs.
- **`streams`, `cursors`, `read_state`** — these are **echoes of server-authoritative state** (stream
  name/visibility/`head_seq`/membership, pull progress, and the read-state KV) and are **not derivable
  from the cached message `events` alone**. They are refilled by **ENG-79's resumed pulls** (the "then
  resume pulls" clause). `rebuildProjections` leaves them empty for ENG-79 to repopulate. This keeps
  ENG-80's rebuild self-contained and unit-testable with **no sync engine**: the `messages`↔`events`
  relationship is fully local.

**Fill ENG-77's `rebuildProjections(db)` stub** (currently: asserts `messages` count 0, does nothing):

```ts
// db.ts — replaces the stub; delegates to projection.ts to keep replay logic out of db.ts
export async function rebuildProjections(db: MsgDb): Promise<void> {
  const remaining = await db.count('messages')
  if (remaining !== 0) throw new Error('rebuildProjections: derived tables must be cleared before rebuild')
  await rebuildMessagesProjection(db)   // projection.ts: replay events → messages
}
```

```ts
// worker/projection.ts
export async function rebuildMessagesProjection(db: MsgDb): Promise<void> {
  const streamIds = await db.listStreamIds()          // distinct stream_ids in `events`
  for (const streamId of [...streamIds].sort()) {     // lexicographic (Ruling 3.2)
    const events = await db.getEventsForStream(streamId)   // ascending by server_sequence
    await applyEventsToProjection(db, streamId, events)     // SAME apply the incremental path uses
  }
}
```

**Reusing the exact same `applyEventsToProjection` for replay is what makes rebuild ≡ incremental true
by construction** (ENG-58 reused `project`, ENG-69 reused `apply_projection`). `checkProjectionVersion`
(ENG-77, unchanged) already clears derived tables then calls `rebuildProjections` then stamps the new
version — the drop+replay+resume flow is complete once the stub is filled. The `db.ts` edit is: import
`rebuildMessagesProjection` from `projection.ts`, replace the stub body. Keep replay **logic** in
`projection.ts` (avoids a `db.ts`↔`projection.ts` cycle by having `db.ts` import the one function;
`projection.ts` imports only `MsgDb`/row types from `types.ts`, not `db.ts`).

### Ruling 5 — Badges (§3.5) + the projection query RPC

**Badges live in `worker/badges.ts`, derived at query time, user-relative, no server round trip:**

```ts
// worker/badges.ts
export interface StreamBadge { stream_id: string; unread: number; mention: boolean }
export async function computeStreamBadge(db, streamId, myUserId): Promise<StreamBadge>
export async function computeAllBadges(db, myUserId): Promise<StreamBadge[]>
```

- **`unread = max(0, head_seq − last_read_seq)`** — `head_seq` from the `streams` row (§5.2 lists
  `head_seq` on `streams`; populated by ENG-79's bootstrap/pulls), `last_read_seq` from the
  `read_state` row (default 0 when absent). A plain arithmetic count, matching §3.5.
- **`mention`** = there exists a `messages` row in the stream with `created_seq > last_read_seq` **and**
  `myUserId ∈ mention_user_ids`. Computed by scanning the stream's projected rows (bounded by the
  `[stream_id+created_seq]` index range `> last_read_seq`) — this is §3.5's "a mention with
  `seq > last_read_seq` sets the red badge", derived from the **at-apply-time-indexed**
  `mention_user_ids`, **no server round trip**.
- **`myUserId`** is supplied by the caller (the query handler reads it from `meta[META_MY_USER_ID]` /
  the `WorkerCore` auth). Keeping it a parameter (not read inside `badges.ts`) keeps the badge functions
  pure and unit-testable, and keeps the `messages` projection user-independent (Ruling 2/3).

**RULING — mention index lives as `mention_user_ids` on the `messages` row, NOT a separate table.** The
§5.2 schema is fixed at 7 tables and this ticket must not add one (a new table = a `.stores()` change =
schema collision with ENG-79, forbidden). The messages table already exists; a non-indexed array column
adds the index for free. The mention *badge* is then a query-time scan, not stored state.

**Projection query RPC (pin 5)** — replace ENG-77's `QueryParams = { q: string }` stub with the real
discriminated union (types.ts), and replace the stub `query` handler in `core.ts` with a dispatcher that
delegates to `projection.ts`/`badges.ts`. Tabs (ENG-82) read projections through this — **never the HTTP
API for message data**.

```ts
// worker/types.ts — real union (replaces the stub)
export type QueryParams =
  | { q: 'messages.list'; stream_id: string; before_seq?: number; limit?: number }  // paginated by created_seq (desc), older via before_seq
  | { q: 'streams.list' }                                                            // sidebar: streams + unread/mention badges
  | { q: 'message.get'; message_id: string }                                         // a single message

// QueryResult keyed per-q (conditional map, mirroring the existing pattern):
//   'messages.list' → { messages: MessageRow[]; has_more: boolean }
//   'streams.list'  → { streams: Array<StreamRow & StreamBadge> }
//   'message.get'   → { message: MessageRow | null }
```

- `core.ts`: replace the stub `register('query', …)` body with a dispatcher switching on `params.q`,
  calling `listMessagesByStream` / (`listStreams` + `computeAllBadges`) / `getMessage` in
  `projection.ts`/`badges.ts`, reading `myUserId` from `this.auth`/`meta`. Update
  `RpcResultMap['query']` from `NotImplementedResult` to the real union result. Minimal, single-method
  edit (the coordination point flagged above).
- The `WorkerClient.query<Q>(params)` surface (client.ts) is **unchanged** — it is already generic over
  `QueryParams`/`QueryResult` (ENG-77 D-1). ENG-82's stores get typed reads for free.

### Ruling 6 — `MsgDb` read-method additions (the documented ENG-77 interface tax)

`applyEventsToProjection`/`rebuildMessagesProjection`/`dumpMessages`/badges/queries need reads the
ENG-77 `MsgDb` interface does not yet expose. Add them to the interface (types.ts) **and both impls**
(`DexieDb`, `MemoryDb` in db.ts) — this is exactly the "interface grows as ENG-79/80/81 add queries"
tax ENG-77 documented (D-4, risk 3). Additive, no schema change:

```ts
// added to MsgDb (types.ts) + DexieDb + MemoryDb (db.ts)
listStreamIds(): Promise<string[]>                                   // distinct stream_ids in `events` (rebuild)
getEventsForStream(streamId: string): Promise<EventRow[]>           // full rows, ascending server_sequence (rebuild)
getMessage(messageId: string): Promise<MessageRow | undefined>      // query message.get
listMessagesByStream(streamId: string,                             // query messages.list (uses [stream_id+created_seq] index)
  opts: { beforeSeq?: number; limit: number }): Promise<MessageRow[]>
getAllMessages(): Promise<MessageRow[]>                             // dumpMessages source (sorted in JS)
listStreams(): Promise<StreamRow[]>                                 // sidebar
listReadState(): Promise<ReadStateRow[]>                            // sidebar badges (batch)
getStreamMessagesMentioning(streamId, afterSeq, userId):           // mention badge — OR fold into listMessagesByStream + JS filter
  Promise<boolean>
```

- **DexieDb** uses the fluent API inside the class (`this.db.messages.where('[stream_id+created_seq]')
  .between([streamId, afterSeq], [streamId, Dexie.maxKey], false, true)` etc.). **MemoryDb** filters +
  sorts its Maps. Both return the same shapes (the ENG-77 dual-backend discipline).
- Keep the mention scan cheap: bound it to `created_seq > last_read_seq` via the compound index; do not
  scan the whole table. (Fold `getStreamMessagesMentioning` into a small `listMessagesByStream`+filter if
  simpler — implementer's call, keep it index-bounded.)
- Collision note: ENG-79 adds its **own** methods (cursor advance, stream/read_state writes) to the same
  interface + impls. Different method names → additive merge (flagged above).

---

## File list

**Create (`ui-engineer`):**

| File | Contents |
|---|---|
| `web/src/worker/projection.ts` | `HANDLERS`, `applyMessageCreatedV1`, **`applyEventsToProjection(db, streamId, events)`** (the ENG-79 seam), `rebuildMessagesProjection(db)`, `dumpMessages(db)`, and the projection query helpers (`listMessagesByStream` wrapper, `getMessage`, `listStreamsForSidebar`). Reads only `MsgDb` + row/`EventRow` types — no `db.ts` import, no platform globals. Module docstring: the D9/malformed-skip stance + the client-vs-server dump divergence + "PERMANENT: this is the client side of §12 invariant 6". |
| `web/src/worker/badges.ts` | `StreamBadge`, `computeStreamBadge`, `computeAllBadges` (unread = head_seq−last_read_seq; mention scan over `mention_user_ids`). Pure `MsgDb`-only. |
| `web/tests/unit/worker/projection.spec.ts` | apply → correct `MessageRow` columns; `message.created` v1 only; unknown type (`widget.exploded`) → no row + no throw (D9); `message.created` v2 → no row (above-max, D9); meta event → no row; malformed known payload → skip + warn, no throw; idempotent re-apply (Ruling 1) → identical dump; `thread_root_id` set + null; `mention_user_ids` verbatim from payload. Run against **both** `MemoryDb` and `DexieDb`(fake-indexeddb) via `describe.each` (mirrors `db.spec.ts`). |
| `web/tests/unit/worker/badges.spec.ts` | unread arithmetic (head_seq−last_read_seq, floor 0, missing read_state ⇒ 0); mention true only when `seq > last_read_seq` **and** `myUserId ∈ mention_user_ids`; user-independence (different `myUserId` ⇒ different badge, same projection). |
| `web/tests/unit/worker/projection-equivalence.spec.ts` | **The ENG-80-local rebuild≡incremental proof.** Docstring banner: "PERMANENT GATE (client Dexie side of §12 invariant 6) — ENG-83 extends into the property suite; never delete." (a) Build synthetic `EventRow`s (message.created v1 across ≥2 streams, incl. unicode text + optional `thread_root_id`/`mentions`, plus injected `widget.exploded` v7 and `message.created` v2), apply **incrementally** (per-stream batches through `applyEventsToProjection`) → `dumpMessages` = `dumpIncremental`. (b) `clearDerivedTables()` + `rebuildProjections(db)` (drop+replay) → `dumpRebuilt`. **Assert `dumpIncremental === dumpRebuilt`** byte-equal. (c) Idempotence: re-apply all events → dump unchanged. (d) D9: `messages` count == number of `message.created` v1 events; no row for the unknown/v2 events; `events` count unchanged (apply never deletes). (e) **Teeth** (mirror ENG-61 §4): monkeypatch `HANDLERS['message.created@1']` for the **rebuild pass only** to corrupt one row's `text`; assert `dumpCorrupt !== dumpIncremental` (proves the `===` has teeth) + a clean positive control. |
| `web/tests/unit/worker/query.spec.ts` *(or fold into `core.spec.ts`)* | The projection query RPC round-trips through `WorkerCore.handle`: `messages.list` (pagination via `before_seq`/`limit`, `has_more`), `streams.list` (streams + unread/mention badges), `message.get` (hit + miss → `null`). Fake `MessageSink`, both backends. |

**Modify (`ui-engineer`):**

| File | Change |
|---|---|
| `web/src/worker/types.ts` | Fill `MessageRow` (Ruling 2); replace `QueryParams` stub with the real `q`-discriminated union + refine `QueryResult` per-`q` (Ruling 5); add the ENG-80 read methods to the `MsgDb` interface (Ruling 6). All additive / stub-replacing — no `Topic`/transport/`WorkerClient` change. |
| `web/src/worker/db.ts` | Implement the new `MsgDb` read methods on **both** `DexieDb` and `MemoryDb` (Ruling 6); replace the `rebuildProjections` stub body with the real `rebuildMessagesProjection(db)` delegation (Ruling 4). **No `version(1).stores({…})` change** (schema read-only). |
| `web/src/worker/core.ts` | Replace the stub `register('query', …)` body with the projection query dispatcher (delegates to `projection.ts`/`badges.ts`, reads `myUserId` from `this.auth`); update `RpcResultMap['query']` to the real result union. Minimal, single-method edit. |
| `web/src/worker/index.ts` | (Optional) re-export `dumpMessages` / `applyEventsToProjection` if ENG-83's Playwright/gate harness imports them from the barrel; otherwise leave as-is (tests import from `../../../src/worker/projection`). |

**No** `package.json` / dependency change (`dexie` + `fake-indexeddb` already present from ENG-77).
**No** Dexie `version()` bump, **no** `.stores()` change, **no** server/cli/CI change (the existing `web`
CI job runs `pnpm typecheck && lint && test && build` over the new files).

---

## Step-by-step (all `ui-engineer`)

1. **Types (`types.ts`).** Fill `MessageRow` (Ruling 2). Replace `QueryParams`/`QueryResult` stubs with
   the real union (Ruling 5). Add the ENG-80 read methods to `MsgDb` (Ruling 6). `pnpm typecheck` will
   now flag the two impls + the stub `query` handler — that is the work list for steps 2–4.
2. **DB impls (`db.ts`).** Implement the new read methods on `DexieDb` (fluent, index-bounded) and
   `MemoryDb` (Map filter/sort). Replace the `rebuildProjections` stub with the `rebuildMessagesProjection`
   delegation. Land `db.spec.ts` additions (new read methods return correct shapes on both backends).
3. **Projection (`projection.ts`).** `HANDLERS` + `applyMessageCreatedV1`; `applyEventsToProjection`
   (dispatch, D9 skip, malformed-skip, ordered, one `putMessages`); `rebuildMessagesProjection` (replay
   via the same apply); `dumpMessages` (ordered compact serialization); the query helpers. Land
   `projection.spec.ts`.
4. **Badges (`badges.ts`).** `computeStreamBadge`/`computeAllBadges`. Land `badges.spec.ts`.
5. **Query RPC (`core.ts`).** Replace the stub `query` handler with the dispatcher; update
   `RpcResultMap['query']`. Land `query.spec.ts` (round-trip through `WorkerCore.handle`).
6. **Equivalence proof.** Land `projection-equivalence.spec.ts` (drop+replay == incremental byte-equal
   dump, idempotence, D9, teeth). This is the ENG-80-local invariant-6 proof.
7. **Gate.** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green. Confirm the `db.spec.ts`
   PROJECTION_VERSION-mismatch test still passes now that `rebuildProjections` actually replays (seed
   `events` + stale `projection_version` ⇒ `messages` rebuilt from `events`, not just cleared).

---

## Test plan (vitest, `web/tests/unit/worker/`, `MemoryDb` + fake-indexeddb, synthetic `EventRow`s)

Coverage matrix (maps to ACs):

- **Incremental apply / columns** → `projection.spec.ts`: v1 event → row with correct
  `message_id/stream_id/created_seq/author_user_id/text/format/thread_root_id/mention_user_ids`.
- **D9** → unknown type + `message.created` v2 + meta event → **no** `messages` row, **no throw**,
  `events` retained (`projection.spec.ts` + the equivalence spec's D9 assertion).
- **Idempotent** → re-apply same events ⇒ dump unchanged, row count unchanged (`projection.spec.ts` +
  equivalence spec).
- **Rebuild ≡ incremental** → `projection-equivalence.spec.ts`: drop+replay dump == incremental dump,
  byte-equal; the ENG-80-local stand-in for ENG-83's property gate; also proves `dumpMessages` is
  order-stable.
- **Teeth** → equivalence spec: one-row corruption on the rebuild pass only ⇒ dumps differ (+ clean
  positive control) — the gate detects divergence.
- **PROJECTION_VERSION rebuild** → extend `db.spec.ts`: stale `projection_version` + seeded `events`
  ⇒ `checkProjectionVersion` clears derived + `rebuildProjections` replays `messages` from `events`;
  `events`/`outbox` untouched (ENG-77's test now exercises a real replay, not a no-op).
- **Badges** → `badges.spec.ts`: unread arithmetic (+ floor, missing read_state); mention true iff
  `seq > last_read_seq` ∧ `myUserId ∈ mentions`; user-independence.
- **Query RPC** → `query.spec.ts`: `messages.list` pagination + `has_more`; `streams.list` with badges;
  `message.get` hit/miss; round-trips through `WorkerCore.handle` on both backends.

Local run: `pnpm test`. CI: the existing `web` job (`pnpm test`) collects the new specs automatically
(`tests/unit/**/*.spec.ts`).

---

## Risks / open questions

1. **`EventRow.envelope` shape is the one hard cross-ticket contract.** ENG-80 reads
   `envelope.body.{type_version, author_user_id, payload}`; ENG-79 populates `envelope`. Field names
   must be agreed **before either merges** (flagged in Coordination). Mitigation: apply **skips**
   (no crash) if `envelope`/`body` is absent, so a shape mismatch degrades to "no rows" (caught loudly
   by the equivalence + query tests), not a crash.
2. **`core.ts` shared edit with ENG-79.** Both touch `core.ts`; ENG-80 owns the `query` registration
   line, ENG-79 the sync wiring + `applyEventsToProjection` call site + publish. Different lines; the
   `register()` "later wins" seam makes even a raw conflict a mechanical reorder. Coordinate the
   ownership of the `query` line.
3. **Malformed-known-payload skip diverges from the server's hard-error (ENG-69).** Deliberate (client
   robustness > strictness; unreachable in practice; deterministic so equivalence holds). Documented in
   the module docstring so a reviewer doesn't "fix" it to a throw. Flag for the code reviewer.
4. **Client dump ≠ server dump columns.** The client dump includes `format` + `mention_user_ids`; the
   server (ENG-69) dropped `format` and never stored mentions. ENG-83's assertion is **client-incremental
   == client-rebuild** (within-client). Do **not** couple the client dump to the server column set; a
   cross-side check (if wanted) compares the shared subset semantically. Recorded so ENG-83 doesn't
   attempt a byte compare across sides.
5. **Bounded cache vs. mention/unread accuracy.** The `events`/`messages` cache is bounded (~2,000/stream,
   ENG-77 eviction). A mention in an evicted event is not in the projection, so the mention scan can miss
   it; `unread` is unaffected (it uses `streams.head_seq`, a number, not a row scan). Acceptable at M2
   scale (§3.5 computes the badge "from its projection"); the server bootstrap can also carry a mention
   flag if precision ever matters (deferred, note for ENG-79/ENG-82).
6. **`streams`/`cursors`/`read_state` refill after rebuild is ENG-79's job** (§5.2 "then resume pulls").
   ENG-80's `rebuildProjections` rebuilds **only** `messages` from `events`; if ENG-79's resume is not
   yet wired when ENG-80 lands, the sidebar (streams) is empty until first pull — expected, not an
   ENG-80 bug. The ENG-80-local tests seed `streams`/`read_state` directly, so they don't depend on
   ENG-79.
7. **Dexie `bulkPut` is replace-not-ignore.** Safe because `message.created` rows are immutable +
   deterministic (re-derived == stored). Pinned by the idempotence + first-write-equivalence tests
   (Ruling 1, ENG-58 Finding 3 analogue). If a future mutable event type (edits) lands, the apply must
   switch to an explicit merge — noted for M3, out of scope here.

---

## Concise summary (for the dispatcher)

- **The apply seam (ENG-79 calls this):** `applyEventsToProjection(db, streamId, events: readonly
  EventRow[]) → Promise<void>` in `worker/projection.ts`. Idempotent (upsert by `message_id`;
  message.created immutable ⇒ replace-with-identical = no-op, the Dexie analogue of `INSERT OR IGNORE`).
  Dispatch keyed `(type, type_version)`; only `message.created` v1 → a `messages` row; unknown types /
  v≥2 / meta / malformed-known → **skip, never throw** (D9 + client robustness). Reads `type`/
  `server_sequence`/`stream_id` from the `EventRow` top-level and `type_version`/`author_user_id`/
  `payload` from `EventRow.envelope.body` (the ENG-79 contract). Applies only `messages`; ENG-79 owns
  `events`/`cursors`.
- **Derived vs. source (rebuild):** SOURCE kept = `events`, `outbox`, `meta`; DERIVED dropped =
  `messages`, `streams`, `cursors`, `read_state`. `rebuildProjections` (ENG-77 stub, now filled)
  rebuilds **only `messages`** locally from cached `events` via the **same** `applyEventsToProjection`
  (rebuild ≡ incremental by construction); `streams`/`cursors`/`read_state` are refilled by ENG-79's
  resumed pulls (§5.2 "then resume pulls").
- **Deterministic dump:** `dumpMessages(db)` — all `messages` sorted by `(stream_id, created_seq,
  message_id)`, each row one compact JSON object with fixed key order `message_id, stream_id,
  created_seq, author_user_id, text, format, thread_root_id, mention_user_ids`, `\n`-joined. Includes
  `format`+`mention_user_ids` (client-only) — ENG-83 asserts **client-incremental == client-rebuild**,
  not client==server.
- **Badges (`worker/badges.ts`, no server round trip):** `unread = max(0, streams.head_seq −
  read_state.last_read_seq)`; `mention` = a `messages` row in the stream with `created_seq >
  last_read_seq` ∧ `myUserId ∈ mention_user_ids`. Mention index = the `mention_user_ids` **column on the
  `messages` row** (not a new table — schema is fixed); the red/no-red decision is query-time +
  user-relative, keeping the projection user-independent.
- **Projection query RPC:** replace ENG-77's `QueryParams` stub with `{ q: 'messages.list', stream_id,
  before_seq?, limit? } | { q: 'streams.list' } | { q: 'message.get', message_id }`; the `core.ts`
  `query` handler dispatches to `projection.ts`/`badges.ts`. Tabs read projections here, never the HTTP
  API for message data. `WorkerClient.query<Q>` surface unchanged.
- **Testability:** everything unit-testable on `MemoryDb`/fake-indexeddb with synthetic `EventRow`s (no
  browser/sync/server). `projection-equivalence.spec.ts` is the ENG-80-local drop+replay == incremental
  byte-equal proof (+ idempotence, D9, teeth); ENG-83 extends it into the property suite.
- **Files:** create `worker/projection.ts`, `worker/badges.ts`, 4 spec files; modify `worker/types.ts`
  (`MessageRow` + `QueryParams`/`QueryResult` + `MsgDb` reads), `worker/db.ts` (new read methods on both
  impls + real `rebuildProjections`), `worker/core.ts` (real `query` handler). **No schema/`stores()`
  change, no dep change, no server/cli/CI change.**
- **Risks:** the `EventRow.envelope` field-name contract with ENG-79 (agree before merge; apply skips if
  absent); the `core.ts` shared `query`-line edit; the deliberate malformed-skip divergence from the
  server; client-dump ≠ server-dump columns; bounded-cache mention accuracy.
- **Agent:** all `ui-engineer`.
