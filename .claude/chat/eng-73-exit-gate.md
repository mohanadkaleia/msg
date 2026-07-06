# ENG-73 — M1 exit gate: two msgctl clients converge over the real server; sign off milestone

**Tech-lead plan. Do NOT implement from this doc alone — it is the contract the implementers copy from.**
Closes M1, tags `m1`. Almost everything is **python-engineer** (E2E test, TDD write-backs, README, the one
fix-now scrub broadening, schema publish). **No devops-engineer work** — the compose-up smoke is ruled a manual
PR checklist item, not a CI job (see §2.4), so `.github/workflows/ci.yml` is untouched. The Linear milestone flip
is the orchestrator's job; this plan records only the `git tag` command.

---

## 0. Restate the goal + sign-off findings

ENG-73 is a **gate + lock + sign-off**, not a feature. It (a) proves the M1 exit criterion with a dedicated
CI-permanent E2E — two `msgctl` remote workspaces converging over the *real* server under **interleaved
bidirectional** sends; (b) verifies the simulation suite is green (ENG-71) and audits that all four live §3.6
enforcement points carry an adversary test; (c) writes the accumulated M1 protocol clarifications back into the
TDD *before* M1 is declared done (§14 deviation discipline: "changes require revising this doc, not drive-by
PRs"); (d) folds in one cheap fix-now hardening carryover and dispositions the rest; (e) updates the README from
a CLI-only story to the client-server story; (f) tags `m1`.

### Sign-off findings (verified during planning — state these in the PR description)

1. **The M1 exit criterion already holds in miniature.** `cli/tests/test_remote_e2e.py::test_two_clients_converge`
   (ENG-70) already stands up the real stack (testcontainer PG + subprocess `uvicorn` running the true ASGI app)
   and drives two `msgctl` workspaces to byte-equal logs + byte-equal dumps + `verify` green on both, plus
   idempotency, rebuild-equivalence, and token hygiene. ENG-73 does **not** re-invent that mechanism; it
   **extends it into a dedicated exit-gate test** whose new teeth are *interleaved bidirectional* traffic (both
   clients author into the **same** channel across **multiple push rounds**), the M0-ENG-61 convergence-gate
   analogue for M1's client-server loop.

2. **All four *live* §3.6 enforcement points already have adversary tests** (audit table in §2.2 below). Point 4
   (files) is not implemented in M1 and is correctly deferred to M3. So the enforcement work is **audit +
   documented matrix**, not new tests.

3. **The M1 deviations are all additive surface clarifications.** No envelope field and no locked D-decision
   changes. §3.3's WS-auth move (`?token=` → `Sec-WebSocket-Protocol`) is a within-milestone, pre-client surface
   correction (ENG-68), not a D-table revision.

The one deliberately non-trivial code change is the **debug-log scrub broadening** (§4, carryover A) — cheap and
it fully closes the token-leak class opened when the WS token moved onto a header.

---

## 1. Files touched (exhaustive)

| # | File | Change | New/edit |
|---|------|--------|----------|
| A | `docs/technical-design.md` | 5 additive write-backs (§3.3, §3.2, §2.2, §4.2, §12) + 1 §15 line — verbatim in §3 | edit |
| B | `cli/tests/test_m1_exit_gate.py` | **the exit gate**: interleaved bidirectional two-client convergence, `integration`-marked, CI-permanent | **new** |
| C | `cli/tests/_e2e_server.py` | extract the `live_server` fixture + `_free_port`/`_wait_healthy`/`_run`/`_log_lines`/`_project_dump` helpers so both E2E files share one mechanism (one Postgres container, one uvicorn) | **new** |
| D | `cli/tests/test_remote_e2e.py` | import the shared fixture/helpers from C instead of its local copies (behavior unchanged) | edit |
| E | `server/msgd/logging.py` | broaden `RedactSecretsFilter`: add a `Sec-WebSocket-Protocol: bearer, <token>` scrub (carryover A, fix-now) | edit |
| F | `server/tests/test_no_secrets_in_logs.py` | unit case: a record carrying the subprotocol-header wire-trace shape is scrubbed | edit |
| G | `README.md` | M1 section: server quickstart via compose, `msgctl remote` login/push/pull story, milestone table M1→Done, repo layout + status paragraph | edit |
| H | `server/tests/generate_schemas.py` + `docs/schemas/*.json` + `server/tests/test_schemas.py` | **surfaced ENG-65 flag** (§6): publish JSON Schemas for the M1 meta payload types via the existing generator + freeze test | edit/new |

**No `.github/workflows/ci.yml` change.** The CI `Pytest` step runs `uv run pytest --ignore=server/tests/simulation`
with `addopts = "-q"` and **no** `-m "not integration"` deselection, and Docker + a pre-pulled `postgres:17` are
present on the runner — so the existing step already collects and runs `integration`-marked E2Es. File B is
picked up automatically, exactly as `test_remote_e2e.py` is today. The `Simulation suite` and both equivalence-gate
steps are **verify-only** here (checklist items 2 and the permanent invariant).

---

## 2. Design decisions (ruled)

### 2.1 E2E convergence test — a DEDICATED `test_m1_exit_gate.py` (interleaved bidirectional)

**Rule: a new dedicated `cli/tests/test_m1_exit_gate.py`, not an extension of `test_two_clients_converge`.**
ENG-70's test is a *feature* test (does remote login/push/pull/invite work end to end); the exit gate is a
*convergence* test (do two independent authors on a shared channel provably converge). They assert different
things and should read as different documents — mirroring how M0 kept `test_remote_e2e`-style feature coverage
separate from the ENG-61 `test_equivalence_gate.py` convergence gate. Both are `integration`-marked and both stay
in CI forever.

**Shared mechanism (file C).** Extract ENG-70's module-scoped `live_server` fixture (testcontainer `postgres:17`
+ `run_migrations` + subprocess `uvicorn msgd.api.app:create_app --factory`, health-poll, server-log capture) and
its `_free_port`/`_wait_healthy`/`_run`/`_log_lines`/`_project_dump` helpers into `cli/tests/_e2e_server.py` (or
a `conftest.py` fixture). test_remote_e2e.py imports them; test_m1_exit_gate.py imports them. One container, one
server process shape, one place to maintain. Keep the fixture **module-scoped** so each file reuses a single
server within its module.

**Test body — the interleaved bidirectional convergence:**

1. **Setup + shared writable channel.** Workspace A: `login --setup` (owner, workspace "Acme"). The setup path
   creates the public `general` channel (both non-guest members can write it — §3.6). A mints a `member` invite;
   Workspace B: `login --invite-token`; `pull` (B resolves A's `general` from `/v1/sync`). Both A and B are now
   non-guest members with write access to the **same** `general` stream.
2. **Interleaved sends across multiple push rounds.** For `r` in a few rounds (e.g. 3 rounds × K each):
   alternate `send` calls between the two workspaces into `general` — `A:a{r}{i}`, `B:b{r}{i}`, interleaved — then
   `push` **both** (A then B one round, B then A the next, to vary server-arrival interleaving), then `pull`
   both. The interleave lands where it matters: the server assigns the single gapless per-stream sequence across
   two independent authors, and each client materializes the other's events on pull.
3. **Drive to a fixpoint.** After the final round, `pull` A and `pull` B once more; assert this last pull is a
   **no-op** (no new ndjson lines appended) — proves quiescence/convergence, not just eventual agreement.
4. **Assertions (the M1 exit criterion, verbatim intent):**
   - **A1 — byte-equal stream logs.** Same set of stream ids on both; for each id, `A/streams/<id>/*.ndjson`
     lines `==` `B/streams/<id>/*.ndjson` lines (the ENG-70 `_log_lines` compare, now over 2×(3K) interleaved
     events).
   - **A2 — byte-equal project dumps.** `dump_messages(project(A))` `==` `dump_messages(project(B))`; assert the
     full expected message count (`2 × rounds × K`) is present.
   - **A3 — `verify` green on both** (exit 0).
   - **A4 — rebuild ≡ incremental** on a pulled workspace (`rebuild_projection` then re-dump == incremental
     dump) — the permanent invariant, re-asserted on real client-server-materialized data.
   - **A5 — idempotency** (carry ENG-70's re-seed-an-accepted-item check): re-push an already-accepted `event_id`
     → server returns the original sequence, no duplicate line, `verify` still 0.
   - **A6 — token hygiene**: `0o600` creds file; the raw token appears in **neither** combined CLI stdout/stderr
     **nor** the captured server log. (This is the end-to-end backstop for carryover A; see §4.)

Runtime target < 60 s (one container amortized across the module; ~6K library-fast appends + a handful of HTTP
round trips). If the interleave count pushes runtime, trim K and record the number in the module docstring — same
perf-canary discipline as ENG-62's dogfood test.

### 2.2 §3.6 enforcement-point coverage — AUDIT + documented matrix (no new tests)

**Rule: this is a verification/audit task.** Grep confirms every *live* enforcement point already has a dedicated
adversary test. Add **no** new test; publish the matrix (in the PR body and as a short note the write-backs
reference). Files point deferred to M3, documented.

| §3.6 point | Enforced in | Adversary test (verified present) |
|---|---|---|
| 1. **Upload** (write perm on target stream) | ENG-66 `events/validate.py` | `server/tests/test_events_batch.py::test_adversary_write_nondisclosure` (+ `test_can_write_matrix`, guest/archived gates in `test_permissions.py`) |
| 2. **Pull** (`/v1/events`, read perm; 404 not 403) | ENG-67 router | `test_events_pull.py::test_404_private_non_member`, `::test_404_unknown_stream_identical` (identical 404 — existence not disclosed) |
| 2. **Sync** (`/v1/sync` head non-disclosure) | ENG-67 router | `test_sync.py::test_adversary_private_absent_and_events_404`, `::test_guest_sees_only_explicit_memberships` |
| 3. **WS fanout** (recipient set recomputed live per send) | ENG-68 hub | `test_ws.py::test_ws_adversary_receives_zero_frames`, `::test_ws_membership_removal_stops_fanout` |
| Predicate core | ENG-65 | `test_permissions.py::test_can_read_matrix` (role×kind×membership), `::test_require_readable_stream_404_not_403`, `::test_revocation_cuts_access_immediately` |
| 4. **Files** | — | **Not implemented in M1.** Deferred to M3 (file upload/download ticket owns the `file_id → stream → membership` adversary test). Documented, not a gap. |
| 5. **Search** | — | Not in M1 (server search is M3). Documented. |

Audit method for the implementer: re-run the four named tests green, paste the matrix into the PR, and add a one
sentence pointer from the §12 write-back (§3.5 below) to it.

### 2.3 Simulation suite (ENG-71) — VERIFY ONLY

**Rule: no code.** The `Simulation suite` CI step already runs `uv run pytest server/tests/simulation -q` with
`CI=true` (derandomized, bounded, < 2 min). ENG-73 confirms it is green on the merge branch and records it as
M1-exit evidence (four of six §12 invariants — the seam is written back in §3.5). Nothing to build.

### 2.4 compose-up quickstart — MANUAL PR checklist, not a CI job

**Rule: reuse ENG-72's manual checklist in the PR body; do not add a `compose up` CI step.** ENG-72 deliberately
shipped `docker compose config` + `docker build` + a `msgctl --version` PATH smoke, and **deferred the live
migrate→serve cycle to this gate** (ENG-72 plan §CI). A real `compose up` in CI costs minutes (image pull,
healthcheck waits, migrate→serve) and adds a flake surface for coverage the **E2E gate (file B) already exercises
against a live stack**. So:

- **CI:** unchanged — the existing `image` job (build + `compose config` + PATH smoke) stands.
- **Manual (paste into PR body as M1 acceptance evidence — from ENG-72's checklist):** from a clean checkout,
  `cp .env.example .env` + fill secrets → `docker compose up -d` → healthz green → `docker compose exec app msgctl
  --version` resolves → migrations ran → `docker compose down && up -d` re-boots clean (pgdata persists,
  migrations no-op). The reviewer confirms the paste.

Devops-engineer is **not** engaged unless a reviewer overrides this and asks for a live-up CI smoke — in which
case that is a separate devops-owned `.github/workflows/ci.yml` edit, explicitly out of this plan's scope.

### 2.5 README — the server story (python-engineer)

The README still describes only M0 (a local `msgctl` CLI). M1 turned msg into a client-server system. Add an
**M1 section** and update the surrounding scaffolding — this is the milestone's public narrative:

- **Status paragraph:** append "M1 — Sync server: complete (tagged `m1`)" with a one-line description (auth,
  streams + membership, batch upload w/ per-stream sequencing + idempotency, pull/sync, WS fanout, Postgres +
  migrations, compose self-host, simulation-suite skeleton green).
- **Milestone table:** flip `M1 — Sync server` from **Next** to **✅ Done**; flip M2 to **Next**.
- **New "Quickstart (M1: self-hosted server + `msgctl` remote)" section**, below the existing M0 local quickstart
  (keep M0 — it is still the offline story). Content: `docker compose up -d` to a healthy server (point at
  `docs/deploy.md`), then the remote client loop — `msgctl login <ws> --setup --server-url … --email … --password
  …` (owner) / `msgctl login <ws> --invite-token …` (invited member), `msgctl send`, `msgctl push`, `msgctl pull`
  — the same commands the exit-gate test drives. One sentence on the delivery contract (push is a hint; cursors
  are truth). Rename the existing quickstart heading to "Quickstart (M0: local workspace via `msgctl`)".
- **Repo layout block:** add `server/msgd/` `api/ · db/ · ws/ · projections/` and the `cli/msgctl/` remote verbs
  (`login`, `push`, `pull`, `invite`); update the CI line (integration E2E + simulation suite steps).

Keep it factual and short; no marketing drift. The M0 protocol paragraph stays as-is (still accurate).

### 2.6 Tag `m1`

**Rule: annotated tag on the squash-merge commit of this PR, pushed, post-merge.**

```
git tag -a m1 <merge-commit-sha> -m "M1 — sync server: two msgctl clients converge over the real server. Auth/sessions/invites, streams + membership, workspace-meta, batch upload (per-stream sequencing + idempotency), pull/sync, WebSocket fanout (Sec-WebSocket-Protocol bearer auth), Postgres + migrations, compose self-host, simulation-suite skeleton (4/6 §12 invariants) green in CI."
git push origin m1
```

Milestone → Done is the orchestrator's Linear action, not a repo change. The Linear flip follows the tag.

### 2.7 PR sequencing

**Rule: one PR, logical commits, squash-merged.** Order so a reviewer reads the lock and the gate first:
1. TDD write-backs (§3 below) + §15 line — the lock.
2. Debug-log scrub broadening + unit test (carryover A) — the one behavior change, isolated.
3. Shared E2E fixture extraction (C) + `test_remote_e2e.py` re-point (D) — mechanical, no behavior change.
4. `test_m1_exit_gate.py` — the gate.
5. Meta-type schema publish (H) — mechanical generator extension + freeze.
6. README (G).

---

## 3. TDD write-backs — VERBATIM text and exact insertion points

All are **additive** clarifications or within-milestone surface corrections of already-implemented behavior. Match
on the quoted anchor string, not the line number, in case of drift. Do not reflow surrounding text.

### 3.1 — §3.3 WebSocket auth via `Sec-WebSocket-Protocol` (EDIT the first line of §3.3)

**Anchor (replace this whole line, current line 257):**
`` `GET /v1/ws?token=…` — one socket per client (per SharedWorker). Messages are JSON frames: ``

**Replace with:**
```
`GET /v1/ws` — one socket per client (per SharedWorker), authenticated via the **`Sec-WebSocket-Protocol: bearer, <token>`** subprotocol header, **not** a `?token=` query parameter: the raw session token must never appear in a URL, where it leaks into reverse-proxy access logs, browser history, and `Referer` headers that no in-process log filter can reach. The server echoes `Sec-WebSocket-Protocol: bearer` on accept (required for the browser handshake to complete). The M2 web client opens the socket as `new WebSocket(url, ["bearer", token])`; the session token is `secrets.token_urlsafe(32)`, whose alphabet (`[A-Za-z0-9-_]`, no `=` padding) is entirely valid subprotocol characters, so it rides the header unencoded. The delivery contract and frame set below are unchanged. (ENG-68 security ruling; supersedes the `?token=` form.) Messages are JSON frames:
```

### 3.2 — §3.2 storability gate on envelope scalars (NEW bullet in the `/v1/events/batch` list, insert immediately after the "Author fields … must match the session …" bullet, current line 231)

```
- **Storability gate (envelope scalars, ENG-66):** the lax `Body` shape gate (`extra="allow"`) and a verifying `event_hash` are necessary but not sufficient — the envelope's scalar fields must also be **storable as typed** or the event is rejected `invalid_schema`. `type_version` must be a JSON **integer** within Postgres `INT4` range, and `client_created_at` must be a parseable RFC 3339 timestamp. An honestly-hashed but non-conforming form (e.g. a string `"1"` for `type_version`, hashed faithfully) is rejected **after** the hash check: the hash proves the bytes are the client's, not that they are storable. A JSONB-fatal body (e.g. a ` ` NUL inside a string — JSON-valid and JCS-hashable but rejected by Postgres JSONB) is likewise a per-event `invalid_schema`, isolated from the rest of the batch. This makes acceptance **total**: an event the server reports `accepted` is guaranteed round-trippable from storage. This narrows the §2.1 scalar domain (`type_version`, `client_created_at`) at the accept boundary. (ENG-66 deviation-1; supersedes that plan's "stored verbatim" companion ruling.)
```

### 3.3 — §2.2 `workspace-meta` is non-guest-only (EDIT the stream heading + add a note)

**Anchor (edit this heading, current line 172):**
`**\`workspace-meta\` stream** (one per workspace; every member is subscribed):`

**Replace with:**
```
**`workspace-meta` stream** (one per workspace; every **non-guest** member is subscribed):
```

**Then insert this note immediately after the `workspace-meta` table (after the `bot.installed / bot.removed` row, current line 183, before the "Membership events for **private** channels …" paragraph):**
```
> **Guest exclusion (ENG-65 / §3.6):** "every member" here means every **non-guest** member (owner/admin/member). A `guest` is a member with restricted scope — §3.6: a guest sees only streams they are explicitly added to — so granting guests `workspace-meta` would leak the full public-channel and member roster. Guests read `workspace-meta` only via an explicit `stream_members` row, which they are never given for meta. The read predicate enforces this directly as `kind == 'workspace-meta' AND role != 'guest'`. (Consequence for the M2 member-list projection: guests do not receive meta.)
```

### 3.4 — §4.2 rebuild is a single-transaction TRUNCATE+replay (EDIT the existing rebuild sentence)

**Anchor (append to the end of this paragraph, current line ~438):**
`**Server-side projections follow the same rebuild contract as clients:** \`msgctl rebuild-projections\` truncates \`messages_proj\` and replays \`events\`. CI runs it and diffs against incremental state (M0 exit criterion, kept forever).`

**Append these two sentences to that paragraph:**
```
 The rebuild is a **single transaction** — one `TRUNCATE messages_proj` followed by an ordered replay of `events` through `apply_projection`, committed once (ENG-69) — so it is atomic and safe to interrupt: a killed rebuild rolls back to the prior projection, never a partial one. `TRUNCATE` takes an `ACCESS EXCLUSIVE` lock that briefly blocks concurrent reads of `messages_proj` for the rebuild's duration, which is acceptable for a single-operator admin op at M1 scale; `DELETE FROM messages_proj` (ROW-EXCLUSIVE, MVCC-invisible to other snapshots until commit) is the documented drop-in should read-during-rebuild concurrency ever matter.
```

### 3.5 — §12 M1 simulation-suite subset seam (NEW note, insert immediately after the six-invariant list, after invariant 6 "Rebuild equivalence …", current line 614, before the "Plus: unit tests …" paragraph)

```
> **M1 ships a subset (ENG-71), M2 turns on all six.** The M1 exit gate ships the property-based harness asserting **four** of the six invariants on every example: idempotency (1), convergence (2 — the pull/log-equality half), cursor integrity (3), and permission isolation (4 — the adversary-client acceptance criterion, asserted every run and audited across the four live §3.6 enforcement points). **Pending settling (5)** and the projection-equivalence half of **rebuild equivalence (6)** are documented seams, not asserted at M1: invariant 5 needs the M2 web client's optimistic-render layer, and the projection-equivalence half is already held by the permanent M0/M1 `rebuild ≡ incremental` gates. The M1 skeleton's client-state model and invariant shapes are the M2 shapes, so **M2 extends this suite rather than rewriting it** — and M2's hard gate is exactly "all six green in CI."
```

### 3.6 — §15 deviations log (NEW bullet, append at the end of §15, after the current final ENG-62 bullet, line 657)

```
- **M1 exit-gate amendments (ENG-73, additive):** §3.3 records that the WebSocket authenticates via `Sec-WebSocket-Protocol: bearer, <token>` (raw token off the URL — no log/proxy/history leak; server echoes `bearer` on accept), superseding the `?token=` form; §3.2 adds the storability gate (envelope scalars — integer `type_version` within `INT4`, parseable RFC 3339 `client_created_at`, JSONB-safe strings — are rejected `invalid_schema` at accept even when the lax `Body` gate and the hash both pass, so "accepted" implies round-trippable storage); §2.2 clarifies that "every member" subscribed to `workspace-meta` means every **non-guest** member (§3.6 guest scope); §4.2 states the Postgres rebuild is a single-transaction `TRUNCATE messages_proj` + ordered replay, safe to interrupt; and §12 notes the M1 simulation suite asserts four of the six invariants (pending-settling and the projection half of rebuild-equivalence are M2). These are clarifications and within-milestone surface corrections of already-implemented behavior — no envelope field and no locked D-decision changed.
```

---

## 4. Review-carryover sweep — dispositions

Five hardening notes accrued across the M1 PR security reviews. Each triaged **fix-now / follow-up-ticket /
document-and-accept**. **Exactly one is fix-now.**

### A. WS debug-log wire-trace token shape — **FIX NOW (this PR)**

**Problem.** ENG-68 moved the WS token onto `Sec-WebSocket-Protocol: bearer, <token>` and added a message-string
scrub — but that scrub is `_QS_TOKEN_RE = re.compile(r"(?i)(token=)[^\s\"'&]+")`, which only matches the
**query-string** shape `token=…`. Under `uvicorn --log-level debug`, the ASGI scope / header list is printed and
the token now surfaces as `sec-websocket-protocol: bearer, <token>` (or a header tuple `(b'sec-websocket-protocol',
b'bearer, <token>')`) — a shape the current regex **does not match**. The leak class the scrub exists to close is
therefore re-opened at debug level.

**Ruling: fix-now.** It is ~5 lines, it is the exact belt-and-braces guarantee ENG-68 committed to ("no code path
should ever be able to log a token"), and leaving it as "debug-only, accept" would knowingly ship a token-to-log
path. Broaden the scrub in `server/msgd/logging.py`:

```python
# ENG-73: the WS token now rides `Sec-WebSocket-Protocol: bearer, <token>`
# (ENG-68). At `uvicorn --log-level debug` the ASGI header list is printed, so
# the query-string scrub above cannot reach it — scrub the subprotocol value
# shape too. The token alphabet is url-safe base64 (`token_urlsafe`), length 43,
# so require >=16 tchars after `bearer,` to avoid nuking a literal "bearer, foo".
_WS_BEARER_RE = re.compile(r"(?i)(bearer\s*,\s*)[A-Za-z0-9\-_]{16,}")
```

In `RedactSecretsFilter.filter`, apply both regexes to the rendered message (chain the `.sub()` calls, then pin
`record.msg`/`record.args` if either changed the string). Add a unit case to
`server/tests/test_no_secrets_in_logs.py` (file F): feed a record whose message is the debug wire-trace shape
(both the `sec-websocket-protocol: bearer, <tok>` string form and the header-tuple `repr` form) → formatted output
shows `bearer, [REDACTED]`, raw token absent. The exit-gate E2E (A6) is the end-to-end backstop but runs the
server at `INFO`; keep it at `INFO` (debug is very noisy and would bloat the captured log) — the unit test carries
the debug-shape coverage.

### B. WS inline-fanout ≤3 s uploader-latency tail — **DOCUMENT-AND-ACCEPT (defer)**

`hub.publish` is awaited inline post-commit, so a wedged recipient socket can add up to the per-send timeout to an
unrelated uploader's response tail. **Bounded** (slowest single send under `gather`, not N×timeout) and
**self-healing** (timed-out sockets deregister). This is exactly the §14 "single-process fanout ceiling" already
documented as the accepted M1 constraint and the first thing a post-M1 pub/sub layer relieves. **No code.** The
optional `ws_send_timeout_seconds` Settings knob stays deferred. (§14 already covers it — no new write-back
needed.)

### C. WS connect-time identity snapshot / session-revocation-mid-socket — **DOCUMENT-AND-ACCEPT (M2/M3)**

Per-send *membership* is live-checked (instant stream-removal revocation, tested); only workspace-role and
session-revocation are snapshotted at connect, so a revoked session keeps receiving fanout until its socket
closes. Tearing sockets down on revocation needs a hub signal that is future work. ENG-68 already added the
`Connection`/`_authenticate` docstring caveat scoping "instant revocation" to stream membership. **No ENG-73
action** beyond confirming that caveat is present; correctly M2/M3-scoped.

### D. ENG-65 reducer / `can_write` workspace-filter defense-in-depth — **FOLLOW-UP TICKET (orchestrator creates)**

ENG-66's review flagged that `insert.py`/`reducers.py`/`permissions.py` lack redundant workspace filters (the
primary genesis/homing gates make cross-tenant injection dead already; this is pure defense-in-depth). Touching
that partition is out of the exit-gate's scope and risks a merge with M1-frozen code. **Not fixed here.** The
orchestrator opens a Linear hardening ticket ("ENG-65 reducer/can_write workspace-filter defense-in-depth") in the
M2/M3 backlog. Record the pointer in the PR body.

### E. msgctl pulled-data semantic-trust + perpetual-`has_more` DoS — **DOCUMENT-AND-ACCEPT (trust boundary)**

`msgctl pull` loops until `has_more == false`; a hostile server returning perpetual `has_more: true` would loop
the client, and pulled bodies are trusted at their word. **This is a trust boundary, not a bug:** in M1 the server
is operator-run infrastructure the client authenticated to (the same relationship the M2 web client has). Adding
an arbitrary page-count ceiling would risk **silently truncating a legitimate large backfill** (cold-start
scrollback is legitimately many pages), so no cap is added. **No code.** Document the trust boundary in the pull
docstring / the PR body: msgctl trusts the server it logged into; `event_hash` still guarantees body **integrity**
(the server cannot forge a body without breaking the hash the client re-verifies at `verify`), so the trust is
scoped to availability/sequencing, not content authenticity. `workspace_id` cross-check on every pulled body
(already implemented, ENG-70) bounds cross-tenant smuggling.

**Fix-now list (the only code-behavior carryover): A — WS debug-log scrub broadening.**

---

## 5. Surfaced carryover not in the 7-point checklist — ENG-65 meta-type schema publish

**ENG-65 explicitly flagged for ENG-73** (its plan, "CROSS-CUTTING FLAG" + §Files): the `docs/schemas/` JSON-Schema
mirror for the M1 meta payload types (`workspace.created`, `user.joined/left`, `channel.created/renamed/archived`,
`channel.member_added/removed`, `dm.created`, …) is an M1-exit concern — ENG-65 shipped only the Pydantic models.
Today `docs/schemas/` holds just `envelope.schema.json` + `message.created.v1.schema.json`.

**Ruling: publish the schemas (mechanical, additive); defer per-type cross-language *vectors* to M2.** Extend the
existing `server/tests/generate_schemas.py` to emit one wrapped schema per registered payload model (iterate
`PAYLOAD_MODELS`, or an explicit list of the M1 meta + channel message types), write to `docs/schemas/<type>.v1.schema.json`
with the same deterministic serialization, and let `server/tests/test_schemas.py` freeze them byte-for-byte (the
generator is the single source of truth, models don't drift — exact ENG-62 discipline). This is high-value (the M2
web client and M5 plugin authors consume these) and low-risk. **Cross-language payload *test vectors* for the meta
types are deferred to M2**, when the TypeScript client actually consumes them — document the deferral in the PR
and note it as a §12 "schema round-trip tests per event type/version" item that lands with the TS implementation.
If the orchestrator judges this scope-creep for the gate PR, it can split into a tiny follow-up ticket — but the
generator extension is ~15 lines and belongs with the milestone lock.

---

## 6. Test plan

- **New:** `cli/tests/test_m1_exit_gate.py` (the gate; `integration`), `cli/tests/_e2e_server.py` (shared
  fixture). Meta-type schema files under `docs/schemas/` (frozen by the existing `test_schemas.py`).
- **Edited:** `cli/tests/test_remote_e2e.py` (re-point to shared fixture — assertions unchanged),
  `server/msgd/logging.py` + `server/tests/test_no_secrets_in_logs.py` (scrub broadening + unit case),
  `server/tests/generate_schemas.py` + `server/tests/test_schemas.py` (meta schemas).
- **Verify-only (must stay green, no change):** `uv run ruff check .`, `uv run ruff format --check .`,
  `uv run mypy`; the two equivalence-gate CI steps (M0/M1 permanent invariant); the `Simulation suite` step
  (ENG-71, four §12 invariants); the four §3.6 adversary tests audited in §2.2.
- **Full suite:** `uv run pytest --ignore=server/tests/simulation` (collects the new `integration` gate
  automatically — no CI yaml change).
- **Manual exit-gate evidence (record in the PR body as sign-off):**
  1. `test_m1_exit_gate.py` green — two clients converge under interleaved bidirectional traffic (item 1).
  2. Simulation suite green in CI (item 2).
  3. §3.6 enforcement matrix — four live points covered, files→M3 (item 3, §2.2 table).
  4. compose-up manual checklist passed from clean checkout + README updated (item 4, §2.4/§2.5).
  5. TDD write-backs landed (item 5, §3).
  6. Carryover A fixed; B/C/E documented; D → follow-up ticket (item 6, §4).
  7. Tag `m1` post-merge (item 7, §2.6).

---

## 7. Risks / open questions

- **Interleave nondeterminism in the gate.** The whole point is that two authors interleave, but the *assertion*
  must be deterministic. It is: convergence (byte-equal logs/dumps after a fixpoint pull) holds regardless of
  server-arrival order — that is the property under test. Do **not** assert a specific sequence assignment; assert
  A≡B and total message count. The last-pull-is-a-no-op check pins quiescence.
- **Shared-fixture extraction touches a passing test (D).** Re-pointing `test_remote_e2e.py` at the extracted
  fixture is pure refactor; keep its assertions byte-identical and run it green before/after. Low risk, but call
  it out so a reviewer doesn't read it as a semantic change.
- **Scrub regex over-match.** `_WS_BEARER_RE` requires ≥16 url-safe chars after `bearer,` so it can't eat a
  literal "bearer, foo" in prose; the real token is 43 chars. The unit test pins both the redaction and the
  non-match of a short benign string.
- **Meta-schema scope (§5).** Judgment call — ruled IN as mechanical. If it inflates the PR, split to a one-file
  follow-up; the milestone can tag without it, but publishing at M1-exit is the clean home per ENG-65's flag.
- **Tag targets the squash commit**, which only exists post-merge; the `git tag` step runs after merge and the
  Linear milestone flip follows the tag (orchestrator).
- **No structural §2/D-table change exists** (verified, sign-off finding 3). If a reviewer wants a field or
  D-decision change, that is a TDD revision and its own decision — **not** absorbed into this gate PR. Escalate to
  tech-lead.

---

## 8. Assignments

Everything → **python-engineer**: the E2E gate + shared fixture (B/C/D), the TDD write-backs (mechanical copy of
the verbatim §3 text into the cited anchors), the scrub broadening + test (E/F), the README (G), and the meta-type
schema publish (H). **No devops-engineer** work (compose-up is a manual PR-checklist item per §2.4). **No
ui-engineer** work. The `git tag -a m1` command (§2.6) and the Linear milestone flip are the orchestrator's,
post-merge.
