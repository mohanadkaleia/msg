# ENG-83 — M2 §12 acceptance architecture (all six invariants green in CI)

The M2 hard gate (TDD §13): all six §12 invariants asserted green in CI. This
note captures the central design call — how the acceptance suite is split across
two languages — and justifies each choice. It is committed BEFORE the
implementation so the architecture is reviewable independent of the code.

## The six invariants (TDD §12, verbatim intent)

1. **Idempotency** — duplicate uploads never create duplicate events; retried
   mid-flight sends converge to exactly one accepted event.
2. **Convergence** — all clients' projections are byte-identical to each other
   and to a fresh rebuild-from-pull.
3. **Cursor integrity** — reconnect after arbitrary missed events yields
   gapless, duplicate-free per-stream sequences.
4. **Permission isolation** — a non-member observes zero private-stream data via
   pull, sync heads, search, files, or WS fanout (adversary client, every run).
5. **Pending settling** — optimistic messages end in correct server order with
   no lost/duplicated renders (asserted at the projection layer).
6. **Rebuild equivalence** — dropping projections and replaying equals
   incremental state — client (Dexie) **and** server (`messages_proj`) both.

## The central call: a cross-language split, NOT a rewrite (lean option (a))

The M1 harness (`server/tests/simulation/`, ENG-71) already asserts 1–4 on every
hypothesis example against a REAL in-process server + ephemeral Postgres. Its
docstrings explicitly frame invariants 5 and the client half of 6 as *documented
seams* to be extended at M2, and note "M2 extends this suite rather than
rewriting it." We take that at its word.

**Why split by language rather than unify.** Invariants 1–4 are *server*
properties — they are about what the server stores, sequences, and refuses to
disclose. They are only meaningful against the real Python/Postgres server, and
the Python hypothesis harness already drives N simulated clients + an adversary
against it. Invariants 5 and the client half of 6 are *client* properties — they
are about the browser's optimistic-render layer and its Dexie rebuild. They only
exist in the TypeScript worker (`WorkerCore`/`outbox`/`projection`/`db`). There
is no single process that owns both halves; forcing them into one harness would
mean either (a) reimplementing the TS client logic in Python (a model that proves
nothing about the shipping code) or (b) booting a browser to assert server
sequencing (slow, and redundant with the Python sim). The honest, minimal
architecture asserts each property in the language that owns it.

### Ownership map

| Invariant | Owner | Where |
|---|---|---|
| 1 Idempotency | Python sim | `server/tests/simulation/` (unchanged) |
| 2 Convergence | Python sim | `server/tests/simulation/` (unchanged) |
| 3 Cursor integrity | Python sim | `server/tests/simulation/` (unchanged) |
| 4 Permission isolation | Python sim | `server/tests/simulation/` (unchanged) |
| 5 Pending settling | **TS property suite (new)** | `web/tests/unit/worker/invariant5-pending-settling.property.spec.ts` |
| 6 client (Dexie rebuild≡incremental) | **TS property suite (new)** | `web/tests/unit/worker/invariant6-client-rebuild.property.spec.ts` |
| 6 server (`messages_proj` rebuild≡incremental) | Python equivalence gate | `cli/tests/test_equivalence_gate.py` + `server/tests/test_equivalence_gate_server.py` (unchanged) |

The Python side is **verify-don't-rewrite** (STEP 3): confirmed green against the
current M2 server before writing a line of the TS suite (1–4 + both equivalence
gates: green).

## Drive the REAL engine, never a reimplementation

The single most important discipline: the TS property tests exercise the ACTUAL
shipping code, not a parallel model of it.

- Invariant 5 drives a **real `WorkerCore`** (`new WorkerCore(db, sink, { http,
  wsFactory })`) via the established browser-free seam: an injected
  `FakeHttpClient` backed by the hermetic `FakeSyncServer` (the same server
  model the ENG-79/81 unit suites use — real per-stream sequencing, real
  `event_id` UNIQUE idempotency), an injected `FakeWsFactory` for the WS race,
  and the real default projection seam. Sends go through the real RPC surface
  (`core.handle(..., { t:'req', req:{ method:'mutate', params:{ m:'outbox.send'
  … } } })`), settle through the real `Outbox.runDrain`/`settle`/`reject`, and
  land in the real `messages` projection via the real `applyEventsToProjection`.
  Nothing about the message lifecycle is re-modelled in the test — the test only
  *generates histories* and *asserts invariants on the resulting DB state*.

- Invariant 6 client drives the real `applyEventsToProjection` (incremental) and
  the real `rebuildProjections` (`clearDerivedTables` → `rebuildMessagesProjection`
  from `events` + `applyOutboxToProjection` from `outbox`) — the exact functions
  db.ts calls on a stale `PROJECTION_VERSION` boot. The dump under comparison is
  the real `dumpMessages`. A test that re-derived rows itself would prove nothing;
  it asserts the shipping incremental path and the shipping rebuild path agree.

A property test that re-implements the logic under test is worthless — it proves
the test author can write the algorithm twice, not that the code is correct. Both
suites are strictly *black-box over the real modules*.

## Invariant 6 client: exercise the REAL Dexie path, not only MemoryDb

`MemoryDb` is a test double (a `Map`-backed `MsgDb`); the code that SHIPS in the
browser is `DexieDb` over IndexedDB. The permanent gate must cover the real path,
so:

- The randomized property loop (many fast-check cases) runs against **`MemoryDb`**
  for speed — hundreds of rebuild cycles per run stay sub-second.
- **AND** every generated history is *also* asserted at least once against the
  **real `DexieDb`** on `fake-indexeddb` (the same `openDb(fakeIdbOptions())`
  path the existing `projection-equivalence.spec.ts` uses under `describe.each`).
  Concretely: a dedicated gating assertion replays a fast-check-drawn history
  through `DexieDb` and asserts `rebuild === incremental` byte-equal — so the
  shipping IndexedDB rebuild (compound-index ordering, `bulkPut` upsert
  semantics, the real `clearDerivedTables` transaction) is what the gate holds.

This is the justification for the two-tier structure: MemoryDb gives breadth
(many random cases cheaply); DexieDb gives fidelity (the bytes that ship). Both
are required; neither alone is sufficient. Invariant 5's ack-vs-WS race and the
DexieDb assertion also both run through the real engine, so `MemoryDb` is never
the *only* thing gated for either invariant.

## Property-testing library: `fast-check`

Added as a `web` devDependency. It is the de-facto TS property-testing library
(the analogue of Python's `hypothesis` the Python sim already uses), with
shrinking so a failing case reduces to a minimal reproduction. The generators:

- **Invariant 5** generates a randomized *command script* over multiple streams:
  `send`, `ack-drain` (release a paused batch so queued sends settle),
  `reject-next-send` (configure the FakeSyncServer to reject a send → parked
  `failed`), and `ws-race` (server processes a send and emits its WS frame before
  vs after the client's batch POST completes — both arrival orders). fast-check
  draws the command sequence, the stream each send targets, and the race order.
  The invariant is asserted on the terminal DB state after every drawn script.

- **Invariant 6 client** generates a randomized *event history*: N streams, each
  with a drawn sequence of `message.created` v1 events (varying text incl.
  unicode, optional `thread_root_id`/`mentions`, `plain`/`markdown`) interleaved
  with D9-skip events (unknown types, v≥2, meta), PLUS a drawn set of outbox rows
  (pending/failed, and the crash-orphaned "settled but still in outbox" case).
  Apply incrementally → snapshot `dumpMessages` → drop derived tables → rebuild →
  assert byte-equal.

## The six-green union as the CI gate

`.github/workflows/ci.yml` gains explicit, named coverage so each invariant is
*visibly* asserted (a reviewer can point at the step that owns each one):

- **`checks` job** (existing, Python/uv) keeps the named
  `Equivalence gate (rebuild ≡ incremental)` (CLI, inv 6 server) +
  `Equivalence gate (server · rebuild ≡ incremental)` (Postgres, inv 6 server) +
  `Simulation suite` (inv 1–4) steps, byte-for-byte. These already gate 1–4 and
  the server half of 6.
- **`web` job** (existing, Node/pnpm) runs `pnpm test`, which now *includes* the
  two new property suites — so invariant 5 and the client half of 6 gate on every
  push. A dedicated named step **`Invariant suite (§12 — pending-settling +
  client rebuild)`** runs *only* the two property spec files as a separately
  visible signal (in addition to their inclusion in the full `pnpm test`), so
  "invariant suite red" is a distinct diagnosis from "some other web test red".
- **`e2e` job** (new, separate, heavier) runs the Playwright golden path against a
  real built Vue app (`vite preview`) + a real `msgd` server (Postgres
  testcontainer-style ephemeral DB + subprocess uvicorn, the exact mechanism
  `cli/tests/_e2e_server.py` uses for the M1 exit gate). Kept a separate job
  because it installs browsers + boots a server — the slow tail should not gate
  the fast unit signal.

**Six-invariant → CI-step mapping (the gate):**

| # | Invariant | CI job · step |
|---|---|---|
| 1 | Idempotency | `checks` · Simulation suite |
| 2 | Convergence | `checks` · Simulation suite |
| 3 | Cursor integrity | `checks` · Simulation suite |
| 4 | Permission isolation | `checks` · Simulation suite |
| 5 | Pending settling | `web` · Invariant suite (§12) + Unit tests |
| 6 | Rebuild equivalence — client | `web` · Invariant suite (§12) + Unit tests |
| 6 | Rebuild equivalence — server | `checks` · Equivalence gate (CLI + server) |

All six are green when the `checks` and `web` jobs are green — that conjunction
IS the M2/M3 gate.

## Teeth (acceptance criterion): the suite provably catches a real regression

A gate that passes vacuously is worthless. We follow the ENG-61/71 mutation
discipline: a deliberately-injected client bug must turn the suite RED.

- The existing `projection-equivalence.spec.ts` already carries an inline TEETH
  case for invariant 6 (corrupt one row on the rebuild pass only → dumps differ).
  We preserve it and add property-level teeth.
- **Env-gated mutation, checked in and green-by-default.** An env var
  `MSG_MUTATE` (read only inside the test files) can flip one of two well-known
  client bugs into the engine's *observed behavior within the test*:
  - `MSG_MUTATE=inv5-drop-ack` — the invariant-5 harness, after a settle, deletes
    the settled projection row (models a client that loses an acked message). The
    property "every accepted send is exactly one settled row" then fails.
  - `MSG_MUTATE=inv6-rebuild-skew` — the invariant-6 harness monkeypatches the
    `message.created@1` HANDLER on the rebuild pass only to mutate one row's
    `text` (the ENG-61 pattern), so `rebuild !== incremental`.
  With `MSG_MUTATE` unset (CI default) both suites are green. A reviewer runs
  `MSG_MUTATE=inv5-drop-ack pnpm test invariant5` (or `inv6-rebuild-skew …
  invariant6`) to watch the suite go red — proving the assertions have teeth
  without shipping a red test. The exact commands + the observed failures are
  documented in the PR body.

## Results — teeth proven, infra findings

**Teeth (proven, both directions):**

- `MSG_MUTATE=inv5-drop-ack pnpm test invariant5` → RED. The mutant db drops the
  settled row on `putMessages`; the invariant catches it as a leftover `pending`
  row: `AssertionError: expected 'pending' to be undefined`
  (`Counterexample: [[{stream:0,reject:false,race:"none"}]]`).
- `MSG_MUTATE=inv6-rebuild-skew pnpm test invariant6` → RED. The rebuild-only
  HANDLER corruption makes one row's `text` differ, so `rebuild !== incremental`:
  `AssertionError: expected '{"message_id":"m_1"…' to be '{"message_id":"m_1"…'`.
- With `MSG_MUTATE` unset (CI default) both suites are GREEN (348 web tests pass).

**Infra findings baked into the harness (Playwright):**

1. **uvicorn WS subprotocol / `websockets` v16.** The server authenticates the WS
   via `Sec-WebSocket-Protocol: bearer, <token>` read from
   `scope["subprotocols"]`. uvicorn's default `websockets` (v16) backend does NOT
   surface the offered subprotocols in the ASGI scope, so the token is invisible
   and the server closes pre-accept (4401 → HTTP 403) even with a valid token
   (confirmed: the same token authorizes `GET /v1/sync` 200 but the WS upgrade
   403s). Forcing `--ws wsproto` populates the scope and the handshake succeeds.
   This is a real server-side gap that only surfaces against a real uvicorn
   subprocess — the ENG-68 WS tests all run in-process (ASGI transport), so they
   never exercised it. **Flagged for the server owner**: uvicorn+websockets-v16
   WS is broken for this app; either pin the ws backend or the websockets version
   server-side. The e2e harness works around it with `--ws wsproto`.
2. **Same-origin topology (no proxy).** vite's `preview` proxy does not forward
   the WS subprotocol header either, so rather than proxy, the harness serves the
   built SPA directly from msgd (`MSG_SERVE_SPA` + `MSG_WEB_DIST_DIR`) — the
   production topology (one origin for HTML + API + WS). More faithful and
   proxy-free.
3. **Sidebar wiring gap (fixed).** The workspace store loaded the sidebar once at
   mount, before the sync catch-up pull populated `streams`; its per-stream
   `{kind:'stream'}` subscriptions cannot cover a stream that does not exist yet,
   so a freshly-synced `general` never appeared until a reload. Fixed minimally:
   the store also re-queries `streams.list` on every `{kind:'sync'}` push. The
   golden path surfaced this real M2 integration bug.
4. **Channel bootstrap.** `POST /v1/setup` creates only `workspace-meta`; a
   channel is born from a `channel.created` event. The harness bootstraps the
   owner + a public `general` via `msgctl` before the browser runs, so the golden
   path just logs in.

## Branch protection (flag for a human)

Marking the gate "required" in GitHub branch protection is a repo-settings change
that may be outside automation scope. The exact required checks to mark are the
job names: **`lint · type · test`** (the `checks` job — inv 1–4 + 6-server) and
**`web · lint · type · test · build`** (the `web` job — inv 5 + 6-client). The
Playwright `e2e` job should also be marked required for M3. This is called out in
the PR body for the human to set in repo settings.
