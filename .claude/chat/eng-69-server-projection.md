# ENG-69 — M1: Server-side `messages_proj` — incremental apply + rebuild-projections + gate extension

**Tech lead planning doc.** Milestone M1 (§13). Do NOT implement from this file alone — it is the contract the implementers work against. All inter-agent coordination lives here.

## Goal (restated)

Give the server the same **rebuild ≡ incremental** projection guarantee the M0 CLI already has (ENG-58/59/61), but against Postgres instead of SQLite:

1. **Incremental apply** — every accepted `message.created` v1 materializes a `messages_proj` row **inside the accept transaction**, so a projection failure rolls back the event insert.
2. **`msgctl rebuild-projections`** — TRUNCATE `messages_proj` + replay `events`, atomic under Postgres MVCC, safe to interrupt.
3. **Deterministic dump** — a server-side `dump_messages_proj` mirroring ENG-58's compact-JSON discipline.
4. **Equivalence-gate extension** — a new server-side property gate (hypothesis + testcontainer PG) + its own named CI step; the M0 CLI gate stays untouched.

`messages_proj` (columns + GENERATED `search_tsv` + GIN index) and the Alembic migration **already exist** on main (§4.2, ENG-63/models.py:180, migration 0001). This ticket writes only the apply/rebuild/dump code + gate; it adds **no** migration.

## What already exists (read before starting)

- `server/msgd/events/insert.py` — `insert_event(db, *, stream_id, body)`: hashes body, bumps `head_seq` (row-locked `UPDATE … RETURNING`), inserts the `events` row (`db.flush()`), returns the `Envelope`. **No commit** — runs in the caller's txn. **This is where the projection hook goes** (step 3b, below).
- `server/msgd/events/emit.py` — `emit_event` = `apply_reducer` THEN `insert_event`, one txn. All accepted events (meta + message) flow through here.
- `server/msgd/api/routers/events_upload.py` — the accept path: per-event `async with db.begin_nested()` (SAVEPOINT) around `emit_event`, then `await db.commit()`. Catches `IntegrityError` (idempotency), `UnknownStreamError`, `DBAPIError` (class-22 storability). Anything else propagates → 500.
- `server/msgd/events/reducers.py` — the `(type → reducer)` registry precedent; `message.created` has **no reducer**. Our apply dispatch mirrors this shape but is keyed `(type, type_version)`.
- `cli/msgctl/projection.py` / `rebuild.py` / `cli/tests/test_equivalence_gate.py` — the M0 SQLite precedents this ticket mirrors against Postgres (`_HANDLERS[(type,version)]`, `dump_messages`, temp-swap rebuild, the property gate + mutation teeth + smoke).
- `server/tests/harness.py` — session-scoped `postgres:17` testcontainer, `run_migrations()` schema, per-test outer-txn rollback with `join_transaction_mode="create_savepoint"` (handler commits land on savepoints). Fixture-presence auto-marks `integration`.
- `.github/workflows/ci.yml` — the named step `Equivalence gate (rebuild ≡ incremental)` runs the CLI gate file; a later `Pytest` step runs the whole suite (so the CLI gate already runs twice — redundancy-with-a-named-guardrail is the accepted precedent).

## Coordination / collision check (confirmed collision-free)

ENG-68/70/71 run in parallel. ENG-69 owns `server/msgd/projections/` (new package — no collision), the `msgctl rebuild-projections` subcommand, and the server gate. The one cross-cut is **editing `insert.py`** to add the projection hook:

- ENG-66's just-merged files (`events_upload.py`, `validate.py`) are **not** touched.
- `insert.py` is ENG-65's; **no in-flight ticket touches it** — ENG-68 → `fanout.py`, ENG-70 → `cli/`, ENG-71 → `tests/`.

**RULING:** ENG-69 MAY edit `insert.py`. That is the natural home for the hook (the accept transaction lives there; the projection applies to `messages_proj` after the `events` insert, same txn — §4.2 accept-path line). Keep the edit **minimal** (one import + one `await` call + a docstring line) so any future ENG-66 hotfix rebases cleanly, and cover it with focused tests.

---

## Implementation Plan

### Ruling 1 — Apply hook: location and dispatch

**Location.** Inside `insert_event`, a new **step 3b** between the `events` insert (`db.flush()`) and the `return Envelope(...)`. It runs in the caller's transaction (no commit), so it is inside both the per-event SAVEPOINT and the per-event commit that `events_upload.py` wraps `emit_event` in. This satisfies the §4.2 accept-path ordering *(insert into `events` → apply to `messages_proj` → commit)* and the acceptance criterion *(projection failure rolls back the event insert)*.

```python
# insert.py, after `await db.flush()` (step 3), before building the Envelope:
from msgd.projections.apply import apply_projection   # module-level import
...
await apply_projection(db, body=body, server_sequence=server_sequence)
```

**Dispatch.** All event types flow through `insert_event`; only `message.created` v1 writes a row. Mirror M0's `_HANDLERS` and reducers.py's registry — keyed `(type, type_version)`:

```python
# projections/apply.py
PROJECTION_VERSION = 1                      # every projection declares its version (D-invariant)
_HANDLERS = {("message.created", 1): _apply_message_created}

async def apply_projection(db, *, body, server_sequence):
    handler = _HANDLERS.get((body["type"], body["type_version"]))
    if handler is None:
        return                              # D9: unknown type / message.created v>=2 / all meta → skip, never crash
    await handler(db, body=body, server_sequence=server_sequence)
```

`_apply_message_created` validates the payload through `MessageCreatedV1` (defence-in-depth; ENG-66 already validated it pre-accept) and `INSERT`s one `messages_proj` row:

- `message_id`, `stream_id` (= `body["stream_id"]`), `thread_root_id` (payload, nullable), `author_user_id`, `text`, `created_seq` = `server_sequence`.
- The rest **default**: `edited_seq`/`last_reply_seq` NULL, `deleted` FALSE, `reply_count` 0 (edits/deletes/thread counters are **M3** — columns exist, no reducer now).
- `search_tsv` is GENERATED — never written (models.py comment).
- Use `INSERT … ON CONFLICT (message_id) DO NOTHING` so a rebuild replay is idempotent per `message_id` (message.created is immutable in M1 — mirrors M0's `INSERT OR IGNORE`). This makes incremental apply and replay agree on re-seen ids.

**No behavioural change for meta / setup callers.** `workspace.created`, `channel.created`, `user.joined`, etc. dispatch to the no-op branch; the ENG-65 `/v1/setup` and `/v1/auth/accept-invite` callers emit no `message.created`, so they create zero projection rows. Confirmed safe.

### Ruling 2 — `rebuild_projections`: the Postgres mechanic

M0 used a temp SQLite file + `os.replace` atomic swap because a SQLite DB is a file. Postgres cannot `os.replace` a table, so the atomicity primitive changes from *rename* to *transaction/MVCC*.

**RULING: single-transaction `TRUNCATE messages_proj` + replay, committed once.**

```python
# projections/rebuild.py
async def rebuild_projections(session):
    await session.execute(text("TRUNCATE messages_proj"))
    # replay every event in a fixed order, re-using the SAME apply_projection
    async for body, server_sequence in _iter_events(session):   # ORDER BY stream_id, server_sequence
        await apply_projection(session, body=body, server_sequence=server_sequence)
    await session.commit()
```

Why this over build-into-temp-table + rename:

- **Atomic by MVCC** — until the single `COMMIT`, concurrent readers see the pre-rebuild snapshot; after commit they see the fully-rebuilt state. Never a partial projection. This is the Postgres analogue of ENG-59's "interrupted rebuild leaves the previous projection intact."
- **Safe to interrupt** — an exception / kill before `COMMIT` rolls the whole txn back; `messages_proj` is untouched. (Mirrors ENG-59's guarantee, delivered by the txn boundary instead of `os.replace`.)
- **Simpler** than a temp-table swap, which would have to recreate the GENERATED `search_tsv` column + GIN index on the temp table and match index names for `ALTER … RENAME`. Rebuild is a rare admin op that can hold a transaction, so paying that complexity buys nothing.

**Replay uses the exact same `apply_projection`** the incremental path uses — this single-source-of-apply is *what makes rebuild ≡ incremental true by construction* (M0 rebuild reused `project`; we reuse `apply_projection`). Replay order `(stream_id, server_sequence)` is fixed for reproducibility; final state is order-independent (immutable `message_id`, `ON CONFLICT DO NOTHING`) but a deterministic order keeps a run reproducible.

`_iter_events` streams `body` + `server_sequence` from `events` (use `.stream()` / `yield_per` so a large log is not fully materialized).

**Documented M1 property (note in the docstring):** `TRUNCATE` takes an `ACCESS EXCLUSIVE` lock, briefly blocking concurrent reads of `messages_proj` for the rebuild's duration. Acceptable for a single-operator admin op at M1 scale. If read-during-rebuild concurrency ever matters, `DELETE FROM messages_proj` (ROW-EXCLUSIVE, MVCC-invisible to other snapshots until commit) is the drop-in alternative — noted, not chosen now.

### Ruling 3 — `dump_messages_proj`: the deterministic equivalence surface

Mirror ENG-58 `dump_messages` discipline exactly: fixed explicit column list (never `SELECT *`), one compact JSON object per row (`json.dumps(..., ensure_ascii=False, separators=(",", ":"))`), `\n`-joined, deterministic `ORDER BY`.

**RULING — dump columns (M1-relevant subset that the apply actually writes):**

```
message_id, stream_id, thread_root_id, author_user_id, text, created_seq
```

- **Exclude** the M3-null columns (`edited_seq`, `deleted`, `reply_count`, `last_reply_seq`): they are constant defaults at M1, so they'd be trivially equal on both sides — they prove nothing about the apply logic and would couple the gate to M3 defaults. **Exclude** `search_tsv` (GENERATED — a pure function of `text`, not part of the equivalence surface). Note in the docstring: when M3 reducers land (edits/deletes/thread counters), extend the dump to cover those columns.
- `messages_proj` has **no `format` column** (§4.2 drops it — a deliberate schema difference from M0's SQLite `messages` table), so, unlike M0's dump, `format` is not dumped. Do not add it.
- **Order:** `ORDER BY stream_id, created_seq, message_id`. `(stream_id, created_seq)` is already unique (per-stream `server_sequence` is unique), `message_id` is a bulletproof final tie-break. Total, stable order → byte-identical dumps for identical logs.

Place `dump_messages_proj(session) -> str` in `server/msgd/projections/dump.py` (reusable by the M2 simulation suite's invariant 6, not just this gate).

### Ruling 4 — Equivalence-gate extension + CI wiring

**New file: `server/tests/test_equivalence_gate_server.py`** — the Postgres analogue of `cli/tests/test_equivalence_gate.py`. Header comment: "PERMANENT GATE — server side of rebuild ≡ incremental (§12 invariant 6); never delete." Needs the container → auto-marked `integration` by the harness fixture hook.

Three parts, mirroring ENG-61:

1. **Property test — rebuild ≡ incremental + D9 skip.** Hypothesis strategy (copy ENG-61's `_send_plan`): 1–4 streams, 0–30 interleaved actions, ~90% `message.created` v1 / ~10% unknown-type (`widget.exploded` v7), UTF-8 text via `st.characters(codec="utf-8")` (excludes lone surrogates), `thread_root_id` sometimes set.
   - **Drive incremental via `insert_event` directly** (server-trusted bodies built with `build_message_created_body` + `hash_event`, exactly as ENG-61 drives `append_event`). **RULING:** use `insert_event`, not the HTTP upload path, for the property loop — it (a) exercises the exact hook, (b) skips the per-example auth/stream-bootstrap overhead of `POST /v1/events/batch`, (c) mirrors ENG-61's in-process discipline. Bootstrap each stream's `streams` row first (a helper `INSERT … ON CONFLICT DO NOTHING`, since `insert_event` locks the row).
   - `dump_incremental = dump_messages_proj(session)` → `rebuild_projections(session)` → `dump_rebuilt = dump_messages_proj(session)` → **assert byte-equal**.
   - **D9 assertion:** `messages_proj` row count == number of `message.created` actions; no row corresponds to an unknown-type event (unknown types leave zero projection rows).
   - **Rebuild idempotence:** `rebuild_projections` twice; dumps equal.
2. **Mutation / teeth test.** Positive control first (unpatched rebuild matches incremental). Then monkeypatch the `("message.created", 1)` handler **for the rebuild pass only** to corrupt exactly one row (append `"X"` to one `text`), assert `dump_corrupt != dump_incremental`. Patch **one side only** (ENG-61's discipline: a global patch corrupts both sides identically and proves nothing).
3. **Real-upload smoke (non-property integration).** The analogue of ENG-61's subprocess smoke: build auth + a channel (reuse `server/tests/authutil.py` / `eventsutil.py` helpers), `POST /v1/events/batch` a small batch through the `client` fixture, assert the projection rows landed, `rebuild_projections`, dump equal, and an uploaded unknown-type event produced no row. Proves the `insert.py` hook actually fires on the true accept path end-to-end.

**Per-example state reset (the single easiest thing to get wrong — flag loudly).** The container is session-scoped and the outer-txn rollback isolates per *test*, not per hypothesis *example*. This is the server analogue of ENG-61's "fresh dir per example, NOT the `tmp_path` fixture." Options, in preference order:
   - Have the property test take the session-scoped **engine/`database_url`**, and inside the `@given` body open a short-lived session and `TRUNCATE messages_proj, events, stream_members, streams CASCADE` (or `DELETE`) at the **start of every example** → hermetic per example, and it sidesteps the `function_scoped_fixture` HealthCheck entirely (no per-test fixture consumed inside `@given`).
   - If instead reusing the `db_session` fixture, add `@settings(suppress_health_check=[HealthCheck.function_scoped_fixture])` and truncate per example — acceptable but less clean.
   Async + hypothesis: drive each example through `asyncio.run(_one_example(...))` (hypothesis body stays sync, like ENG-61). Determinism profiles: register `ci` (`derandomize=True`, `database=None`, `deadline=None`, `max_examples≈40–60` — smaller than the CLI's 60 since each example does real PG round-trips + a truncate) and a random `dev` profile, gated on the `CI` env var, exactly as ENG-61 does.

**CI wiring — RULING: a second named step, CLI gate step untouched.**

Add to `.github/workflows/ci.yml`, **after** `Pre-pull Postgres image` (so the `postgres:17` image is warm for the testcontainer) and before the full `Pytest` step:

```yaml
      # permanent M1 exit gate, never remove (TDD §5, §12 invariant 6, server side)
      - name: Equivalence gate (server · rebuild ≡ incremental)
        run: uv run pytest server/tests/test_equivalence_gate_server.py -q
        env:
          CI: "true"
```

Why a sibling step, not folding into the existing one:
- The CLI gate step is **Docker-free** and lives early in the fast lint/type/test lane; the server gate **needs the Postgres container**, so it must run after the pre-pull. Different prerequisites → different steps.
- Two named steps keep failures legible: "CLI gate red" vs "server gate red" are different diagnoses.
- The M0 CLI gate step stays **byte-for-byte untouched** (explicit requirement).
- Redundancy with the final full `Pytest` step is fine — the CLI gate already has exactly this redundancy; the named step is the *visible permanent guardrail*.

### Ruling 5 — `msgctl rebuild-projections` and the module boundary

**RULING:** the command is `msgctl rebuild-projections` (matches the exact §4.2 command name and the TDD's "CI runs it" line). It is a **thin adapter**; all DB-touching logic stays in `server/msgd/projections/rebuild.py`. `cli/` already depends on `msgd` via the uv workspace and `cli/msgctl/cli.py` already imports `msgd.core`, so importing `msgd.projections` is a sanctioned edge ("cli imports msgd, so it can use the server's projection module").

`cmd_rebuild_projections`:
- Reads the DB URL from env — `MSG_DATABASE_URL` (the same var `msgd.settings` / the compose file / `env.py` use).
- **Lazy-imports** `msgd.projections.rebuild` and the async engine **inside the handler** (not at module top) so the M0 commands (`init`/`send`/`project`/`rebuild`/`verify`) keep their light, async-DB-free import cost and stay decoupled.
- Builds an async engine + session from the URL (reuse `msgd.db.engine.create_engine` / `create_sessionmaker`), `asyncio.run`s `rebuild_projections(session)`, disposes the engine, prints a JSON summary (`{"rebuilt": true, "applied": N, "skipped": M}`), returns 0. `rebuild_projections` should return a small result (applied/skipped counts) for the summary — mirror `ProjectResult`.

Note the naming: M0 already has a `msgctl rebuild` (SQLite workspace projection). `rebuild-projections` is the distinct server/Postgres command — different name, no collision.

---

## File list

**Create (`python-engineer`):**
- `server/msgd/projections/__init__.py` — package marker.
- `server/msgd/projections/apply.py` — `PROJECTION_VERSION`, `_HANDLERS`, `_apply_message_created`, `apply_projection(db, *, body, server_sequence)`.
- `server/msgd/projections/rebuild.py` — `rebuild_projections(session)` (TRUNCATE + streamed replay via `apply_projection`) + a small result dataclass; the ACCESS-EXCLUSIVE / interrupt-safety docstring.
- `server/msgd/projections/dump.py` — `dump_messages_proj(session) -> str`.
- `server/tests/test_equivalence_gate_server.py` — property gate + mutation teeth + real-upload smoke (the permanent M1 gate).
- `server/tests/test_projections_apply.py` — focused unit tests for the apply hook (see test plan). *(Optional to fold into the gate file, but a separate unit file keeps the permanent gate lean.)*
- `server/tests/test_rebuild_projections.py` — focused unit tests for rebuild (truncate+replay, rollback-on-interrupt, order independence).

**Modify:**
- `server/msgd/events/insert.py` (`python-engineer`) — add the `apply_projection` import + the step-3b call after `db.flush()`; update the "What it deliberately does NOT do" docstring to record that it now applies to `messages_proj` in the same txn. Minimal.
- `cli/msgctl/cli.py` (`python-engineer`) — add the `rebuild-projections` subparser + `cmd_rebuild_projections` (lazy imports, `MSG_DATABASE_URL`, `asyncio.run`).
- `.github/workflows/ci.yml` (`devops-engineer`) — add the new named server-gate step (content above). ~5 lines.

**No new migration** — `messages_proj` already shipped in `0001_initial_schema.py`. No `cli/pyproject.toml` change — `msgd` is already a workspace dependency.

## Test plan

- **`test_projections_apply.py`** (unit, integration-marked): `message.created` v1 → exactly one row with the right columns; `thread_root_id` preserved (set and null cases); unknown type → no row + no crash (D9); `message.created` v2 → no row (unknown version skip); meta event (e.g. `channel.created`) → no row; re-applying the same `message.created` (ON CONFLICT) inserts no duplicate.
- **Accept-txn failure semantics** (unit, integration-marked — Ruling below): monkeypatch `_apply_message_created` to raise on a valid, ENG-66-validated `message.created`; drive it through `emit_event` inside a savepoint like the router does; assert the `events` row is **absent** afterward (rolled back — event rejected, not stored without its projection) and that `head_seq` did not advance.
- **`test_rebuild_projections.py`** (integration): incremental build then `rebuild_projections` → dumps equal; interrupt safety (inject a raise mid-replay → `messages_proj` unchanged, old rows intact); order independence (two logs, same events different insert interleaving → identical dump).
- **`test_equivalence_gate_server.py`** (integration): the property gate + mutation teeth + real-upload smoke (Ruling 4).
- Full suite green under `uv run pytest`; ruff + mypy clean (repo runs strict mypy over `server/msgd` + `server/tests`).

## Accept-txn failure semantics (Pin 5) — RULING

Can a `message.created` pass ENG-66 validation but fail projection apply? ENG-66 validates the payload via `MessageCreatedV1` **before** accept (validate.py step iv), and `_apply_message_created` re-validates the same shape, so on a validated payload the apply **should not** fail. Defensive behaviour if it does:

- The apply runs inside `insert_event`, which runs inside the router's per-event `begin_nested()` SAVEPOINT. A raise propagates out of the SAVEPOINT → **the whole per-event emit rolls back** (the `head_seq` bump *and* the `events` insert are both undone) → the event is **rejected, not stored without its projection**. This is exactly the acceptance criterion.
- The exception is **not** one the router catches (`IntegrityError` / `UnknownStreamError` / class-22 `DBAPIError`), so it propagates to a **500**. Already-committed prior events in the batch stay committed (per-event commit); event N is cleanly rolled back.
- **Do NOT add a catch clause** to shape apply failures into per-event rejects. A projection bug that rejects valid events must be a **loud failure** (500), which is *preferable to silent divergence*. Since it should be impossible (payload pre-validated), a 500 is the correct "your projection code has a bug, fix it" signal — it cannot silently let `events` and `messages_proj` drift. The DOS concern (a projection bug 500-ing all uploads of a type) is real but *acceptable and preferable*: it's loud, immediate, and caught by the gate before merge, not a data-integrity corruption discovered months later.
- **Note (no action):** a NUL / class-22 data-exception in `text` surfaces at the `events` JSONB `flush()` *inside `insert_event`, before* step 3b runs — so ENG-66's existing class-22 `DBAPIError` handler still catches it at the events layer, and the projection insert of the same `text` is never reached. The projection adds **no new data-exception surface**; do not add redundant handling.

## Risks / open questions

1. **`insert.py` cross-cut collision.** Confirmed collision-free (no in-flight ticket touches `insert.py`; ENG-66's merged files untouched). Keep the edit to an import + one call + one docstring line so a future ENG-66 hotfix rebases trivially.
2. **Per-example state reset in the property gate** — the single easiest bug (session-scoped container, per-test not per-example isolation). Mitigation baked into Ruling 4: truncate at the top of each `@given` example via a short-lived session over the session-scoped engine; avoids the `function_scoped_fixture` HealthCheck.
3. **Projection-in-txn 500 as DOS** — accepted and preferable to silent divergence (see Pin-5 ruling); guarded by pre-validation + the gate.
4. **TRUNCATE ACCESS EXCLUSIVE lock during rebuild** — documented M1 single-operator property; `DELETE` noted as the drop-in if concurrency ever matters.
5. **PROJECTION_VERSION storage.** We declare `PROJECTION_VERSION = 1` as a module constant (satisfies the "every projection declares its version" invariant) but do **not** build a stored-version auto-rebuild-on-mismatch on the server in M1 (that was the M0/client-Dexie analogue). A version bump on the server is handled by an operator running `msgctl rebuild-projections`. Deferring the stored-version machinery until a bump actually needs it keeps M1 minimal — flag for review if the reviewer wants the meta-row now.
6. **Async + hypothesis ergonomics** — drive each example via `asyncio.run` (sync `@given` body, per ENG-61); confirm the `ci` profile budget (~40–60 examples × real PG round-trips + truncate) stays within a sane CI time (tune `max_examples` down if the step runs long).

## Agent assignment

- **`python-engineer`** — the `server/msgd/projections/` package (apply/rebuild/dump), the `insert.py` hook, the `msgctl rebuild-projections` subcommand, and all server tests (unit + the permanent gate).
- **`devops-engineer` (light-touch)** — the `.github/workflows/ci.yml` new named step only (~5 lines; content specified in Ruling 4). The edit is more than one line and touches CI ordering (must sit after the Postgres pre-pull), so it is devops's to place/review; everything else is python-engineer.
