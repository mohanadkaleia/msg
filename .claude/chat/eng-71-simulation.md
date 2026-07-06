# ENG-71 — M1: Simulation suite skeleton (the §12 acceptance harness)

**Milestone:** M1 (server). **Exit-criterion line item:** TDD §13 M1 — "simulation
suite skeleton green". **Becomes:** the M2 go/no-go gate (TDD §13 M2: "All six §12
invariants green in CI. Hard gate: no M3 work until they pass") and the §14 sync-bug
mitigation ("§12 simulation suite as CI gate before features").

This ticket scaffolds the property-based convergence suite as a **skeleton**: a
real simulated-client harness driving real HTTP against the in-process ASGI app +
testcontainer Postgres, a **§12-subset** of four invariants asserted every run, a
hypothesis op-generation strategy, a mutation/teeth test proving the suite bites,
and a dedicated CI step. It is **not** the full M2 suite — pending-settling and
rebuild-equivalence (invariants 5 & 6) are documented seams, not code here.

**Do NOT implement — this is the plan.**

---

## Clarification / goal restatement

Build `server/tests/simulation/` — a property-based suite where N (2–4) simulated
clients, plus one adversary, run randomized op sequences against **one real server**
(in-process ASGI app on a committing Postgres session), then flush and catch up, and
four invariants are asserted after every hypothesis example. The simulated client is
a **library object wrapping `httpx.AsyncClient`** (NOT an `msgctl` subprocess), whose
state model mirrors what the real M2 web client will do: **cursors are truth, the
outbox is a dumb idempotent retry loop.** The suite is the first draft of the artifact
that gates M2, so its client state model and invariant shapes must be right now — M2
extends it, it does not rewrite it.

Areas that change: `server/tests/simulation/` (new package), `server/tests/` (only
if a shared fixture is promoted — avoid), `.github/workflows/ci.yml` (one new named
step). No product-source changes — the sim exercises the merged endpoints as-is.

---

## Explore findings (what this builds on)

- **Harness (`server/tests/harness.py`)** — session-scoped `postgres:17` container,
  real Alembic migrations once, rollback-per-test isolation via savepoint mode, and
  the in-process `client` fixture (`ASGITransport` + `AsyncClient`). But: the shared
  `client`/`db_session` route **every request through one rollback-bound session**,
  so they **cannot** exercise true concurrency (streams-row lock, unique-index race).
- **`committing_app(settings)` + `truncate_auth_tables(engine)` (authutil.py)** — the
  exact tool the sim needs: a throwaway app on its own engine where every request gets
  a fresh independently-committing session, and a truncate for cleanup. **The sim MUST
  use `committing_app`, not the shared `client` fixture** — it needs real commits (so
  a second client's pull sees another's uploads) and real concurrency (gather-bursts).
  `test_events_batch_concurrency.py` is the precedent: `committing_app` +
  `asyncio.gather` + `truncate_auth_tables` in a `finally`.
- **Auth shape** — `/v1/setup`, `/v1/auth/login`, `/v1/auth/accept-invite` all return
  `LoginResponse` = `{token, user_id, device_id, workspace_id}`. That is exactly the
  `Auth` dict (`eventsutil.py`) the body-builders already consume — the sim's client
  holds one of these.
- **Invite flow (authutil.py)** — `create_invite(client, owner_token, role=...)` →
  `join_token(resp.json()["join_url"])` → `accept_invite(client, raw, email=, ...)`.
  Gives N member clients + 1 adversary (all workspace members).
- **Channel creation (eventsutil.py `bootstrap_channel`, `channel_created_body`)** —
  uploads a `channel.created` genesis via the real `POST /v1/events/batch`. §2.2
  homing: **public** genesis homed in `workspace-meta` (needs owner/admin — meta write
  is role-based); **private** genesis self-homed in the channel's own stream. The
  reducer bootstraps the `streams` row + `stream_members`. This is the "drive via the
  real upload endpoint" path the ticket wants — the sim exercises the real accept path.
- **Upload (`events_upload.py`)** — idempotency by `UNIQUE(workspace_id, event_id)`;
  a re-upload returns the **original** `accepted[]` record (same sequence), never a
  dup, never an error. Per-event SAVEPOINT + per-event commit. This is precisely what
  the outbox-retry invariant exercises.
- **Pull/sync (`events_read.py`, `sync.py`)** — `GET /v1/sync` → every readable stream
  + `head_seq` (unreadable streams simply **absent** — the adversary's private channel
  never appears). `GET /v1/events?stream_id=&after=N&limit=` → forward catch-up,
  ascending page, `has_more`. Private stream the caller can't read → **404** (existence
  not disclosed). Wire event = `{body, event_hash, signature, server:{server_sequence,
  server_received_at, payload_redacted}}`, `body` verbatim so
  `hash_event(body)==event_hash` for every event — the byte-equality anchor.
- **Mutation-check precedent (ENG-61 `test_equivalence_gate.py`)** — `monkeypatch.setitem`
  a handler for one side only, assert the property test detects divergence, then
  `monkeypatch.undo()`; a clean positive control confirms no false positive. ENG-71
  mirrors the shape against a **server insert seam**.
- **`insert_event` (`events/insert.py`)** — the sequence-assignment + row-insert
  primitive. Its atomic `UPDATE streams SET head_seq=head_seq+1 ... RETURNING` is the
  gaplessness guarantee; the upload router's `UNIQUE`-catch is the idempotency
  guarantee. Both are clean monkeypatch seams for the teeth test (see §5).

---

## COORDINATION (ENG-68/69/70 parallel)

ENG-71 **owns** `server/tests/simulation/`, its tests, and its CI wiring. Disjoint
from ENG-68 (`ws/`), ENG-69 (`projections/`), ENG-70 (`cli/`) by directory.

**ci.yml collision — FLAGGED and RULED.** ENG-69 also touches `ci.yml` (it extends the
equivalence-gate CI step for its projection rebuild-equivalence). Both edits to one
file → merge collision risk. **Ruling:** ENG-71 does **NOT** touch the equivalence-gate
step. ENG-71 adds its **own dedicated named step** `"Simulation suite"`, appended after
the existing `Pytest` step in the `checks` job. This means:
- ENG-69 edits the `Equivalence gate` step; ENG-71 appends a new `Simulation suite`
  step. Different YAML blocks → **no line collision** in the common case.
- If both land append-only near the end of the same job, whichever merges second
  rebases its one added block. Trivial, no semantic conflict.
- **Do not** fold the sim into the existing `Pytest` step (it must be independently
  visible, separately timed, and derandomized-profiled). **Do not** extend the
  equivalence-gate step (that's ENG-69's, and the sim is not a rebuild-equivalence
  check at M1).

No shared fixture edits: the sim builds on the **already-exported** `committing_app` /
`truncate_auth_tables` / `settings` / `migrated_db` — none of which ENG-68/69/70 touch.
If the sim needs a helper, it lives in `server/tests/simulation/`, not in the shared
`authutil.py`/`eventsutil.py` (avoids cross-ticket edits to shared test infra).

---

## Design rulings

### 1. Simulated-client harness — state model (`simulation/client.py`)

A library object `SimClient` wrapping **one** `httpx.AsyncClient` (the committing
app's client, shared across all SimClients so they hit the same in-process server /
same Postgres). **Not** an `msgctl` subprocess. State it holds:

| Field | Meaning |
|---|---|
| `auth: Auth` | `{token, user_id, device_id, workspace_id}` from a real `/v1/setup` (owner) or `accept-invite` (members/adversary). The session token is real. |
| `cursors: dict[stream_id, int]` | **the source of truth** — per-stream last-contiguous `server_sequence` pulled. Starts at 0. Advanced only by `catchup_pull`. |
| `pulled: dict[stream_id, list[wire_event]]` | the client's local materialized log per stream (what it has pulled), in ascending sequence. The convergence/cursor invariants read this. |
| `outbox: list[wire_item]` | un-acked `{body, event_hash}` items. A **dumb retry loop** — `flush()` re-POSTs the whole outbox; idempotency (server-side `UNIQUE(event_id)`) makes re-sends safe; an item leaves the outbox only when the server returns it in `accepted[]`. |
| `connected: bool` | disconnect simulation flag (see below). |

Methods (all `async`):
- `send(stream_id, text=...)` — build a `message.created` body via
  `eventsutil.message_body(auth=self.auth, stream_id=...)`, wrap with
  `eventsutil.wire_item`, **append to `outbox`** (does not hit the network — mirrors
  the real client enqueuing to its outbox). The `event_id` is minted **once** here and
  is stable across retries (that's what makes idempotency real).
- `flush()` — POST `outbox` to `/v1/events/batch` (via `eventsutil.post_batch`). On a
  200, move every item whose `event_id` appears in `accepted[]` out of the outbox. On
  a simulated disconnect **mid-flush**, the request may or may not have committed
  server-side — the item **stays** in the outbox and is retried next flush (idempotency
  guarantees no dup). Retries are bounded (a small max, e.g. 5) to stay CI-safe.
- `duplicate_send(stream_id)` — re-append the **last already-sent** item (same
  `event_id`) to the outbox, forcing a duplicate upload attempt. Exercises idempotency.
- `catchup_pull(stream_id)` — loop `GET /v1/events?stream_id=&after=cursor&limit=` while
  `has_more`, appending pages to `self.pulled[stream_id]`, advancing `self.cursors`.
  Reconnect catch-up = call this after a disconnect. **A 404 here** (adversary on a
  private stream) is the permission-isolation signal, handled in the adversary path.
- `sync()` — `GET /v1/sync`; returns the readable-stream list. The adversary asserts
  its private channel is **absent**; members discover heads to catch up to.
- `simulate_disconnect()` / `reconnect()` — flip `connected`. A disconnect during a
  flush means: issue the POST but **discard the client's view of the response** (the
  ack never arrives), leaving items in the outbox. Reconnect = `sync()` +
  `catchup_pull` every readable stream (the §3.3 delivery contract: on every reconnect
  run sync + catch-up, trust cursors).

**Rule (state model mirrors M2):** cursors are truth (never derived from push, only
from pull); the outbox is a dumb idempotent retry loop keyed on a stable `event_id`;
the client never trusts anything but a pulled, sequenced event. This is the exact
contract §3.3 pins for the real client, so the M2 web client's SharedWorker/Dexie
outbox is the same object with a different transport. **No WS in the M1 skeleton** —
pull-based only (WS is an ENG-68 seam, §Extension seams).

### 2. The four §12-subset skeleton invariants (`simulation/invariants.py`)

Asserted **every hypothesis run** after all clients flush + catch up. (Full six come
at M2; §12 invariants 5 & 6 are documented seams, not asserted here.)

1. **Idempotency (§12.1):** the server's stored event set per stream has **no duplicate
   `event_id`** (`len(event_ids) == len(set(event_ids))`), and the count of stored
   events equals the count of **distinct** `event_id`s the clients intended to send —
   retried/duplicated uploads created exactly one event each. Read server truth via a
   direct `select(Event)` on a fresh committing session (as the concurrency test does).
2. **Convergence (§12.2, subset):** after every client flushes + catches up, for each
   shared stream: every member client's `pulled[stream]` == server truth == each other,
   **byte-equal envelopes** (`body` dicts equal, `event_hash` equal,
   `server_sequence` equal) and **gapless** (`[e.server_sequence] == range(1, n+1)`).
   *Subset note:* M1 compares **pulled event sets**, not rebuilt projections — the
   projection-equivalence half is invariant 6, deferred to M2 (seam below).
3. **Cursor integrity (§12.3):** after arbitrary disconnect/reconnect/missed events,
   each client's per-stream `pulled` sequence is **gapless and duplicate-free**
   (strictly ascending contiguous `server_sequence`, no repeats) — the reconnect
   catch-up recovered exactly the missed tail, no gap, no double-apply.
4. **Permission isolation (§12.4) — ACCEPTANCE CRITERION, asserted EVERY run, not a
   separate test:** the adversary (workspace member, **non-member of the private
   channel**) observes **ZERO** private-stream data. Concretely, every run:
   (a) the private stream is **absent** from the adversary's `GET /v1/sync`;
   (b) `GET /v1/events?stream_id=<private>` for the adversary returns **404** (not 403 —
   existence not disclosed, §3.6.2); (c) the adversary's `pulled` contains no event
   whose `stream_id` is the private channel. This runs inside the invariant block on
   every example, exactly as §12 mandates ("asserted by a dedicated adversary client in
   every simulation run").

Each invariant is a small pure-ish `assert_*` function taking (clients, server-truth
snapshot, stream ids); the run harness calls all four at the end of every example.

### 3. Hypothesis strategy + concurrency model (`simulation/strategies.py`)

- **N clients:** `st.integers(2, 4)` member clients + 1 adversary (fixed).
- **Streams:** one shared **public** channel (all members write/read) + one **private**
  channel (a subset of members are members; the adversary is excluded).
- **Op sequence:** `st.lists(op_strategy, min_size, max_size)` of a small op union:
  `send(client, stream)`, `duplicate_send(client, stream)`, `disconnect_mid_flush(client)`,
  `reconnect_catchup(client)`, `concurrent_send_burst(clients, stream)`. Op params
  (which client, which stream, message text) drawn from bounded strategies.
- **Interleaving / concurrency model — RULED:** **randomized-sequential op application
  with occasional gather-bursts.** The default driver applies ops **one at a time** in
  the hypothesis-drawn order against the single in-process server — this gives
  *randomized interleaving of client actions* while staying **deterministic and
  CI-reproducible** (no wall-clock races). For the **one** invariant that genuinely
  needs true concurrency — gaplessness/idempotency under a real streams-row-lock race —
  a `concurrent_send_burst` op issues K sends to the **same** stream via
  `asyncio.gather` on the committing sessions (the `test_events_batch_concurrency.py`
  pattern). So: sequential-randomized is the backbone (determinism); gather-bursts are
  the targeted true-concurrency probe. **CI profile derandomizes** (fixed seed, bounded
  `max_examples`) so a red run is reproducible.
- **Why not fully async-concurrent every op:** true `gather` on *every* op makes the
  server's per-stream serialization the only ordering source and makes failures
  irreproducible in CI. The design contract is "cursors are truth regardless of
  interleave," which sequential-randomized-with-bursts exercises without flake.
- **Hypothesis profiles** (register in `simulation/conftest.py` or the suite module):
  `ci` = `derandomize=True`, `max_examples` bounded (~25–40), `deadline=None` (container
  IO), suppress `too_slow`; `dev` = more examples, non-derandomized. Select `ci` when
  `CI` env is set (the harness already threads `CI: "true"`).

### 4. Stream setup (`simulation/setup.py`)

- **Workspace + clients:** `/v1/setup` (owner/admin) → `create_invite` × (N members +
  1 adversary) → `accept_invite` each → wrap each `LoginResponse` in a `SimClient`. All
  are workspace members; the adversary is simply **not added to the private channel**.
- **Public channel:** owner uploads a `channel.created` (visibility `public`) homed in
  `workspace-meta` (needs the admin/owner — meta write is role-based) via the real
  `POST /v1/events/batch` — reuse `eventsutil.bootstrap_channel(..., visibility="public")`.
- **Private channel:** owner uploads a `channel.created` (visibility `private`),
  self-homed in the channel's own stream; add the chosen member subset via
  `channel.member_added` lifecycle events (`eventsutil.lifecycle_body`) — **excluding
  the adversary**. **RULED: drive channel creation + membership through the real upload
  endpoint** (not a direct `insert_event`/reducer DB seed) so the sim exercises the
  **real accept + reducer + membership** path end-to-end — the whole point of an
  acceptance harness. Direct DB seed would bypass exactly the permission-bootstrap code
  the adversary invariant is meant to prove.
- *Open item to confirm at implementation:* whether M1's merged reducer supports
  `channel.member_added` for a private channel (vs. only genesis membership). If member
  management events are not yet reducible in M1, fall back to creating the private
  channel with its member set expressed at genesis (whatever the merged reducer
  accepts) — still via the real endpoint. **python-engineer verifies against
  `events/reducers.py` before writing setup.py**; the adversary-exclusion property must
  hold either way.

### 5. Mutation / teeth check (`simulation/test_mutation.py`) — ACCEPTANCE CRITERION

Prove the suite has teeth: inject a **server** bug and assert the suite **FAILS**.
Mirror ENG-61's one-sided `monkeypatch` + `undo` + positive-control shape, but against
a **server insert seam** (ENG-61 patched a projection handler; ENG-71 patches the
server write path):

- **Injection mechanism — RULED (one-sided monkeypatch of a server seam):** in one
  dedicated test, `monkeypatch` a single write-path function to introduce a specific
  defect, run **one** simulation example, assert an invariant fails, then `undo`.
  Two candidate seams (pick the cleaner at implementation; both are real bugs a
  regression could reintroduce):
  1. **Drop idempotency** — patch the upload router's `UNIQUE`-catch recovery (or make
     `_fetch_original`/the constraint-name check misbehave) so a re-upload inserts a
     **second** row instead of re-accepting → **invariant 1 (idempotency) fails** (dup
     `event_id`). The `duplicate_send` op guarantees the code path is hit.
  2. **Skip the head_seq lock / gaplessness** — patch `insert_event`'s sequence
     assignment (e.g. a non-atomic read-then-write, or a fixed/duplicated sequence) so
     concurrent sends collide → **invariant 2 (convergence/gaplessness) fails**.
  **Lean: candidate 1 (idempotency drop)** — smaller blast radius, deterministic
  (needs no gather-burst), directly ties the teeth test to the outbox-retry story the
  suite is built around.
- **Positive control:** the same example with **no** patch passes all four invariants
  (guards against a false-positive teeth test that would "pass" for the wrong reason) —
  exactly ENG-61's clean-control discipline.
- The teeth test lives in `simulation/` beside the suite so the gate and its
  teeth-check are never separated (ENG-61 precedent).

### 6. CI (`.github/workflows/ci.yml`)

- **Dedicated named step `"Simulation suite"`** in the existing `checks` job, appended
  **after** the `Pytest` step (so the container image is already warmed by `Pre-pull
  Postgres image`; the sim reuses the same testcontainer machinery). Command:
  `uv run pytest server/tests/simulation -q` with `env: CI: "true"` (selects the
  derandomized hypothesis profile). Part of the **required** `checks` job (not a
  separate optional job) — it is (the skeleton of) the M2 gate.
- **Sized <2 min:** bounded `max_examples` (~25–40), `derandomize=True`,
  `deadline=None`. If it trends over budget, cut `max_examples` before op variety.
- **Collision rule:** see COORDINATION — separate named step from ENG-69's
  equivalence-gate extension; second-to-merge rebases its single appended block.
- **devops-engineer** applies the ci.yml step (>1 line YAML); **python-engineer**
  owns everything under `server/tests/simulation/`.

---

## File list

| File | Action | Agent |
|---|---|---|
| `server/tests/simulation/__init__.py` | create — package marker | python-engineer |
| `server/tests/simulation/client.py` | create — `SimClient` (state model §1: auth/cursors/pulled/outbox; send/flush/duplicate_send/catchup_pull/sync/disconnect/reconnect) | python-engineer |
| `server/tests/simulation/setup.py` | create — workspace + N members + adversary + public/private channel bootstrap via real endpoints (§4) | python-engineer |
| `server/tests/simulation/strategies.py` | create — hypothesis op union + N + interleave model (§3); ci/dev profile registration | python-engineer |
| `server/tests/simulation/invariants.py` | create — the four `assert_*` (§2): idempotency, convergence, cursor-integrity, permission-isolation | python-engineer |
| `server/tests/simulation/runner.py` | create — apply an op sequence (sequential-randomized + gather-bursts), then flush-all + catchup-all + assert all four | python-engineer |
| `server/tests/simulation/test_simulation.py` | create — the `@given(op sequence)` property test wiring runner + committing_app + truncate cleanup; documents M2 seams in the module docstring | python-engineer |
| `server/tests/simulation/test_mutation.py` | create — the teeth test (§5): one-sided monkeypatch + positive control | python-engineer |
| `.github/workflows/ci.yml` | edit — append one `"Simulation suite"` named step to `checks` (§6) | devops-engineer |

*(Package split rationale: client/setup/strategies/invariants/runner separated so M2
extends each seam independently — more op types → strategies.py, invariants 5&6 →
invariants.py, WS transport → client.py — without a monolith rewrite.)*

Confirm `server/tests/simulation/` is not excluded from the mypy strict gate (harness.py
notes the conftest-name exclusion only) — the sim modules must stay type-checked.

---

## Step-by-step

1. **python-engineer:** scaffold the package; write `SimClient` (§1) reusing
   `eventsutil.message_body`/`wire_item`/`post_batch` and `authutil.auth_header`.
   Build against `committing_app(settings)` (one shared client, real commits), with a
   `truncate_auth_tables` cleanup in a `finally` — mirror `test_events_batch_concurrency.py`.
2. **python-engineer:** write `setup.py` — verify against `events/reducers.py` which
   membership events M1 supports; build public + private channels via the real endpoint
   with the adversary excluded from the private one.
3. **python-engineer:** write `strategies.py` (op union, N, ci/dev profiles) and
   `runner.py` (sequential-randomized application + `concurrent_send_burst` gather;
   then flush-all + catchup-all).
4. **python-engineer:** write `invariants.py` (the four asserts) and
   `test_simulation.py` (`@given`, CI profile via `settings(...)`); read server truth
   through a fresh committing session `select(Event)`.
5. **python-engineer:** write `test_mutation.py` — one-sided monkeypatch (lean:
   idempotency drop) + positive control (§5).
6. **devops-engineer:** append the `"Simulation suite"` step to `ci.yml` `checks` job
   (§6). Rebase the one block if ENG-69 merged first.
7. Run locally: `uv run pytest server/tests/simulation -q` (Docker present) and confirm
   green + <2 min under the ci profile; `uv run mypy` clean.

## Test plan (the test plan **is** the ticket)

- `test_simulation.py::test_convergence_property` — the four invariants asserted every
  hypothesis example over randomized op sequences (ci profile derandomized).
- `test_mutation.py::test_suite_detects_idempotency_regression` — teeth: one-sided
  server monkeypatch → invariant fails; plus a clean positive control that passes.
- Permission isolation is **not** a separate test — it is invariant 4, asserted every
  run (per §12's "every simulation run" language).
- Green under `CI=true` (derandomized, bounded max_examples), <2 min.

## Risks / open questions

- **R1 — Membership-event support in M1 reducer.** If `channel.member_added` isn't
  reducible yet, express the private channel's member set at genesis via the real
  endpoint (§4 open item). python-engineer confirms against `events/reducers.py` first;
  the adversary-exclusion property holds either way. **Blocking check before setup.py.**
- **R2 — Committing-session cleanup / cross-test leakage.** The sim commits real rows
  (like the concurrency tests), so it MUST `truncate_auth_tables` in a `finally` and
  MUST start from a truncated server, or rows leak into other integration tests.
  Follow the concurrency-test lifecycle exactly.
- **R3 — CI time budget under hypothesis.** Each example does real HTTP + DB commits;
  `max_examples` × ops must stay <2 min. Mitigate: bounded `max_examples`,
  `deadline=None`, `derandomize`. Tune examples down before adding op variety.
- **R4 — Disconnect-mid-flush realism vs. determinism.** "Discard the ack" is a
  client-view simulation, not a real socket cut (the in-process ASGI request still
  runs to completion server-side). That is the correct model for M1: it proves the
  outbox+cursor recovery handles a lost ack, which idempotency makes safe. A true
  transport cut is an M2/ENG-68 (WS) concern — documented, not built here.
- **R5 — ci.yml merge order with ENG-69.** Mitigated by the separate-named-step ruling
  (COORDINATION); the second-merging ticket rebases its one appended block.
- **R6 — mypy strict coverage.** Ensure `simulation/` is under the strict gate (not
  excluded like the conftest shim); type the `SimClient` state explicitly.

## M2 extension seams (documented, NOT built here)

- **Invariant 5 — Pending settling:** optimistic-message ordering asserted at the
  projection layer. Seam: `invariants.py` gains `assert_pending_settling`; needs the
  client-side projection (Dexie/`messages_proj`) that lands with the M2 web client.
- **Invariant 6 — Rebuild equivalence:** drop projections + replay == incremental,
  client and server both. Seam: convergence (invariant 2) today compares **pulled event
  sets**; M2 adds a rebuilt-projection comparison alongside it. This is where the §12
  "byte-identical to a fresh rebuild-from-pull" clause gets teeth.
- **Full six:** the M1 skeleton asserts 1–4; M2 flips the gate to all six (TDD §13 M2
  hard gate).
- **More op types:** edits, reactions, membership changes, DMs (§12's full op list);
  add to `strategies.py`'s op union — the runner/invariant split is designed for it.
- **WebSocket push into the sim (ENG-68):** once `ws/` lands, `SimClient` gains a WS
  transport that receives `{"t":"event",...}` frames and applies the §3.3 delivery
  contract (frame is a hint; `server_sequence != cursor+1` triggers a pull). The M1
  skeleton is **pull-based only** — WS is an added transport on the same cursor-truth
  state model, not a rewrite. Note: ENG-68's WS fanout is itself a permission-isolation
  surface (§12.4 lists "WS fanout") — the adversary invariant extends to assert zero
  private frames once WS is wired.
