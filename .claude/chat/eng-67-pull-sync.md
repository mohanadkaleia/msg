# ENG-67 — M1: `GET /v1/events` (after/before pagination) + `GET /v1/sync`

**Milestone:** M1 — Sync server · **Priority:** High · **Status:** In Progress
**Branch:** `mohanad/eng-67-m1-get-v1events-afterbefore-pagination-get-v1sync`
**Refs:** TDD §3.2 (both contracts + cold-start), §3.6 (permissions / 404 discipline), §4.3 (page cap ≤ 500)
**Implementer:** `python-engineer` (entirely `server/`)

The pull side of the protocol. Cursors are the source of truth; WS push is only ever a hint (§3.3). This ticket ships the two read endpoints a reconnecting client needs: `GET /v1/sync` (one round trip → what to pull) and `GET /v1/events` (forward catch-up + backward backfill).

---

## Coordination with ENG-66 (upload) — parallel work

Both tickets are planned/implemented at the same time. Hard partition so they never touch the same lines:

| | ENG-66 (upload) | ENG-67 (this) |
|---|---|---|
| Routers | `routers/events_upload.py` | `routers/events_read.py`, `routers/sync.py` |
| Schemas | `schemas/events.py` (upload shapes) | `schemas/events_read.py` (read shapes) |
| Tests | its own | `tests/test_events_pull.py`, `tests/test_sync.py` |

- **Shared files are read-only consumption only** — no refactors of `events/permissions.py`, `events/insert.py`, `events/reducers.py`, `db/models.py`, `api/deps.py`, `api/problems.py`, `core/*`, `tests/authutil.py`, `tests/harness.py`. ENG-67 imports from them, never edits them.
- **Only shared edit: `api/app.py` router includes — append-only.** Both tickets append `include_router(...)` lines; merge is trivial (distinct lines, no reordering).
- **No dependency on ENG-66's endpoint in ENG-67 tests.** ENG-67 seeds streams/events directly at the DB layer via `insert_event` + `apply_reducer` (the exact pattern in `test_insert_event.py` / `test_permissions.py`), so the two tickets are independently testable and mergeable in either order.

---

## What already exists (merged on main — consume as-is)

- **`events/permissions.py::readable_streams_predicate(user_id, role, workspace_id)`** — the one shared SQL fragment. Already selects, in a single boolean over `streams`:
  - `workspace-meta` for non-guests;
  - **public channels for non-guests, no membership row required** (⇒ the public-channel browser is *already* covered — no union needed);
  - private/dm/guest via a live `EXISTS(stream_members)`.
  Guests fall through to the `EXISTS` branch alone (explicit-only; **no meta, no public browser** — the FLAGGED DEVIATION baked in ENG-65).
- **`api/deps.py::require_readable_stream(stream_id, ctx, db)`** — dependency, returns the validated `stream_id`, raises identical `404 /problems/not-found` for both unknown and unreadable (existence not disclosed, §3.6.2). Resolves `stream_id` from the **query string** when the route doesn't declare it as a path param — exactly our case.
- **`events/insert.py`** — `insert_event` bumps `head_seq` and inserts the `events` row in **one transaction**; `body` stored verbatim as JSONB; `hash_event(stored.body) == event_hash` proven by `test_insert_event.py::test_stored_body_rehashes_to_stored_hash`. Its private `_format_rfc3339(dt)` is the server-metadata timestamp format.
- **`db/models.py::Event`** — columns we read: `stream_id`, `server_sequence`, `event_hash`, `payload_redacted`, `server_received_at`, `body` (JSONB). **No `signature` column** ⇒ served `signature` is always `null`.
- **`db/models.py::Stream`** — `stream_id, kind, name, visibility, head_seq`; `StreamMember(stream_id, user_id)`.
- **Test harness** — `client` fixture (in-process ASGI, rolled-back txn), `db_session`, plus `authutil.do_setup/do_login/create_invite/accept_invite` for seeding principals.

---

## Decisions pinned

### 1. `GET /v1/events` — query params, window & `has_more` semantics

**Params**
- `stream_id: str` **required** — sourced via `Depends(require_readable_stream)`, which both authorizes (404 discipline) *and* yields the id used by the query. Missing → `422` (required query param).
- `after: int | None = None` (`Query(ge=0)`), `before: int | None = None` (`Query(ge=0)`).
- `limit: int = Query(500)` — **not** constrained by `ge/le` at the framework layer (that would 422); instead **clamped in code**: `effective = min(max(limit, 1), 500)`. Non-integer → `422` (framework int coercion). Default **500** (§4.3 pull-page cap; catch-up wants the biggest legal page).

**Direction rule (no-param default + XOR):**
| after | before | behavior |
|---|---|---|
| set | unset | forward catch-up |
| unset | set | backward backfill |
| **unset** | **unset** | **first page ascending from seq 1** (≡ `after=0`) — the "from start" default |
| set | set | **422** (`/problems/invalid-cursor`, constructed inline — see §Notes) |

**Window semantics (exact):**
- **`after=N` (forward):** events with `server_sequence > N`, ascending, up to `effective` of them (the *oldest* such — i.e. `[N+1 .. N+effective]` when dense).
- **`before=N` (backward):** events with `server_sequence < N`, the **newest `effective` of them, returned ascending**. Dense window = `[max(1, N-effective) .. N-1]`. Implementation: `WHERE seq < N ORDER BY seq DESC LIMIT effective+1`, then reverse to ascending.
- Both pages are **ascending within the page** regardless of direction (ticket contract).

**`has_more` (per direction, exact):**
- Compute with the **fetch `effective+1` rows** trick inside the single SELECT (snapshot-consistent, no second count query):
  - **forward:** fetch `effective+1` rows `seq > N ASC`; `has_more = (len > effective)` ⇒ **more NEWER events exist**; trim the extra (largest seq). Client advances with `after = last_returned_seq`.
  - **backward:** fetch `effective+1` rows `seq < N DESC`; `has_more = (len > effective)` ⇒ **more OLDER events exist**; trim the extra (smallest seq), then reverse. Client walks back with `before = first_returned_seq`.
- Empty page ⇒ `has_more=false` (`after≥head`, or `before≤1`).

**Response:** `{ "events": [<full stored envelope>...], "has_more": bool }`.

### 2. Envelope serialization — raw discipline (no model round-trip)

Each served event is **assembled from raw DB row values**, never regenerated through `core.Envelope`/`Body.model_dump`:

```python
{
  "body": row.body,                    # verbatim JSONB dict, straight through
  "event_hash": row.event_hash,        # column
  "signature": None,                   # no column; reserved-null (D1)
  "server": {
    "server_sequence": row.server_sequence,
    "server_received_at": _to_rfc3339(row.server_received_at),
    "payload_redacted": row.payload_redacted,
  },
}
```

- **Invariant guaranteed:** `hash_event(response["body"]) == response["event_hash"]` for **every** event including unknown-type events — because `body` is the same JSONB dict the hash was computed over (already proven hash-stable through JSONB in ENG-65). JCS re-canonicalizes on rehash, so served key order is irrelevant.
- **Response is served with `response_model=None`; the router returns a plain `dict`** (or an `EventsPage` model whose `events` field is typed `list[dict[str, Any]]` — Pydantic passes `dict`/`Any` through without coercing contents). Either way **nothing Pydantic touches `body`**. Ruling: use a typed `EventsPage(events: list[dict[str, Any]], has_more: bool)` so the shape is documented but body stays raw.
- `server_received_at` read back from `TIMESTAMPTZ` may carry µs precision vs. the ms string first served — acceptable: `server` is **unhashed** metadata (D1), not an integrity surface.

### 3. `GET /v1/sync` — shape, SQL, guest ruling

**Per-stream shape (task-ruled):** `{ stream_id, kind, name, visibility, head_seq, member }`. `name`/`visibility` are `null` for non-channel kinds. `member_user_ids` (TDD example, DMs) is **deferred**: no DM-creation path ships in M1, so DMs don't appear via sync in M1; the field re-enters with the M3 DM endpoint. Documented deferral.

**SQL — single snapshot SELECT, reusing the shared predicate (no union):**
```sql
SELECT s.stream_id, s.kind, s.name, s.visibility, s.head_seq,
       (m.user_id IS NOT NULL) AS member
FROM streams s
LEFT JOIN stream_members m
  ON m.stream_id = s.stream_id AND m.user_id = :caller_user_id
WHERE <readable_streams_predicate(user_id, role, workspace_id)>
ORDER BY s.stream_id;      -- stable ordering
```
- The predicate **already yields public non-member channels for non-guests**, so the "channel browser with `member:false`" needs no extra query — the `member` flag comes from the LEFT JOIN.
- `member` semantics: **public channel** → reflects join state (browser distinction, the load-bearing flag); **private/dm** → always `true` (only returned because a row exists); **`workspace-meta`** → always `false` by construction (meta access is role-based, not a `stream_members` row) — clients treat meta specially and ignore its flag. Document this in the docstring.
- **Guests:** predicate gives guests **only** explicit-membership streams — **no `workspace-meta`, no public browser**, every returned stream `member:true`. This is ENG-65's consistent ruling (guest = member with restricted scope). Pin + document in the docstring as the FLAGGED DEVIATION.

**Response:** `{ "streams": [SyncStream...] }`. `SyncStream` is a real typed model (built from DB columns — no raw-hash concern here).

### 4. Consistency — no torn reads

- **REPEATABLE READ is not needed.** Each endpoint reads within one request; a single SQL statement runs against one snapshot (Postgres default READ COMMITTED).
- **Sync:** all stream heads come from **one SELECT** ⇒ mutually consistent snapshot (no torn heads across streams).
- **Head never over-promises:** the accept path (`insert_event`) bumps `head_seq` **and** inserts the event row in the **same transaction** (D2). So any committed `head_seq = N` a reader sees has events `1..N` also committed/visible — a follow-up `GET /v1/events?before=N+1` cannot miss them. This is what "no torn reads" reduces to; pin it as: *per-request snapshot + atomic head/event write*.

### 5. 404 discipline

- **`/v1/events`:** mount `Depends(require_readable_stream)` — unknown stream and private-non-member stream both return the identical `404 /problems/not-found`; heads/existence never leak. Cross-workspace `stream_id` → predicate excludes it → 404.
- **`/v1/sync` never 404s** — it is a listing; unreadable streams are simply absent from the result (the predicate omits them). No stream id is an input.

### 6. Cold-start rule in docstrings (§3.2)

Both endpoint docstrings document the cold-start protocol: a new device pulls `GET /v1/sync`, then for each visible stream fetches the **newest page** (`before = head_seq + 1`), renders immediately, and backfills on scroll (`before = oldest_loaded`). **`workspace-meta` alone is always synced from sequence 1** (`after=0`) because the client needs full channel/member state. Forward catch-up (`after = last_contiguous_seq`) is the reconnect path.

### Notes / minor rulings
- **`_to_rfc3339`:** `insert.py::_format_rfc3339` is private to ENG-65's file (don't edit it). ENG-67 defines its own module-local `_to_rfc3339(dt)` in the read serializer, mirroring it exactly (accepted trivial duplication; post-M1 dedupe into `core/time.py` is a follow-up, not this ticket).
- **`invalid_cursor` (both-params → 422):** `problems.py` is a shared file we don't edit; construct the `ProblemException(status=422, type="/problems/invalid-cursor", title="Invalid cursor", detail="specify at most one of after/before")` **inline** in the router. (Optional post-M1 cleanup: promote to a named factory.)

---

## File list

**Create (ENG-67-owned):**
- `server/msgd/api/routers/events_read.py` — `GET /v1/events` router.
- `server/msgd/api/routers/sync.py` — `GET /v1/sync` router.
- `server/msgd/api/schemas/events_read.py` — `EventsPage(events: list[dict[str, Any]], has_more: bool)`, `SyncStream`, `SyncResponse`; the `_to_rfc3339` helper and page constants (`DEFAULT_LIMIT=500`, `MAX_LIMIT=500`) live here or in the router.
- `server/tests/test_events_pull.py` — pagination / window / has_more / clamp / 422 / 404 / raw-hash.
- `server/tests/test_sync.py` — sync shape / member flags / public browser / guest exclusion / head consistency / adversary.

**Edit (append-only, coordinated with ENG-66):**
- `server/msgd/api/app.py` — add `events_read, sync` to the `from msgd.api.routers import ...` line and two `app.include_router(...)` lines.

No migrations, no model changes, no edits to any shared module.

---

## Step-by-step (python-engineer)

1. **`schemas/events_read.py`** — response models. `EventsPage` with `events: list[dict[str, Any]]` (raw pass-through) + `has_more: bool`. `SyncStream(stream_id, kind, name: str|None, visibility: str|None, head_seq, member: bool)` + `SyncResponse(streams: list[SyncStream])`. Add `_to_rfc3339`, `DEFAULT_LIMIT`, `MAX_LIMIT`.
2. **`routers/events_read.py`** — `APIRouter(prefix="/v1", tags=["events"])`, `GET /events`:
   - Deps: `stream_id = Depends(require_readable_stream)` (authorizes + provides id), `ctx: CurrentAuth`, `db`, and `after/before/limit` Query params.
   - Reject both-set (inline 422). Clamp `limit`.
   - Build the SELECT per §1 (forward: `seq>after ASC LIMIT eff+1`; backward: `seq<before DESC LIMIT eff+1` then reverse; no-param ≡ `after=0`). Compute `has_more` from the +1 row; trim.
   - Assemble each event dict per §2 (raw body + server block). Return `EventsPage`.
   - Docstring: window/has_more semantics + cold-start (§6).
3. **`routers/sync.py`** — `APIRouter(prefix="/v1", tags=["sync"])`, `GET /sync`:
   - Deps: `ctx: CurrentAuth`, `db`.
   - Single SELECT per §3 (streams LEFT JOIN stream_members, filtered by `readable_streams_predicate(ctx.user_id, ctx.role, ctx.workspace_id)`, `ORDER BY stream_id`).
   - Map rows → `SyncStream`. Return `SyncResponse`.
   - Docstring: shape, guest ruling, meta-flag caveat, cold-start (§6).
4. **`app.py`** — append the two router includes.
5. **Tests** — `test_events_pull.py`, `test_sync.py` (below). Seed via `insert_event` + `apply_reducer` at the DB layer; principals via `authutil.do_setup/accept_invite`.
6. Run `pytest server/tests -q` (integration marker; Docker present in CI). Typecheck (mypy strict) + ruff.

---

## Test plan (pytest; seed via DB + `insert_event`/`apply_reducer`, drive via `client`)

**`test_events_pull.py`**
- **Gapless / duplicate-free across boundaries, both directions (property-ish):** seed a channel with M events (e.g. 23), page forward with `limit=10` following `after=last_seq` until `has_more=false`; assert the concatenation is exactly `[1..M]` — no gaps, no dupes. Repeat backward from `before=M+1` following `before=first_seq`; assert reversed concatenation is `[1..M]`. Do it for a `limit` that is/ isn't a divisor of M (boundary exactness).
- **Window exactness:** `after=N` returns `[N+1 .. min(N+limit, M)]` ascending; `before=N` returns the newest `limit` with `seq<N` ascending (`[max(1,N-limit) .. N-1]`). Assert exact seq lists at edges (`after=0`, `after=M`, `before=1`, `before=M+1`, `before=2`).
- **`has_more` both directions:** true when a further page exists, false on the last page (forward at head, backward at seq 1); assert the exact boolean at each boundary.
- **No-param default** = `after=0` first ascending page; **both params → 422** `/problems/invalid-cursor`.
- **`limit` clamping:** `limit=0`→1 row, `limit=99999`→≤500, `limit=-5`→1; negative/huge never error. `limit=abc`→422.
- **Raw-hash discipline (the load-bearing test):** for **every** event in a served page, `hash_event(item["body"]) == item["event_hash"]` — including a seeded **unknown-type** event (e.g. `type="x.custom"` with an arbitrary payload) to prove opaque bodies survive. Assert `item["signature"] is None` and `item["server"]["server_sequence"]` matches.
- **404 discipline:** private stream the caller isn't a member of → `404 /problems/not-found`; unknown `stream_id` → identical 404; missing `stream_id` → 422.

**`test_sync.py`**
- **Shape / member flags:** seed meta + public(joined) + public(not joined) + private(member) + private(non-member) + (optionally a reducer-created dm). For a `member` user assert: meta present (`member:false`), joined public `member:true`, un-joined public present `member:false`, private-member present `member:true`, private-non-member **absent**. Assert `name/visibility` null on meta.
- **Public browser:** an un-joined public channel appears with `member:false`.
- **Guest exclusion:** a guest with an explicit private membership sees **only** that stream (`member:true`); **no meta, no public browser**.
- **Head consistency (no torn reads):** seed a stream, read `head_seq` via sync, then `GET /v1/events?before=head+1` returns exactly `head` events with contiguous seqs — head never over-promises. (Committing-session concurrency variant optional, mirroring `test_insert_event::test_gapless_under_concurrency`.)
- **Adversary:** a non-member user's sync response contains **no** private stream id and **no** private head; and `GET /v1/events` on that private stream → 404. Assert absence of the id anywhere in the payload (heads not leaked).
- **`/v1/sync` never 404s / always 200** even with only meta visible.

---

## Risks / open questions

- **JSONB key-order / number normalization:** already proven hash-stable in ENG-65 (`test_stored_body_rehashes_to_stored_hash`). Our raw-serve path re-uses that exact guarantee; the unknown-type raw-hash test re-asserts it at the endpoint. Low risk.
- **`response_model` vs. raw body:** typing `events` as `list[dict[str, Any]]` keeps Pydantic away from `body`. If a future reviewer wants a typed `EventOut`, it must keep `body: dict[str, Any]` (never `Body`) or it would re-coerce — call this out in the code comment. Low risk.
- **`member` flag on `workspace-meta` (always false):** semantically odd but harmless and documented; clients special-case meta. Accepted.
- **DM `member_user_ids` omitted from sync in M1:** deferred with the M3 DM endpoint (no DM creation path exists in M1). Documented deviation from the §3.2 example; revisit at M3.
- **`_to_rfc3339` duplication** with `insert.py`: accepted; post-M1 dedupe into `core/time.py`. Not this ticket (would touch a shared file).
- **`invalid_cursor` inline vs. factory:** inline to avoid editing shared `problems.py`; optional cleanup later.
- **Two queries on `/v1/events`** (`require_readable_stream`'s `can_read` SELECT + the events SELECT): acceptable at M1 scale; both cheap indexed lookups. No optimization needed.

---

## Summary for the record

- **Window/has_more:** `after=N` → `seq>N` ascending (oldest-first, `[N+1..N+limit]`), `has_more` = more NEWER; `before=N` → newest `limit` with `seq<N`, returned ascending (`[N-limit..N-1]`), `has_more` = more OLDER. Both computed via a single `LIMIT effective+1` SELECT. Both pages ascending within the page.
- **No-param ruling:** neither → first ascending page from seq 1 (≡ `after=0`); both → `422 /problems/invalid-cursor`. `limit` default 500, **clamped** to `[1,500]`.
- **Serialization (raw discipline):** response assembled from raw DB values — `body` verbatim JSONB dict, `event_hash`/`payload_redacted`/`server_received_at` from columns, `signature` always null; **never** through `Envelope`/`Body.model_dump`. Guarantees `hash_event(served body)==event_hash` incl. unknown types. Served with `response_model` whose `events` is `list[dict[str,Any]]`.
- **Sync SQL:** one snapshot `SELECT streams LEFT JOIN stream_members` filtered by the shared `readable_streams_predicate`, `ORDER BY stream_id`. Public browser + meta come free from the predicate — no union. `member` = LEFT-JOIN existence. **Guests: explicit memberships only — no meta, no public browser** (all `member:true`).
- **Files:** create `routers/events_read.py`, `routers/sync.py`, `schemas/events_read.py`, `tests/test_events_pull.py`, `tests/test_sync.py`; append-only edit to `app.py`. No shared-file edits, no migrations.
- **Risks:** all low — JSONB hash-stability is pre-proven; raw-body typing keeps Pydantic off `body`; `member:false` on meta and omitted DM `member_user_ids` are documented deferrals.
