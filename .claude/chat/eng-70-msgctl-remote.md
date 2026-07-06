# ENG-70 — M1: `msgctl` remote mode (login, push/pull against a live server)

**Tech-lead plan. Implementer: `python-engineer` (all parts — `cli/` only).**
**Do NOT implement from this file; it is the contract for the implementation PR.**

This is the client that **demonstrates the M1 exit criterion** (TDD §13):

> "Two `msgctl`-driven clients converge over the real server."

Two `msgctl` workspaces on one server, each authored-and-synced independently,
end up with **byte-identical stream logs** and **byte-identical `project`
dumps**, and `msgctl verify` is green on both. ENG-70 builds the client half;
ENG-73 owns the full E2E harness that drives it. This ticket ships enough of an
E2E (unit + a live-server integration test) to prove each piece.

---

## 0. What changes, at a glance

`msgctl` gains a **remote mode**. A *remote workspace* is a normal M0 workspace
(same `workspace.json` + `streams/<id>/<YYYY-MM>.ndjson` layout, same
`verify`/`project`/`rebuild`) whose identity is **bound to a live server** and
which carries three new sidecar stores under a gitignored `.msgctl/` dir:
credentials (the raw bearer token), a per-stream pull cursor, and an outbox of
locally-authored-but-not-yet-pushed event bodies.

New subcommands (all appended to `cli.py`): `login`, `push`, `pull`, `invite`.
`send` gains a one-line branch: in a remote workspace it enqueues to the outbox
instead of appending a locally-sequenced line to the log.

**The governing rule (the hard design call, §3 below):**
> In a remote workspace the server is the sole sequencer. The synced log
> (`streams/<id>/*.ndjson`) holds **only server-served envelopes**, written
> exclusively by `pull`. Locally-authored events live in a **separate outbox**
> and never touch the synced log until they come back down through `pull` as the
> server's authoritative copy. This is exactly the web client's outbox model
> (TDD §5.3) and it is what keeps `verify`/`project`/`rebuild` green at all times.

---

## 1. Ruling — HTTP client: **httpx as a `cli` runtime dependency**

Add `httpx` to `cli/pyproject.toml` `[project].dependencies`.

- `msgctl` remote mode is genuinely an HTTP client now: bearer-authenticated
  POST of event batches with **timeouts and a retry loop**, GET with query
  params, streaming-friendly, RFC 9457 problem+json error bodies to decode.
  `urllib` can do it, but retries/timeouts/connection-reuse/error-mapping become
  a few hundred lines of hand-rolled boilerplate for no dependency saving that
  matters here.
- The "keep the CLI light" concern was about **not pulling server-only deps**
  (FastAPI/SQLAlchemy/asyncpg). That ship has already sailed: per the ENG-63 D-1
  note in `server/pyproject.toml`, `msgctl` depends on `msgd` via the workspace,
  so the whole server stack already flows into a `msgctl` install. `httpx` is a
  small, well-vetted addition on top of an already-heavy graph (and it is
  already present transitively — Starlette's `TestClient`, used by the server
  test suite, is built on `httpx`).
- **Rejected:** stdlib `urllib` (more code, clunkier timeout/retry/error
  handling, zero real footprint win).
- M6 note (unchanged from ENG-63): when the desktop client must not ship
  FastAPI, extract an `msgd-core` workspace member; `httpx` stays with the CLI.

Use a synchronous `httpx.Client` (msgctl is a sequential CLI; no asyncio).
Configure an explicit connect+read timeout and reuse one client per command.

---

## 2. Ruling — Credentials & remote binding (secret-safe, 0600, gitignored)

All remote state lives under **`<workspace>/.msgctl/`** (a new dir, sibling of
`workspace.json` and `streams/`, **outside** `streams/` so it is invisible to
`verify`/`project`/`export`, which enumerate `streams/<id>/*.ndjson` +
`workspace.json` only — never the root):

| File | Perms | Secret? | Contents |
|---|---|---|---|
| `.msgctl/credentials.json` | **0600** | **yes** | `{ "token": "<raw bearer>", "expires_at": "..." }` |
| `.msgctl/remote.json` | 0644 | no | `{ "server_url", "workspace_id", "user_id", "device_id", "role", "meta_stream_id" }` |
| `.msgctl/cursors.json` | 0644 | no | `{ "<stream_id>": <last_pulled_seq>, ... }` |
| `.msgctl/outbox.ndjson` | 0644 | no | one `{ "body": {...}, "event_hash": "..." }` per line, FIFO |

Rulings:

1. **The raw token is stored, and that is correct — clarifying pin 6's "never
   written unhashed".** A bearer-token client *must* hold the raw token; there is
   nothing to hash it against (the **server** stores only `sha256(token)` in
   `sessions.token_hash` — the client is the other half of the pair). The
   acceptance-criterion intent is therefore: **file perms 0600, never logged,
   never printed to stdout, never committed to git** — *not* "hashed on disk".
   State this in the PR so review doesn't chase a phantom requirement.
2. **0600 is enforced at create time**, not chmod-after: write via
   `os.open(path, O_CREAT|O_WRONLY|O_TRUNC, 0o600)` (a later `os.chmod` leaves a
   world-readable window). Reuse the atomic temp-file + `os.replace` +
   `_fsync_dir` discipline already in `workspace.write_manifest`; the temp file
   is opened 0600 too.
3. **Never log/print the token.** The `client.py` error path must not dump
   request headers. `login` prints only non-secret identity fields.
4. **`.gitignore`.** `login` writes/updates a workspace-root `.gitignore` to
   include `.msgctl/` and `projections.sqlite3*`. (`streams/` and
   `workspace.json` stay tracked — the log is meant to be shareable.)
5. **`device_id` is server-minted and reused.** `login`/`setup`/`accept-invite`
   return `device_id` in `LoginResponse`; store it in `remote.json`. On a
   subsequent password `login`, send it back as `LoginRequest.device_id` so the
   same `devices` row is reused (the server's `mint_or_reuse_device` honors it).
   `setup`/`accept-invite` always mint (they take no `device_id`).
6. `is_remote(ws)` ≡ `.msgctl/remote.json` exists. Drives the `send` branch and
   guards `push`/`pull` (a non-remote workspace → clean `UsageError`).

---

## 3. Ruling — The push reconciliation model (THE hard call)

**Chosen: option (b), the two-store outbox model. Rejected: option (a),
rewrite-the-log-in-place.**

### Why (a) is wrong
M0 `send` assigns a **local provisional** `server_sequence` by scanning the
local log (`append._scan_stream`). The server assigns its **own** authoritative
sequence, and stamps its own `server_received_at`. So the server's copy of an
event is **byte-different** from the local provisional line (different seq,
different `server` metadata), even when the numeric sequence happens to match.
If `pull` then appended the server copy into the *same* stream file that already
holds the provisional line, you get **two lines with the same `server_sequence`
and/or the same `event_id`** → `verify` fails (`duplicate` / `duplicate_event_id`),
and the log is no longer byte-equal to what a second client pulls. Rewriting an
append-only, torn-write-safe, gapless-from-1 log in place to "fix" this is
fragile and breaks the very invariants `verify` exists to defend, mid-flight.

### The model (b), precisely
A remote workspace keeps **two physically disjoint stores**:

1. **Synced log** — `streams/<server_stream_id>/<YYYY-MM>.ndjson`. Contains
   **only** envelopes served by the server, written **only** by `pull`,
   **verbatim** (byte-faithful). `verify`/`project`/`rebuild` run against this
   and stay green because it *is* the server's gapless, valid-hash truth.
2. **Outbox** — `.msgctl/outbox.ndjson`. Locally-authored `{body, event_hash}`
   items with **no `server` metadata**, awaiting upload. Written by remote
   authoring (`send` → outbox), drained by `push`.

The reconciliation loop:

```
send  → build body via core.build_message_created_body + hash_event
      → append {body, event_hash} to outbox      (NO server metadata, NO seq)
push  → read outbox FIFO, batch ≤100 items / ≤1MB
      → POST /v1/events/batch  { "events": [ {body, event_hash}, ... ] }
      → 200 { accepted[], rejected[] }
          accepted[i] → server assigns the real server_sequence; remove that
                        event_id from the outbox (it will arrive in the log via pull)
          rejected[i] → permanent (permission_denied/invalid_schema/hash_mismatch/
                        payload_too_large/unknown_stream): report + remove; exit nonzero
      → transient failure (network/timeout/5xx/429) → bounded backoff, RETRY the
        SAME batch (same event_ids). Server idempotency (UNIQUE(workspace_id,
        event_id)) returns the ORIGINAL accepted record — no duplicate. Dumb loop.
pull  → the accepted events come back down as the server's authoritative copy and
        land in the synced log (§4). The outbox never writes the log.
```

**Key consequence — remote `send` does not use the M0 log-append path.** In a
remote workspace, authoring targets the outbox. This is a small branch at the top
of `cmd_send`; `append.append_event` / local sequencing is untouched and remains
the M0-standalone path.

### Identity binding (load-bearing — the server enforces it)
`server/msgd/events/validate.py` step ii rejects (`permission_denied`) any event
whose `body.workspace_id != ctx.workspace_id`, `body.author_user_id !=
ctx.user_id`, or `body.author_device_id != ctx.device_id`. A pure-M0 workspace
mints its *own* `workspace_id` / `user_id` / `device_id`, so its events are
**un-pushable** — they'd all be `permission_denied`.

Therefore `login` **binds the workspace identity to the server's**: it rewrites
`workspace.json`'s `workspace_id` and `local_author` (`user_id`, `device_id`) to
the values from `LoginResponse`. All remote authoring then builds bodies with the
server identity, and the batch is accepted. Rule: **`login` initializes a *fresh*
remote workspace** (like `init`, but with server identity + credentials). It
refuses to bind over a workspace that already has locally-authored M0 log events
under a different identity (that would orphan them) — clean error, no clobber.

### Streams (client-minted ids, auto-create — reuses M0 machinery)
The server allows **client-minted stream ids** for `channel.created`
(`payload.channel_stream_id` is validated as a stream id and genesis-collision
checked; the reducer creates the row with that id). A public `channel.created`
must be **homed in `workspace-meta`** (`body.stream_id == meta_stream_id`); the
reducer creates the channel with `stream_id == channel_stream_id`.

So remote auto-create mirrors M0's `resolve_or_create_stream` exactly:
- First `send --stream general` to an unknown name: mint an `s_` id locally,
  register it in `workspace.json` (name→id, same as M0), **and** enqueue a
  public `channel.created` (homed at the cached `meta_stream_id`,
  `channel_stream_id = s_general`) to the outbox, **then** enqueue the
  `message.created` (`stream_id = s_general`).
- Because the outbox is FIFO and `upload_batch` commits **per event in array
  order**, a single batch `[channel.created, message.created, ...]` commits the
  channel first (creating the stream) so the message validates against the now-
  existing stream. No two-phase push needed.
- The channel's server `stream_id` equals the client-minted `s_general`, so the
  local registry name→id already matches the server → after `pull`, the synced
  log dir is `streams/s_general/`, identical across clients.
- **A second client resolves the same channel from `pull`, never re-creating
  it:** `pull` registers each pulled channel (name from `/v1/sync`) into
  `workspace.json`, so `send --stream general` on client B resolves B's existing
  `s_general` (A's id) and enqueues only a `message.created` — no duplicate
  channel. (Operational assumption, flagged §8: author into a channel *after*
  pulling it, else two same-named channels with different ids are created — a UX
  quirk, not a convergence bug; msgctl is an ops/demo client, not the web UX.)

---

## 4. Ruling — Pull cursor model + verbatim append

`pull` produces a **complete, verifiable mirror** (not the web client's
newest-page-first cold-start): msgctl's job is the full byte-equal log the E2E
asserts, so it pulls **every stream from sequence 1 forward**.

```
GET /v1/sync → streams[] { stream_id, kind, name, visibility, head_seq, member }
for each stream (all returned are readable):
    register it in workspace.json if absent (name from sync; workspace-meta gets
        the reserved name "workspace-meta"; kind/created_at filled)
    cursor = cursors[stream_id]  (0 if new)
    loop:
        GET /v1/events?stream_id=<id>&after=<cursor>&limit=500
        → { events[], has_more }
        append each event VERBATIM to streams/<id>/<server_received_at[:7]>.ndjson
        cursor = events[-1].server.server_sequence
        persist cursors.json (durably, after the page's bytes are fsynced)
        if not has_more: break
```

Rulings:

1. **Cursor store: sidecar `.msgctl/cursors.json`** (map `stream_id →
   last_pulled_seq`), *not* `workspace.json`. Keeps the M0 manifest a pure
   registry (no denormalized head to drift — its whole point) and keeps cursors
   out of the export/verify walk.
2. **`workspace-meta` from seq 1** (initial cursor 0 ≡ `after=0`), consistent
   with the general "from seq 1" rule; the client needs full channel/member
   state anyway. Every other stream also from seq 1 (msgctl wants the whole log,
   not the UX newest-page optimization).
3. **Month partition must match `append.py`:** write each envelope to
   `<server_received_at[:7]>.ndjson`. Both clients derive the month from the same
   server-supplied `server_received_at` string → identical file split → byte-equal
   logs even across month boundaries.
4. **Verbatim, deterministic serialization.** The server's `/v1/events` response
   already has the exact stored shape `{body, event_hash, signature:null,
   server:{...}}` (`events_read._serialize_event`). Write each event dict with
   the **same** compact form the log writer uses:
   `json.dumps(evt, ensure_ascii=False, separators=(",",":"))` + `"\n"`. `body`
   comes back from Postgres JSONB (key-order normalized, identical for every
   client), so A's and B's lines are byte-identical; and `hash_event` re-
   canonicalizes (JCS) so the stored key order never affects the hash check.
5. **Crash-safe append + cursor lockstep.** Advance+persist a stream's cursor
   **only after** its page bytes are `fsync`ed. On resume, re-fetch `after=cursor`
   → already-written events (`seq ≤ cursor`) are not re-fetched, so no double-
   append. Before appending a page, repair any torn trailing line in the target
   month file (same `_repair_torn_line` semantics as `append.py`) so an
   interrupted prior write can't fuse with the new page. Hold the per-stream
   `flock` around a stream's append+cursor bump.
6. **Registry cross-check.** `verify._cross_check_registry` **fails** on an on-
   disk stream dir with events but no `workspace.json` entry
   (`unregistered_stream_dir`). So `pull` must register every stream it writes.
   `workspace-meta` needs a non-null name for the registry's unique-name index →
   reserve `"workspace-meta"`.
7. After `login`/`setup`/`accept-invite`, do one `GET /v1/sync` to validate the
   token and discover + cache `meta_stream_id` in `remote.json` (needed for
   `channel.created` homing).

---

## 5. Ruling — M0-workspace compatibility (verify/project/rebuild stay green)

Confirmed against the M0 stack (`verify.py`, `projection.py`, `rebuild.py`,
`append.py`):

- **Hash faithfulness (D1):** `verify` recomputes `hash_event(raw["body"])` and
  compares to the stored `event_hash` string. The server stores `body` verbatim
  (JSONB) and serves it raw; `hash_event` canonicalizes via JCS, so
  `hash_event(served body) == event_hash` holds for every event — including
  unknown/future types (opaque bodies survive untouched). ✅
- **Sequence integrity (D2):** server sequences are gapless-monotonic-from-1 per
  stream; `pull` fetches `after=0` forward with no gaps → the log is contiguous
  from 1 → `verify` gap/duplicate/out-of-order checks pass. ✅
- **`workspace_id` cross-check:** every pulled `body.workspace_id` is the server
  workspace id, which `login` wrote into `workspace.json` → matches. ✅
- **`project`/`rebuild`:** iterate `sorted(ws.streams)` and read
  `streams/<id>/*.ndjson` via the read-only walk. Pulled streams are registered
  (ruling 4.6) and their dirs are keyed by server `stream_id` — a freshly pulled
  workspace legitimately has stream dirs it did not create via `send`; that is
  fine, they are keyed by id, exactly like an M0-authored dir. `dump_messages`
  is a deterministic pure function of identical logs → identical dumps across
  clients → `rebuild ≡ incremental` and A-vs-B equality both hold. ✅
- **`payload_redacted`:** the server sets it `false` in M1 (no redaction
  authority yet); `verify` still fails on a truthy flag — never triggered. ✅
- **Sidecars invisible:** `.msgctl/` and `projections.sqlite3*` sit at the
  workspace root, outside `streams/`; `verify`/`project`/`export` enumerate
  `streams/<id>/*.ndjson` + named manifests only, never globbing the root. ✅

**No change to any M0 module's read/verify/project/rebuild logic is required or
permitted.** ENG-70 is purely additive plus the one `cmd_send` branch.

---

## 6. File list (all `python-engineer`, `cli/` only)

**New modules** under `cli/msgctl/`:

- `client.py` — `httpx`-based `MsgClient(server_url, token=None)`:
  `setup(...)`, `login(...)`, `accept_invite(...)`, `create_invite(role)`,
  `get_sync()`, `get_events(stream_id, after, limit)`, `post_batch(items)`.
  Bearer header injection; explicit timeouts; a `_retry(fn)` helper for
  transient (network/timeout/5xx/429) failures with bounded exponential backoff;
  problem+json → typed `MsgctlError` mapping (401 → auth error, 404 → not-found,
  etc.). Never logs headers/token.
- `credentials.py` — `.msgctl/` layout constants; `write_credentials` (0600
  atomic), `read_credentials`, `write_remote_binding`, `read_remote_binding`,
  `is_remote(ws)`, `.gitignore` upsert. No secret ever returned to stdout.
- `outbox.py` — `enqueue(ws, body, event_hash)` (atomic append), `read_all(ws)`
  (FIFO), `remove(ws, event_ids)` (compact-rewrite via temp+replace, order
  preserved). Torn-line safe.
- `sync.py` — the two engines: `push(ws, client)` (drain outbox in ordered
  batches, idempotent retry, per-event accept/reject handling) and `pull(ws,
  client)` (sync → per-stream paginated verbatim append → registry update →
  cursor advance). Owns the verbatim writer (`_repair_torn_line` reuse, fsync,
  per-stream flock) and the cursor file I/O.
- `remote.py` — command orchestration + remote authoring: `cmd_login`,
  `cmd_push`, `cmd_pull`, `cmd_invite`, and `cmd_send_remote` (build
  message.created body → auto-create channel into outbox if the stream name is
  new → enqueue). Reuses `workspace.resolve_or_create_stream` for the registry
  mutation, adding the `channel.created` enqueue for a newly-created stream.

**Edits:**

- `cli/msgctl/cli.py` — **append** `login`/`push`/`pull`/`invite` subparser
  blocks + `set_defaults(handler=...)` at the end of `build_parser`
  (self-contained, per the §6 append-only protocol); add a **one-line branch**
  at the top of `cmd_send`: `if credentials.is_remote(ws): return
  remote.cmd_send_remote(args)`. Import `remote`/`credentials`.
- `cli/pyproject.toml` — add `httpx` to `[project].dependencies`.

**Optional tiny helper** (implementer's discretion): fold cursor I/O into
`sync.py` (listed there) rather than a separate `cursors.py`.

`workspace.py` is **not** edited (remote authoring reuses `resolve_or_create_stream`
as-is; the channel.created enqueue lives in `remote.py`). Keeping `workspace.py`
untouched minimizes M0 blast radius.

---

## 7. Step-by-step

1. **pyproject** — add `httpx` runtime dep to `cli/`.
2. **`credentials.py`** — `.msgctl/` layout, 0600 credential writer, remote
   binding, `is_remote`, `.gitignore` upsert. Unit-test perms == 0600 and that
   the token never appears in any human/JSON output helper.
3. **`client.py`** — `MsgClient` with timeouts + retry + problem+json mapping.
   Unit-test against a stub transport (`httpx.MockTransport`) for: bearer header
   present, retry-on-5xx, no-retry-on-4xx-reject, header/token never logged.
4. **`outbox.py`** — enqueue/read/remove (FIFO, atomic, torn-safe). Unit tests.
5. **`sync.py` — `pull`** — sync + paginated verbatim append + registry update +
   cursor lockstep + torn-repair + fsync. Unit-test the verbatim writer produces
   the exact compact line shape and correct month partition; cursor resume skips
   already-pulled seqs.
6. **`sync.py` — `push`** — ordered batching, accept→outbox-remove,
   reject→report+remove+nonzero, transient→retry. Unit-test idempotent retry (a
   re-pushed batch removes the same event_ids, no error).
7. **`remote.py`** — `cmd_login` (setup/login/accept-invite modes → bind
   identity, write creds, initial sync to cache `meta_stream_id`, write
   `.gitignore`), `cmd_invite`, `cmd_send_remote` (auto-create channel into
   outbox), `cmd_push`, `cmd_pull`.
8. **`cli.py`** — append the four subparser blocks + the `cmd_send` remote
   branch; wire handlers.
9. **Live integration test** (`cli/tests/test_remote_e2e.py`, marked; spins the
   real ASGI app + ephemeral Postgres via the server test fixtures, or an
   in-process ASGI transport): drive the full loop and assert the exit criterion
   (§9). Coordinate the fixture with ENG-73 (which owns the milestone E2E).

---

## 8. Risks & open questions

1. **Identity rebinding on `login`** is the subtle correctness hinge — if bodies
   aren't authored with the server `workspace_id`/`user_id`/`device_id`, every
   push is `permission_denied`. Mitigation: `login` rewrites `workspace.json`
   identity from `LoginResponse`; `cmd_send_remote` reads it; an integration test
   asserts a real 200-accept, not a mock.
2. **Auto-create channel ordering / same-name divergence.** Authoring into a
   channel *before* pulling it creates a second same-named channel (different
   id). Not a convergence bug (both logs still verify and, given identical
   operations, converge), but a UX quirk. Flag as a documented M1 operational
   assumption: pull before authoring into a peer's channel. The E2E sequences
   operations to avoid it.
3. **Member vs. owner channel creation.** The E2E has the owner (via `setup`)
   create channels; whether a plain `member` may create a public channel depends
   on the server's `can_write` matrix (ENG-65). If members can't, a member's
   auto-create push rejects — surfaced clearly, not silently. Confirm the server
   policy during integration; keep the E2E owner-creates-channel.
4. **Password on argv** leaks via the process table. Prefer `MSGCTL_PASSWORD` env
   or an interactive `getpass` prompt; allow `--password` for tests but document
   the safer path. Never echo it.
5. **Torn pull / cursor-lockstep.** Getting the "fsync page, then persist cursor"
   order wrong risks either re-appended duplicates or a skipped event. Covered by
   an explicit resume test that kills between page-write and cursor-persist.
6. **Byte-equality depends on the server's deterministic serialization.** Relies
   on Postgres JSONB key-order normalization being identical for both clients
   (it is) and on both clients using the identical compact line writer. Asserted
   directly (A-vs-B `diff` of every month file) in the E2E.
7. **httpx dep addition** touches `cli/pyproject.toml` — coordinate the lockfile
   regen with whoever owns CI dep pinning; no other in-flight ticket edits
   `cli/pyproject.toml` (ENG-72 is compose/devops).

---

## 9. Test plan (pytest; hypothesis not required here)

Unit (fast, no server): credentials perms/secret-hygiene; `client` retry/no-
retry/header; outbox FIFO/atomic/torn; pull verbatim-writer shape + month split
+ cursor resume; push idempotent-retry.

Integration (`test_remote_e2e.py`, live ASGI + ephemeral Postgres — shared with
ENG-73), asserting the **M1 exit criterion**:

1. Workspace A: `login --setup` → owner; `send --stream general --text ...` (×N);
   `push`. Workspace B: `login --invite-token` (invite minted by A via
   `msgctl invite`); `pull`; `send --stream general --text ...`; `push`.
   A: `pull`.
2. **Assert:** every `streams/<id>/<month>.ndjson` is **byte-identical** between
   A and B; `project` on each → **byte-identical `dump_messages`**; `verify`
   exits 0 on both.
3. **Idempotency:** re-run A's `push` with an outbox artificially re-seeded with
   an already-accepted item (or kill push mid-batch and re-run) → server returns
   the original sequence, **no duplicate** event in the log; `verify` still 0.
4. **Rebuild equivalence** (the permanent CI invariant): `rebuild` on the pulled
   workspace equals incremental `project`.

---

## 10. Coordination — cli.py collision with ENG-69 (FLAGGED)

ENG-68/69/71 run in parallel; ENG-70 is `cli/`-only and otherwise disjoint
(they're `server/`+tests). The **one** shared-file risk is `cli/msgctl/cli.py`:

- **ENG-70** appends `login`/`push`/`pull`/`invite` subparser blocks (+ handlers)
  and adds a one-line remote branch in `cmd_send`.
- **ENG-69** may add a `msgctl rebuild-projections` subcommand.

**Rule (same as the ENG-58/59/60 protocol already in `cli.py`):** both append a
**self-contained** subparser block at the end of `build_parser` +
`set_defaults(handler=...)` + a distinct `cmd_*` handler; **second-to-merge
rebases**. Subcommand namespaces are disjoint by construction
(`rebuild-projections` vs `login`/`push`/`pull`/`invite`) and the handler
function names don't collide. ENG-70's `cmd_send` branch is unique to ENG-70 and
touches no surface ENG-69 edits. Coordinate only the trivial merge order of the
two appended blocks and the shared import line. `cli/pyproject.toml` is edited by
ENG-70 alone.
```
