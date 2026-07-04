# ENG-59 — M0: `msgctl rebuild` — drop projection and replay from log

**Milestone:** M0 — Protocol spike
**Tech-lead:** planning complete; all implementation is **`python-engineer`**.
**TDD refs:** §2.3 rule 5 (drop-tables + reset-cursors + replay-from-log is the definition of a
rebuild), §5 (`msgctl` command surface), §13 (M0 exit — the rebuild ≡ incremental invariant).
Locked decisions in scope: **D2** (gapless per-stream `server_sequence` — the contiguity the replay
re-checks), **D9** (unknown types/versions preserved-not-crashed — inherited unchanged from the
projection engine), **D14** (`client_created_at` untrusted). Permanent CI invariant this ticket
serves: **rebuild ≡ incremental** (ENG-61 is the gate; this ticket ships the `rebuild` half of it).
**Depends on (merged to main):** ENG-57 (`msgctl init`/`send`, the NDJSON workspace + `flock_exclusive`
+ `_fsync_dir`) and **ENG-58** (`cli/msgctl/projection.py`: `PROJECTION_VERSION`, path-parameterized
`open_db` with auto-rebuild-on-mismatch, `_rebuild_schema` + `project` as the designed seam,
`dump_messages` compact contract — see `.claude/chat/eng-58-projection.md` incl. its Review Round 1).
**Runs adjacent to ENG-60 (`msgctl verify`, PR #7)** — both append a subcommand to `cli.py`; the
collision protocol from ENG-58 §6 applies unchanged (§6 below).

---

## 1. Goal (restated)

`msgctl rebuild <dir>` **truncates** the SQLite projection (its `messages` rows and `stream_cursors`)
and **replays every event** from the NDJSON logs in `(stream_id, server_sequence)` order, producing a
`messages` table byte-equal (under `dump_messages`) to what incremental `project` would produce on the
same logs. Three hard properties:

- **Read-only over the source of truth.** The logs under `streams/**/*.ndjson` are never written,
  truncated, or repaired — rebuild is a pure reader (it reuses ENG-58's read-only `_read_stream_events`
  transitively via `project`). A byte-compare of every log file before/after must be identical.
- **Resilient — safe to interrupt and re-run.** Rebuild builds into a **temp DB**
  (`<dir>/projections.sqlite3.rebuild`) and **atomically swaps** it over the live
  `projections.sqlite3` with `os.replace` only on success. An interrupt (kill / exception) at any
  point before the swap leaves the **previous projection byte-for-byte intact**; a stale `.rebuild`
  leftover is removed on the next run, so re-running always converges.
- **Version-normalizing.** Because the temp DB is built fresh through `open_db`, the swapped-in
  projection is always stamped at the current `PROJECTION_VERSION`, regardless of the old DB's version.

Areas touched: **new** `cli/msgctl/rebuild.py` (orchestration only — zero new projection logic), a
surgical append to `cli/msgctl/cli.py`, new `cli/tests/test_rebuild.py`. **`projection.py` is
untouched** (its `open_db`/`project` seam is already exactly what rebuild needs). No `core/` edits, no
new runtime dependency, no changes to `append.py`/`workspace.py`/`errors.py` (read-only reuse only).

---

## 2. Design rulings (each pinned decision)

### Ruling 1 — Swap mechanics: fresh temp DB → replay → fsync → `os.replace` → dir-fsync

The stronger-than-ENG-58 guarantee (interrupted rebuild leaves the OLD projection intact, not a
mid-rebuild empty DB) is delivered by never touching the live file until an atomic rename. Mechanics,
in order, inside `rebuild_projection(ws)`:

1. **Names.** `live = ws.root / PROJECTION_DB_NAME` (`projections.sqlite3`);
   `temp = ws.root / PROJECTION_REBUILD_DB_NAME` (`projections.sqlite3.rebuild`), both at the
   workspace root (siblings of `workspace.json`, outside `streams/`).
2. **Remove crash leftovers first.** `temp.unlink(missing_ok=True)` **and**
   `(ws.root / (PROJECTION_REBUILD_DB_NAME + "-journal")).unlink(missing_ok=True)` — a `.rebuild`
   (and its transient rollback journal) left by a killed prior rebuild. This is what makes re-run
   after an interrupt safe: rebuild always starts from a clean temp slot.
3. **Build fresh.** `conn = open_db(temp)`. Because `temp` was just removed, `open_db` hits its
   **fresh-DB** branch → `_init_schema` → empty schema + current-version stamp + empty cursors.
   Then `result = project(ws, conn)` in a `try/finally: conn.close()` → replays the entire log from
   empty cursors (per-stream, ascending `server_sequence`, D9 skips preserved — all inherited).
   `conn.close()` under `journal_mode=DELETE` commits and removes the temp `-journal`, so `temp` is a
   single clean file ready to swap.
4. **Durable atomic swap.** `os.open(temp, O_RDONLY)` → `os.fsync(fd)` → `os.close(fd)`;
   `os.replace(temp, live)` (atomic rename on POSIX); `_fsync_dir(ws.root)` (make the rename durable).
   This is the exact discipline `Workspace.write_manifest` already uses.
5. **Return** the `ProjectResult` for the CLI summary.

**The load-bearing primitive is `os.replace`'s atomicity, not the fsync.** "Interrupted rebuild leaves
the previous projection intact" holds purely because we write only `temp` and rename atomically: a
crash *before* `os.replace` cannot have touched `live`; a crash *after* it means `live` already
points at the complete new DB. The `fsync(temp)` + `_fsync_dir` are cheap belt-and-suspenders so a
power-loss *immediately after* the rename leaves a durable, complete new projection rather than a torn
one that would need yet another rebuild — consistent with the ticket's "resilient" intent and with
`write_manifest`. **This is a deliberate, narrow exception to ENG-58's "projection durability is
cheap"** ruling: that ruling governed per-`project` incremental writes (a torn one is a self-healing
no-op); here atomicity *is* the whole point of the temp-DB design, so we spend the two extra fsyncs.
State this in the module docstring so a reviewer doesn't "simplify" the fsyncs away or, conversely,
think we contradicted ENG-58.

**Excluded from verify/export by path (ENG-60 note).** `projections.sqlite3.rebuild` — like
`projections.sqlite3` — is a top-level file matching neither the `streams/<id>/*.ndjson` descent nor
the two named manifests, so it can never enter a hash/contiguity walk. No ignore-list needed; record
that verify (ENG-60) enumerates explicit paths and never globs the root, so a transient `.rebuild`
leftover is invisible to it.

### Ruling 2 — Reuse / refactor: rebuild = `open_db(temp)` + `project(ws, conn)`, zero new projection logic; **no `projection.py` change**

- **`open_db` is already path-parameterized** (`open_db(db_path: Path | str)`). ENG-58's `cmd_project`
  passes `ws.root / PROJECTION_DB_NAME`; rebuild passes `ws.root / PROJECTION_REBUILD_DB_NAME`. **No
  refactor is required to accept an explicit path — it already does.** This is the whole reuse story:
  the fresh-temp path exercises `open_db`'s fresh-DB branch, and `project` replays from empty cursors.
- **We do NOT call `_rebuild_schema`.** ENG-58 designed the seam as `_rebuild_schema(conn)` then
  `project(ws, conn)` for an **in-place** reset of the *live* DB. ENG-59 deliberately supersedes that
  with a **fresh temp DB + atomic swap**, which gives the strictly stronger interrupt guarantee (the
  in-place path can leave a mid-rebuild half-empty live DB — acceptable in ENG-58 only because the
  version stamp is written *last*, making it self-healing on the next `project`; the ticket demands
  the old DB stay intact, which in-place cannot promise). `open_db(temp)` on a fresh file produces the
  same empty-schema-at-current-version starting point `_rebuild_schema` would, without mutating
  anything live. `_rebuild_schema` remains in use by `open_db`'s auto-on-mismatch branch, so it is not
  dead code — ENG-59 simply chooses the temp-file variant of the same "reset + replay" idea.
- **New constant lives in `rebuild.py`, not `projection.py`.** `PROJECTION_REBUILD_DB_NAME: Final =
  PROJECTION_DB_NAME + ".rebuild"` is defined in the new module (importing `PROJECTION_DB_NAME` from
  `projection`), keeping `projection.py` at a **zero-line diff**. The name needs no registration
  anywhere else (excluded from verify/export by path — Ruling 1).
- **Reuse `_fsync_dir` and `flock_exclusive` as-is.** `append.py` already imports
  `from msgctl.workspace import _fsync_dir` and defines `flock_exclusive`; rebuild imports both the
  same way. No new helper, no promotion of a private function — established precedent.

### Ruling 3 — Locking: rebuild takes the workspace lock; `project`/`rebuild` non-concurrency documented for M0

The race: rebuild's `os.replace` could clobber a DB a **concurrent `project`** is mid-write on. ENG-58's
`project` takes **no lock** (it relied on M0 being single-writer; SQLite's own locking guards only an
individual transaction, not the file swap). Options weighed:

- *(a) dedicated `.projections.lock` held by both `project` and `rebuild`* — would require editing
  `project()`/`cmd_project` (ENG-58 contract: projection.py read-only for this ticket; cli.py
  append-only, don't touch existing handlers). Rejected: buys real project↔rebuild mutual exclusion
  but at the cost of the very files this ticket must not disturb, for a mode M0 doesn't support.
- *(b) document non-concurrency, no lock at all* — honest for a single-operator tool, but leaves the
  one genuinely destructive **same-tool** race unguarded: two `rebuild`s racing on the shared
  `.rebuild` temp name and swap could interleave temp writes.
- *(c) [CHOSEN] rebuild holds `flock_exclusive(ws.lock_path)` around its build+swap; document
  project↔rebuild non-concurrency for M0.*

**Ruling: (c).** msgctl M0 is a single-operator local tool — ENG-57's entire locking story is
per-stream *append* serialization; there is no supported "concurrent projector" mode, and ENG-61's CI
runs `project` and `rebuild` **sequentially**. So project↔rebuild non-concurrency is documented as an
M0 assumption, not enforced (enforcing it would mean touching `project`, out of scope). But rebuild
**does** take the existing workspace lock (`ws.lock_path` = `<root>/.lock`, via the existing
`flock_exclusive`) for the whole build+cleanup+swap: this is a 3-line reuse that closes the one
destructive same-tool race (rebuild vs. rebuild on the shared temp file) and harmlessly serializes
against `send`'s registry mutation. It does **not** block appends to existing streams (those take the
per-stream lock), which is correct — rebuild reads a point-in-time log snapshot and any straggler
append is picked up by the next incremental `project`. Smallest honest diff; no new lock file, no
projection.py edit. Document the residual (a hand-run `project` racing a `rebuild` is unsupported in
M0) in the module docstring and as a risk.

### Ruling 4 — CLI: append-only `rebuild <dir>` subcommand; `{rebuilt, applied, skipped, streams}` JSON; exit 0/1/2

- **Subparser + handler are append-only** per the ENG-58 §6 collision protocol: a self-contained
  `subparsers.add_parser("rebuild", …); set_defaults(handler=cmd_rebuild)` block immediately before
  `return parser`, and `cmd_rebuild` appended after `cmd_project`. Dispatch is the existing
  `args.handler(args)` in `main` — no separate dispatch line to edit. One added import line
  (`from msgctl.rebuild import rebuild_projection`).
- **Output** (mirrors `cmd_project`'s shape so tools/tests see one contract, plus the `rebuilt` flag):
  `print(json.dumps({"rebuilt": True, "applied": result.applied, "skipped": result.skipped,
  "streams": result.stream_heads}, ensure_ascii=False))`. The ticket's "`streams: M`" is satisfied by
  the `stream_heads` map (M entries: stream_id → head sequence); keeping the map (not a bare count)
  matches `cmd_project` exactly and is strictly more informative.
- **Exit codes:** `0` success; `1` operational error — `CorruptLogError` (corrupt terminated log line,
  D2 gap, malformed known payload) is a `MsgctlError`, already funneled by `main`'s
  `except MsgctlError` → `msgctl: …` stderr + `exit_code`; `2` argparse usage. No new error type.
- **`cmd_rebuild` stays thin**: `ws = Workspace.open(args.dir)` → `result = rebuild_projection(ws)` →
  print JSON → `return 0`. All orchestration (lock, cleanup, temp build, fsync, swap) lives in
  `rebuild.py` so the interrupt/swap logic is unit-testable in-process, independent of argv/subprocess.

### Ruling 5 — Determinism contract for ENG-61: rebuild-then-`dump_messages` ≡ incremental-then-`dump_messages`

- `dump_messages` (ENG-58, compact separators, explicit `_DUMP_COLUMNS`, `ORDER BY stream_id,
  server_sequence`) is **already** the canonical comparison surface. ENG-59 adds nothing to the dump;
  it guarantees that a **fully replayed** projection yields the identical dump to an incrementally
  built one on the same logs. This equivalence is exercised locally here (Test plan) and is the exact
  invariant ENG-61 asserts across a whole workspace.
- **Never byte-compare the SQLite files** for equivalence (page layout / freelist / rowid are
  non-deterministic) — compare `dump_messages`. **The one place raw-byte comparison IS valid** is the
  interrupt test's "old DB intact" assertion: there we assert the live file was *not written at all*
  (identical bytes before/after a failed rebuild), which is a legitimate byte-identity claim about an
  untouched file, not a semantic-equivalence claim.

---

## 3. File list

**Create:**

| File | Purpose |
|---|---|
| `cli/msgctl/rebuild.py` | `PROJECTION_REBUILD_DB_NAME`; `rebuild_projection(ws) -> ProjectResult` — the full orchestration: workspace lock, stale-`.rebuild` cleanup, `open_db(temp)` + `project`, `fsync(temp)` + `os.replace` + `_fsync_dir`. Orchestration only; imports all projection logic from `projection.py`. |
| `cli/tests/test_rebuild.py` | Multi-stream correctness (dump == incremental), interrupt-leaves-old-DB-intact + `.rebuild` cleaned on re-run, read-only-log byte-compare, idempotent re-run, version-mismatch normalized to current, empty workspace, corrupt-log hard error, workspace-lock serialization. |

**Modify (surgical, append-only — ENG-58 §6):**

| File | Change |
|---|---|
| `cli/msgctl/cli.py` | One import (`from msgctl.rebuild import rebuild_projection`), one `rebuild` subparser block appended before `return parser`, one `cmd_rebuild` handler appended after `cmd_project`. Nothing else touched. |

**Read-only (do NOT modify):** `cli/msgctl/projection.py` (**zero diff** — `open_db` already
path-parameterized, `project`/`_rebuild_schema`/`dump_messages` unchanged), `cli/msgctl/append.py`,
`cli/msgctl/workspace.py`, `cli/msgctl/errors.py`, all of `server/msgd/core/`. **Untouched:**
`cli/pyproject.toml` (no new deps), root `pyproject.toml`, `uv.lock`, CI.

---

## 4. Step-by-step (all `python-engineer`)

**Step 1 — `rebuild.py` skeleton + constant + docstring.**
- `from __future__ import annotations`; imports: `os`; `from pathlib import Path`; `from typing import
  Final`; `from msgctl.append import flock_exclusive`; `from msgctl.projection import
  PROJECTION_DB_NAME, ProjectResult, open_db, project`; `from msgctl.workspace import Workspace,
  _fsync_dir`.
- `PROJECTION_REBUILD_DB_NAME: Final = PROJECTION_DB_NAME + ".rebuild"`.
- Module docstring: rebuild = drop projection + replay-from-log (§2.3 rule 5); temp-DB + atomic swap
  (interrupt leaves old projection intact); the `os.replace`-is-load-bearing / fsync-is-belt note
  (Ruling 1); the deliberate exception to ENG-58's "durability is cheap"; read-only over the log; the
  M0 project↔rebuild non-concurrency assumption + workspace-lock guard (Ruling 3).

**Step 2 — `rebuild_projection(ws: Workspace) -> ProjectResult`.**
```
live = ws.root / PROJECTION_DB_NAME
temp = ws.root / PROJECTION_REBUILD_DB_NAME
temp_journal = ws.root / (PROJECTION_REBUILD_DB_NAME + "-journal")
with flock_exclusive(ws.lock_path):                 # Ruling 3
    temp.unlink(missing_ok=True)                     # crash leftovers (Ruling 1.2)
    temp_journal.unlink(missing_ok=True)
    conn = open_db(temp)                             # fresh schema, current version, empty cursors
    try:
        result = project(ws, conn)                   # full replay; may raise CorruptLogError
    finally:
        conn.close()                                 # commit + drop -journal → single clean file
    fd = os.open(temp, os.O_RDONLY)                  # durable atomic swap (Ruling 1.4)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, live)
    _fsync_dir(ws.root)
return result
```
- On a `project` exception the swap is never reached, the temp conn is closed by `finally`, `live`
  is untouched, and the stale `.rebuild` is cleaned by the *next* run's Step-2 unlink (matches the
  crash case, which cannot run a finally anyway — so startup cleanup must exist regardless; a
  failure-path unlink would be redundant). Do not add one.

**Step 3 — `cli.py` append (surgical, ENG-58 §6).**
- Add import `from msgctl.rebuild import rebuild_projection`.
- After the `project` subparser block, before `return parser`: a `rebuild` subparser
  (`add_parser("rebuild", help="drop the projection and replay the whole log")`,
  `add_argument("dir", …)`, `set_defaults(handler=cmd_rebuild)`).
- After `cmd_project`: `cmd_rebuild(args)` per Ruling 4 (thin: open ws → `rebuild_projection(ws)` →
  print the `{rebuilt, applied, skipped, streams}` JSON → `return 0`).

**Step 4 — Local gates:** `uv run ruff check`, `ruff format --check`, `uv run mypy`, `uv run pytest`
all green. By hand: `init`, several `send`s across two streams, `project`, `rebuild`; confirm
`dump_messages` (or `sqlite3` inspection) of the rebuilt DB matches the incremental one; run `rebuild`
again (still correct, no `.rebuild` leftover); confirm logs byte-unchanged.

---

## 5. Test plan (`cli/tests/test_rebuild.py`; `tmp_path`; subprocess via `conftest.run_cli` for CLI
paths, in-process `rebuild_projection(ws)` + `open_db`/`dump_messages` where a DB handle is needed)

- **`test_rebuild_matches_incremental_multistream`** (AC — complete correct table + determinism) —
  init; interleaved sends across ≥2 streams; run incremental `project`; `dump_A = dump_messages`. In a
  *second* identical workspace (same sends/ids/text so bodies match), run `rebuild`; `dump_B`. Assert
  `dump_A == dump_B` byte-for-byte, and the rebuilt `messages` has every sent message with correct
  `message_id/text/format/stream_id/server_sequence/author_user_id`. Also assert within *one*
  workspace: `project` then `rebuild` → both dumps identical (the local rebuild ≡ incremental stand-in
  for ENG-61).
- **`test_interrupt_leaves_previous_projection_intact`** (AC) — build a good live projection via
  `project`; snapshot `projections.sqlite3` **raw bytes**. Monkeypatch `msgctl.rebuild.project` (or a
  handler) to raise mid-replay *after* partial writes into `temp`; call `rebuild_projection(ws)` and
  assert it raises. Then assert: live `projections.sqlite3` is **byte-identical** to the snapshot (never
  touched — valid raw-byte compare per Ruling 5); a `.rebuild` leftover may exist. Then remove the
  fault and run `rebuild` again → succeeds, `.rebuild` gone, live DB now equals a clean rebuild's dump.
- **`test_rebuild_is_read_only_over_log`** (AC) — snapshot every `streams/**/*.ndjson` byte; run
  `rebuild`; assert every log file byte-identical afterward. Include a torn-trailing-line variant
  (append a partial no-`\n` line): rebuild succeeds, that message absent, and the torn bytes are
  **left in place** (rebuild never repairs — inherited from `_read_stream_events`).
- **`test_rebuild_idempotent_rerun`** — `rebuild` twice in a row; both dumps identical; no `.rebuild`
  (nor `-journal`) leftover after either; live DB correct. Then one more `send` + incremental
  `project` on top of a rebuilt DB → exactly one new row (rebuild left a sane cursor state).
- **`test_rebuild_normalizes_stale_version`** — write a live DB stamped at an old
  `meta.projection_version` (e.g. `'0'`); `rebuild`; assert the swapped-in DB's
  `meta.projection_version == str(PROJECTION_VERSION)` and its dump equals a from-scratch projection's
  (proves rebuild always yields a current-version DB regardless of the old one).
- **`test_rebuild_empty_workspace`** — init, no sends; `run_cli("rebuild", root)` → exit 0, stdout
  `{"rebuilt": true, "applied": 0, "skipped": 0, "streams": {}}`; a valid empty `messages` table
  swapped in; no `.rebuild` leftover.
- **`test_rebuild_corrupt_log_hard_errors_and_preserves_live`** — a good live projection exists;
  hand-write a terminated non-envelope (or D2-gap, or malformed known payload) line; `run_cli("rebuild"
  …)` → exit **1**, stderr starts `msgctl:`, `"Traceback" not in stderr`; live `projections.sqlite3`
  **byte-identical** to the pre-rebuild snapshot (failure before swap); log untouched. Sibling of
  ENG-58's `test_corrupt_terminated_line_hard_errors` at the rebuild layer.
- **`test_rebuild_holds_workspace_lock`** (Ruling 3) — following `test_concurrency.py`'s gate pattern:
  the test process holds `flock_exclusive(ws.lock_path)`, then launches `msgctl rebuild` in a
  subprocess and asserts it is **blocked** (does not complete within a short window); release the lock
  → the subprocess completes 0 and the DB is correct. Keep it modest — it pins that rebuild serializes
  on the workspace lock (rebuild-vs-rebuild safety), not a full concurrency proof.

Map to ACs: complete-correct-table + rebuild≡incremental → `test_rebuild_matches_incremental_multistream`;
interrupted-rebuild-leaves-previous-intact → `test_interrupt_leaves_previous_projection_intact`
(+ `test_rebuild_corrupt_log_hard_errors_and_preserves_live`); read-only-log →
`test_rebuild_is_read_only_over_log`. The rest exceed the bare ACs but pin the ticket's resilience and
version-normalization intent and the chosen locking ruling.

---

## 6. Coordination (ENG-60 `verify` + ENG-61 gate)

- **`cli.py` collision (ENG-60 `verify`, PR #7).** Identical protocol to ENG-58 §6: keep the `cli.py`
  diff append-only (subparser block at the end of `build_parser` before `return parser`; `cmd_*` at
  the end of the handlers; dispatch via `set_defaults` — no separate dispatch line). Whichever of
  ENG-59/ENG-60 lands second **mechanically reorders** its self-contained block below the other's — a
  pure rebase, no parser refactor. `append.py`/`workspace.py`/`errors.py`/`projection.py` stay as-is.
- **ENG-60 exclusion contract (record now).** `verify` enumerates `streams/<id>/*.ndjson` + the two
  manifests explicitly and never globs the workspace root, so both `projections.sqlite3` **and** the
  transient `projections.sqlite3.rebuild` (+ its `-journal`) are outside the verify/export walk **by
  path** — a `.rebuild` leftover from an interrupted rebuild can never enter a hash/contiguity check.
- **ENG-61 gate (record now).** ENG-59 supplies the `rebuild` half of the rebuild ≡ incremental
  invariant. ENG-61 compares `dump_messages(rebuilt_conn)` against `dump_messages(incremental_conn)`
  over a whole workspace; the local `test_rebuild_matches_incremental_multistream` is the stand-in.
  No dump-contract change — ENG-58's compact `dump_messages` is reused verbatim.

---

## 7. Risks / open questions

- **project↔rebuild concurrency is documented, not enforced (Ruling 3).** M0 is single-operator; a
  hand-run `project` racing a `rebuild` is unsupported and could have the swap clobber the concurrent
  writer's DB. Enforcing it would require locking `project` (out of scope — projection.py read-only,
  cmd_project not this ticket's to change). Revisit if M1 introduces a background/daemon projector.
- **fsync-on-swap is a deliberate exception to ENG-58's "durability is cheap."** Justified because
  atomicity is the temp-DB design's whole point (Ruling 1). Flag so a reviewer neither strips the two
  fsyncs nor, conversely, "restores consistency" by adding fsyncs to the incremental `project` path
  (that path is correctly cheap — a torn incremental write is self-healing).
- **macOS `fsync` is not a media flush** (only `F_FULLFSYNC` is) — the same platform nuance
  `_fsync_dir` already documents and waives for M0 (Linux is the §11 deployment target). Inherited, not
  re-litigated.
- **Full log re-read on every rebuild (O(total events)).** Inherent — rebuild replays everything by
  definition; not the incremental-perf concern ENG-58 flagged. Fine at M0.
- **`_rebuild_schema` now has a single caller** (`open_db`'s auto-on-mismatch branch) since ENG-59
  chose the temp-DB variant instead of the in-place seam. It is **not** dead code and the seam
  signature is untouched; noted only so a future reader understands why the "designed seam" from
  ENG-58 isn't the path `rebuild` took (the temp-DB variant is strictly stronger — Ruling 2).

---

## 8. Concise summary (for the dispatcher)

- **Swap mechanics (Ruling 1):** build into `<dir>/projections.sqlite3.rebuild` via `open_db(temp)`
  (fresh schema, current version, empty cursors) + `project(ws, conn)` (full replay) → `conn.close()`
  → `fsync(temp)` → `os.replace(temp, live)` → `_fsync_dir(ws.root)`. Remove any stale `.rebuild`
  (+ `-journal`) at the start. The **`os.replace` atomicity** is what guarantees an interrupt leaves
  the OLD projection byte-for-byte intact; the two fsyncs are cheap belt-and-suspenders (a deliberate,
  documented exception to ENG-58's cheap-durability rule, because atomicity is the design's point).
- **Reuse/refactor (Ruling 2):** **zero `projection.py` diff** — `open_db` is already
  path-parameterized, so rebuild is pure orchestration: `open_db(temp)` + `project` + swap. `rebuild`
  uses the **fresh-temp variant**, not ENG-58's in-place `_rebuild_schema` seam (temp+swap is strictly
  stronger — old DB stays intact). Reuse `flock_exclusive` (append.py) and `_fsync_dir` (workspace.py)
  as-is, per existing precedent. New constant `PROJECTION_REBUILD_DB_NAME` lives in `rebuild.py`.
- **Locking (Ruling 3):** rebuild holds the existing **workspace lock** (`ws.lock_path` via
  `flock_exclusive`) around cleanup+build+swap — closes the destructive rebuild-vs-rebuild race on the
  shared temp file, 3-line reuse, no projection.py edit. `project`↔`rebuild` non-concurrency is
  **documented** as an M0 single-operator assumption (ENG-61 CI runs them sequentially); not enforced,
  because enforcing needs a lock on `project`, out of scope.
- **CLI (Ruling 4):** append-only `rebuild <dir>` subparser + thin `cmd_rebuild`; output
  `{"rebuilt": true, "applied": N, "skipped": K, "streams": {stream_heads}}`; exit 0/1/2 via the
  existing `MsgctlError` funnel (`CorruptLogError` → exit 1, clean `msgctl:` stderr). Same §6
  collision protocol vs. ENG-60's `verify` — second-to-merge reorders its block, a pure rebase.
- **File list:** create `cli/msgctl/rebuild.py` + `cli/tests/test_rebuild.py`; surgical append to
  `cli/msgctl/cli.py` (one import + subparser + handler). `projection.py`/`append.py`/`workspace.py`/
  `errors.py`/`core/` untouched; no new deps.
