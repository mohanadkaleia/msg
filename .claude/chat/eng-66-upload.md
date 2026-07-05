# ENG-66 — M1: POST /v1/events/batch — validation pipeline, per-stream sequencing, idempotency

**Ticket:** ENG-66 (M1, High). **Role:** tech-lead planning. **Implementers:** `python-engineer` (all of it — `server/` only).
**Depends on:** ENG-63 (schema), ENG-64 (auth: `require_auth`/`CurrentAuth`, `rate_limit` factory, `RateLimiter`, problem+json), ENG-65 (`insert_event`, `emit_event`, `apply_reducer`/`REDUCERS`, `can_read`/`can_write`/`readable_streams_predicate`, `core/payloads/meta.py`, `hash_event`).
**Runs in parallel with:** ENG-67 (pull/sync). **Blocks:** M1 exit (two `msgctl` clients converge), ENG-68 (WS push).

---

## 0. Scope ruling (read first)

ENG-66 builds the **real sequencer** — the `POST /v1/events/batch` endpoint that wraps ENG-65's `insert_event`/`emit_event` primitives in the full §3.2 validation pipeline, per-event accepted/rejected shaping, and idempotency. It is almost entirely mechanical because ENG-63/64/65 already locked the hard parts (hashing discipline, sequence primitive, reducers, permission predicate). ENG-66's job is to **compose** them in the exact §3.2 order and shape.

**ENG-66 owns (and only these files):**
1. `api/routers/events_upload.py` — the endpoint (write half only; a filename that cannot collide with ENG-67).
2. `events/validate.py` — the per-event validation pipeline (read-only checks → `Accepted`/`Rejected` outcome).
3. `api/schemas/events.py` — the §3.2 request/response shapes + the five-code enum.
4. `events/fanout.py` — the ENG-68 WS seam: a no-op `publish_event(envelope)`.
5. Its tests.

**Partition with ENG-67:** ENG-67 owns `api/routers/events_read.py` + `api/routers/sync.py`. ENG-66 does **not** touch them. Shared-surface edits (mounting, limiter wiring) are additive and coordinated — see §Risks.

**ENG-66 does NOT touch (read-only consumption; duplicate minimally or flag if a helper is missing):**
- `events/permissions.py`, `events/insert.py`, `events/reducers.py`, `events/emit.py`, `core/hashing.py`, `core/envelope.py`, `core/payloads/*` — consumed, never edited.
- No WebSocket / `ws/` — ENG-68. ENG-66 ships the seam only (§D9).
- No `messages_proj` population — `message.created` still has **no reducer** in M1 (search/message-API projection is a later ticket). Convergence is via the event log, not the projection. Documented.
- No Alembic migration (tables exist).

---

## Implementation Plan

### D1 — Request/response schemas (`api/schemas/events.py`) — §3.2 exactly

```python
RejectionCode = Literal[
    "permission_denied", "invalid_schema", "hash_mismatch",
    "payload_too_large", "unknown_stream",
]

class AcceptedEvent(BaseModel):
    event_id: str
    stream_id: str
    server_sequence: int
    server_received_at: str          # RFC3339 millisecond-Z, from Envelope.server

class RejectedEvent(BaseModel):
    event_id: str                    # "" when the item is so malformed no id can be read
    code: RejectionCode
    detail: str

class BatchUploadResponse(BaseModel):
    accepted: list[AcceptedEvent]
    rejected: list[RejectedEvent]
```

**Request is NOT a bound Pydantic body param** — see D2 (raw capture). A `BatchUploadRequest(events: list[dict[str, Any]])` model MAY be declared for OpenAPI docs only (attached via the route's `openapi_extra` or simply omitted); the handler reads the raw body itself. The response uses `response_model=BatchUploadResponse`.

**Naming-collision note (documented in the module):** the per-event rejection *code* `payload_too_large` (64 KB single-event cap, in `rejected[]`) is distinct from the batch-level `/problems/payload-too-large` (1 MB whole-body cap, problem+json 413). Different layers; keep both.

### D2 — Raw-body capture (THE central correctness point)

**Ruling — the honest raw path:** the handler signature is
```python
async def upload_batch(request: Request, ctx: CurrentAuth, db: DbSession) -> BatchUploadResponse
```
It does **not** declare a Pydantic body parameter. The body is read and parsed **once**:

1. `raw = await request.body()` → measure `len(raw)`; also cheap-check `Content-Length` header first. `> 1 MB` → raise `problems.payload_too_large()` (413). (Reading `request.body()` — not `request.json()` — is deliberate: we need the exact byte length for the cap and full control of parse errors.)
2. `data = json.loads(raw)`; on `JSONDecodeError` → 422 `/problems/validation-error`.
3. Top-level shape: `data` must be an object with an `events` **list** → else 422. `len(events) > 100` → 422 `/problems/batch-too-large`.
4. Each `item` in `events` is a **raw dict** `{"body": {...}, "event_hash": "..."}`. `raw_body = item["body"]` is captured **verbatim** and is the sole input to `hash_event(raw_body)`. **No Pydantic model ever touches `raw_body` before it is hashed and stored.**

Why this is correct against the ENG-56 hazard: `Body(**raw_body)` is used only as a *gate* (D5 step iv), and because `Body` has `extra="allow"` and does not mutate the passed dict object, hashing the same `raw_body` object afterward is byte-faithful to what the client sent. Lax coercion (`"type_version":"1"→1`) affects only the throwaway model, never the stored/hashed dict. (`json.loads` preserves int-vs-string-vs-float inside a plain dict, so the raw bytes' scalar types survive.)

### D3 — Batch-cap enforcement points (batch-level = whole-request reject)

| Violation | Where | Response |
|---|---|---|
| body bytes > 1 MB | `len(await request.body())` (+ Content-Length guard) | **413** `/problems/payload-too-large` (new factory) |
| events count > 100 | `len(events)` after parse | **422** `/problems/batch-too-large` (new factory) |
| malformed top-level (not `{events:[...]}`, bad JSON) | after parse | **422** `/problems/validation-error` |
| single event `{body,event_hash}` wire form > 64 KB | per-event, step vii | per-event `payload_too_large` in `rejected[]` |

Batch-level violations reject the **whole request** as problem+json (§3.2 shape — the request never produces a partial `accepted/rejected` body). Two new `problems.py` factories: `payload_too_large()` (413) and `batch_too_large()` (422). Per-event 64 KB is measured over the compact raw `{body, event_hash}` dump (`json.dumps(..., separators=(",",":"), ensure_ascii=False)`), not via `serialized_size_bytes` (that re-dumps through the model; measuring raw is honest and avoids a model build). Empty batch (`events: []`) → 200 with empty arrays.

### D4 — Rate limit (§4.3): two limiters, per user

- `create_app` constructs two limiters on `app.state` (mirroring `auth_limiter`): `event_limiter_minute = RateLimiter(settings.event_rate_limit_per_minute, 60)` and `event_limiter_burst = RateLimiter(settings.event_rate_limit_burst_per_second, 1)`.
- New `settings.py` fields: `event_rate_limit_per_minute: int = 60`, `event_rate_limit_burst_per_second: int = 20`.
- New dependency `event_rate_limit(ctx: CurrentAuth, request: Request)` in `deps.py`: checks **both** limiters keyed by `f"user:{ctx.user_id}"`; first exceeded → 429 `/problems/rate-limited` with `Retry-After`. Depends on `require_auth` so it has the user id (the generic `rate_limit(limiter, key_fn)` factory only sees `Request` and cannot key by user — hence a dedicated dependency, like `auth_rate_limit`). Mounted on the route via `dependencies=[Depends(event_rate_limit)]`, before body parse.
- **Granularity ruling:** M1 rate-limits at **batch-request** granularity (one check per POST), not per-event — the `RateLimiter` counts one hit per `check()` and has no weight parameter, and touching `ratelimit.py` is out of scope. Documented minor deviation from a literal "events per user"; per-event weighting is a flagged future refinement.

### D5 — The per-event validation pipeline (`events/validate.py`) — §3.2 order EXACTLY

A read-only function per item returning an outcome the router then acts on:
```python
@dataclass
class Accepted:  home_stream_id: str; raw_body: dict
@dataclass
class Rejected:  event_id: str; code: RejectionCode; detail: str

async def validate_event(db, *, ctx: AuthContext, item: Any) -> Accepted | Rejected
```
`validate_event` performs only **reads** (predicate/existence queries); all mutation (`emit_event`) and commit happen in the router (D6). Steps, in the locked §3.2 order:

**0. item shape** — `item` must be `{"body": dict, "event_hash": str}`. Read `raw_body = item["body"]`, `raw_hash = item["event_hash"]`. Missing/wrong-typed → `invalid_schema` (`event_id = raw_body.get("event_id","")` best-effort). **Only `body` and `event_hash` are read**; any `item["server"]` / `item["signature"]` / extra keys are **ignored** (never read, never stored) — point 3 smuggling is inert by construction.

**i. session** — already established (`require_auth` → `ctx`).

**ii. workspace membership + author binding** — `raw_body["workspace_id"] == ctx.workspace_id` **and** `raw_body["author_user_id"] == ctx.user_id` **and** `raw_body["author_device_id"] == ctx.device_id`. Any mismatch → **`permission_denied`**. (Author binding folded into the identity group per §3.2 "author fields must match the session".)

**iii. stream write permission** — resolve on `raw_body["stream_id"]` by event type:
```python
if event_type in _WRITE_MATRIX_TYPES:   # message.created, channel.created,
    allowed = await can_write(db, ctx=ctx, stream_id=sid, event_type=event_type)
else:                                     # unknown type (D9) — membership-gated like a message
    allowed = await can_read(db, ctx=ctx, stream_id=sid)
```
False → **`permission_denied`** (uniform for absent / private-non-member / guest — D13 non-disclosure, see D8). `_WRITE_MATRIX_TYPES` is a small ENG-66 constant mirroring `can_write`'s known branches. **Why the split:** `can_write` returns `False` for any type it does not recognize (its documented default-deny), which would wrongly reject D9 unknown types; for unknown types we instead gate on read/membership access (`can_read`). Known-type-unknown-version (e.g. `message.created` v2) still keys `can_write` by the type string, so it is gated correctly. Archived-write gate lives here too (D8b).

**iv. schema (type + version; known types only; unknown accepted per D9)** —
- Envelope shape: `Body(**raw_body)` as a **gate only** (validates required fields + id formats; model discarded, raw kept). Failure → `invalid_schema`.
- `model = get_payload_model(type, type_version)`. If found → validate `raw_body["payload"]` against it; failure → `invalid_schema` (obligation 7c: known-type-invalid-payload). If `None` (unknown type **or** unknown version) → **skip payload validation, accept** (D9: stored, sequenced, reducer no-op).

**v. hash recompute over RAW dict** — `hash_event(raw_body) == raw_hash`? No → **`hash_mismatch`**. `JCSError` (out-of-domain body: non-finite float, over-cap int, over-depth) → **`invalid_schema`** (the body is un-hashable/protocol-invalid; `hash_mismatch` is reserved strictly for "hashed fine but ≠ supplied"). Uses `hash_event(raw_body)` — **never** `verify_hash` — so the redaction exemption in `verify_hash` is unreachable on the upload path (point 3 / obligation).

**vi. referential checks (M1-minimal)** —
- **Genesis collision** (obligation 7a): `channel.created` → `payload["channel_stream_id"]` must **not** already exist; `dm.created` → `payload["dm_stream_id"]` must not exist. Exists → **`invalid_schema`** (a genesis event may not adopt an existing stream — prevents the cross-stream read-grant ENG-65's reducer guards defense-in-depth). Primary gate; the reducer's `created`-flag guard is the backstop.
- **§2.2 homing** (point 9): `channel.created` `public` → `body.stream_id` must be the workspace's `workspace-meta` stream; `private` → `body.stream_id == payload.channel_stream_id` (self-homed genesis). Violation (e.g. private with `stream_id == workspace-meta`) → **`invalid_schema`**. `dm.created` → `body.stream_id == payload.dm_stream_id` (but `dm.created` is rejected earlier at step iii — `can_write` returns False, `permission_denied` — so homing is not reached in M1; documented).
- **Lifecycle referential** (the non-confidential `unknown_stream` producer): `channel.renamed`/`channel.archived`/`channel.member_added`/`channel.member_removed` → `payload["channel_stream_id"]` must exist → **`unknown_stream`** if absent. Reached only by owner/admin (step iii), and channel existence at the workspace level is not confidential from admins, so revealing it does not leak (D13-safe).
- **M1-skipped, documented:** `thread_root_id` existence, `file_ids` existence/ownership, `mentions` existence — all reference M3 features (threads/attachments) with no server-side table populated in M1. Clients send empty/`null`. No referential check; skip.

**vii. size caps** — per-event raw `{body, event_hash}` compact byte length > 64 KB → **`payload_too_large`**.

Pass all → `Accepted(home_stream_id = raw_body["stream_id"], raw_body)`.

### D6 — Accept path + per-event transaction ruling (§4.2)

**Ruling — per-event transaction (savepoint + per-event commit):** the router iterates `events` in batch order; for each `Accepted` outcome:
```python
try:
    async with db.begin_nested():                 # SAVEPOINT — makes UNIQUE catchable
        envelope = await emit_event(db, home_stream_id=out.home_stream_id, body=out.raw_body)
    await db.commit()                              # durable; releases the streams-row lock
    accepted.append(AcceptedEvent(**envelope.server-derived fields))
    await publish_event(envelope)                  # D9 WS seam, AFTER commit, once
except IntegrityError:                             # UNIQUE(workspace_id, event_id) → idempotent
    await db.rollback()                            # savepoint already aborted; clear txn
    accepted.append(await _fetch_original(db, workspace_id, event_id))
```
Rationale for **per-event commit** (not one batch-wide commit):
- **Isolation** (point 5): an invalid event N is a `Rejected` outcome that never opens a transaction; a mid-emit failure rolls back only its savepoint / that event's commit — accepted event N−1 is already durable and cannot be undone. "A bad event does not sink the batch."
- **Gapless under concurrency** (§4.2, D2): `insert_event`'s `UPDATE streams SET head_seq=head_seq+1 RETURNING` takes the row lock; committing per event **releases it immediately**, so parallel batches to the same stream serialize tightly and get consecutive gapless sequences with no long lock hold. This is the exact §4.2 "single transaction per event → commit → hand to WS hub" shape.
- The `begin_nested()` savepoint is mandatory regardless: an `IntegrityError` aborts the active transaction in asyncpg, so idempotency recovery requires a savepoint to roll back to without poisoning the session.

**Ordering guarantee within a batch:** same-stream events in one batch are processed sequentially, each taking+releasing the lock in order → they receive **consecutive ascending sequences in batch order**. Documented as a client-facing guarantee.

**`emit_event` is uniform for all accepted types:** it runs `apply_reducer` (bootstraps a genesis stream row / mutates membership; **no-op for `message.created` and unknown types**) then `insert_event` (sequences + stores verbatim). `home_stream_id = raw_body["stream_id"]` for every type (the client chooses homing; step vi validated it).

### D7 — Idempotency exactness (point 6)

On `UNIQUE(workspace_id, event_id)` violation, `_fetch_original` runs
`SELECT stream_id, server_sequence, server_received_at FROM events WHERE workspace_id=:ws AND event_id=:eid`
and returns an `AcceptedEvent` with those **original** fields. §3.2's `accepted[]` entry is exactly `{event_id, stream_id, server_sequence, server_received_at}` — **not** the full envelope — so "byte-for-byte original record" means these four fields equal the first acceptance's four fields. `server_received_at` is re-formatted from the stored TIMESTAMPTZ via the **same** `_format_rfc3339` (millisecond-`Z` truncation) `insert_event` used, so the string reproduces the original response exactly (deterministic truncation). The reducer is **not** re-run and the body is **not** re-hashed on the idempotent path; `publish_event` is **not** re-invoked (already published on first acceptance).

### D8 — Inherited obligations (explicit plan items)

- **(a) genesis-id collision** → `invalid_schema` (D5 vi). Test: pre-create a stream, upload `channel.created` with that `channel_stream_id` → rejected; assert the reducer made no membership change.
- **(b) archived-write gate** → `permission_denied`. `can_write` does **not** check `archived_at`; ENG-66 adds a minimal local check in step iii for `message.created`: `SELECT archived_at FROM streams WHERE stream_id=:sid` — non-null → `permission_denied`. Local duplication only (does not edit `permissions.py`); **flagged** to fold into `can_write` later. Applies to `message.created` in M1 (lifecycle re-archive edge documented, not gated).
- **(c) unknown event types accepted per D9** → stored, sequenced, reducer no-op (D5 iv + D6). Test: upload `type: "custom.thing"` (valid envelope, membership-gated via `can_read`) → accepted; row present; no reducer effect. **Known-type-invalid-payload** (`message.created` with bad `message_id`/missing `text`) → `invalid_schema`.
- **(d) referential per §3.2, M1-minimal** → only genesis-collision + §2.2 homing + lifecycle-`channel_stream_id`-exists enforced (D5 vi). `thread_root_id`/`file_ids`/`mentions`/reaction-target existence **skipped** (M3 features, no M1 table). Documented.

### D9 — WS seam shape (ENG-68)

`events/fanout.py` (ENG-66-owned):
```python
async def publish_event(envelope: Envelope) -> None:
    """No-op WS fanout seam (ENG-68 replaces the body). Invoked by the upload
    router AFTER each per-event commit, once per newly accepted event (never on
    the idempotent re-accept path)."""
    return None
```
A module-level async callable the router imports and invokes post-commit. ENG-68 replaces its body (permission-scoped fanout via the in-memory registry) without touching the router loop. Kept in `events/fanout.py` (a clearly-labelled seam) so the router stays lean and there is no collision with ENG-68's `ws/` files.

### D10 — Router wiring (`events_upload.py`)

```python
router = APIRouter(prefix="/v1", tags=["events"])

@router.post("/events/batch", response_model=BatchUploadResponse,
             dependencies=[Depends(event_rate_limit)])
async def upload_batch(request: Request, ctx: CurrentAuth, db: DbSession) -> BatchUploadResponse:
    # D2 parse+caps → loop: validate_event (D5) → emit/commit/idempotency (D6/D7) → publish (D9)
```
`app.py` mounts it: `app.include_router(events_upload.router)` and constructs the two event limiters on `app.state`.

---

## File list

**New (`python-engineer`):**
- `server/msgd/api/routers/events_upload.py` — `POST /v1/events/batch` (parse, caps, per-event loop, emit/commit/idempotency, publish).
- `server/msgd/api/schemas/events.py` — `RejectionCode`, `AcceptedEvent`, `RejectedEvent`, `BatchUploadResponse` (+ optional docs-only request model).
- `server/msgd/events/validate.py` — `Accepted`/`Rejected`, `validate_event`, `_WRITE_MATRIX_TYPES`, size/homing/collision helpers.
- `server/msgd/events/fanout.py` — no-op `publish_event(envelope)` WS seam.
- `server/tests/eventsutil.py` — build a valid client `{body, event_hash}` item (via `build_message_created_body` + `hash_event`) + `post_batch` helper; a `bootstrap_channel` helper (upload a `channel.created` to get a writable stream).
- `server/tests/test_events_batch.py` — endpoint acceptance (schemas, caps, all five codes, coercion tamper, redacted smuggling, author binding, workspace mismatch, isolation, ordering, homing, unknown-type, archived gate, idempotency, adversary, rate limit).
- `server/tests/test_events_validate.py` — unit tests over `validate_event` (each code, step order).
- `server/tests/test_events_batch_concurrency.py` — committing-app: parallel batches same stream → gapless; mid-flight dup → one row.

**Modified (shared surface — additive, coordinate with ENG-67):**
- `server/msgd/api/app.py` — `include_router(events_upload.router)`; two event `RateLimiter`s on `app.state`. (ENG-67 also adds an `include_router`; trivial append conflict.)
- `server/msgd/api/deps.py` — `event_rate_limit` dependency + `get_event_limiters` accessor.
- `server/msgd/api/problems.py` — `payload_too_large()` (413), `batch_too_large()` (422).
- `server/msgd/settings.py` — `event_rate_limit_per_minute=60`, `event_rate_limit_burst_per_second=20`.

**NOT touched:** `events/permissions.py`, `events/insert.py`, `events/reducers.py`, `events/emit.py`, `core/*`, `ws/*`. No migration. `authutil.AUTH_TABLES` already lists `events, stream_members, streams` (ENG-65) — concurrency cleanup is ready.

---

## Test plan (pytest; `python-engineer`)

**Ticket acceptance criteria:**
- **Gapless under concurrency** — `committing_app`, N parallel `POST /events/batch` to one channel → sequences contiguous `k..k+N`, no gaps/dupes; `truncate_auth_tables` after.
- **Idempotent re-upload byte-for-byte** — upload event, re-upload same `{body, event_hash}` → `accepted[]` entry identical (same `server_sequence`, `stream_id`, `server_received_at` string); exactly one `events` row.
- **Coercion tamper** — `type_version: "1"` (string) with an `event_hash` computed over int `1` → `hash_mismatch`. (Companion: honestly-hashed string form → accepted and stored verbatim — documents the raw-faithful design.)
- **Redacted smuggling** — item with `server: {payload_redacted: true}` + wrong hash → `hash_mismatch`; + correct hash → accepted with stored `payload_redacted=False`. Assert client `server`/`signature` never influence acceptance.
- **Every rejection code exercised** — `permission_denied` (author mismatch / non-member write / guest channel.created / archived write), `invalid_schema` (bad payload / genesis collision / homing violation / JCS out-of-domain), `hash_mismatch`, `payload_too_large` (>64 KB event), `unknown_stream` (lifecycle ref to absent channel).

**Obligations & rulings:**
- **Validation order** — a body that is both schema-invalid and hash-wrong → returns `invalid_schema` (schema before hash).
- **Author/workspace binding** — `author_user_id`/`author_device_id`/`workspace_id` ≠ session → `permission_denied`.
- **Batch caps** — >100 events → 422 `/problems/batch-too-large`; body >1 MB → 413 `/problems/payload-too-large`; per-event >64 KB → `payload_too_large` in `rejected[]` (distinguish batch-level problem+json from per-event code). Empty batch → 200 empty arrays. Malformed top-level → 422.
- **Per-event isolation** — batch `[valid, invalid, valid]` → 2 accepted (persisted), 1 rejected.
- **Ordering within batch** — two same-stream valid events in one batch → consecutive ascending sequences in batch order.
- **Genesis collision** — `channel.created` with existing `channel_stream_id` → `invalid_schema`; no membership side effect.
- **Archived-write gate** — `message.created` to archived stream → `permission_denied`.
- **Unknown type (D9)** — `custom.thing` valid envelope, member of stream → accepted, stored, sequenced, no reducer effect. Known-type-invalid-payload → `invalid_schema`.
- **§2.2 homing** — private `channel.created` with `stream_id == workspace-meta` → `invalid_schema`; public with `stream_id != meta` → `invalid_schema`; correct homing → accepted (private at seq 1 in its own stream; public appended to meta, channel's own stream at `head_seq=0`).
- **unknown_stream** — `channel.renamed`/`member_added` referencing an absent `channel_stream_id` (as owner) → `unknown_stream`.
- **Adversary / no existence leak (D13)** — non-member `message.created` to an existing private stream → `permission_denied`; to a **non-existent** private stream id → `permission_denied` with **identical code + detail** (existence not disclosed).
- **Rate limit** — exceed 20/s burst or 60/min → 429 with `Retry-After`.
- **Concurrency idempotency** — two parallel uploads of the same `event_id` → exactly one `events` row; both responses return the same sequence.
- **WS seam** — monkeypatch `publish_event` to a spy: invoked once per newly accepted event, **not** on the idempotent re-accept.

---

## Rulings summary (for the summary-back)

1. **Raw-body capture:** handler takes `request: Request` (no bound body model), `raw = await request.body()` → 1 MB cap → `json.loads` → per-item `raw_body = item["body"]` captured verbatim; `hash_event(raw_body)` over the untouched dict. `Body(**raw_body)` is a gate only (extra="allow", non-mutating), so schema-before-hash (§3.2 order) and raw-faithful hashing (ENG-56) both hold.
2. **Per-event transaction:** `db.begin_nested()` savepoint around `emit_event` (makes UNIQUE catchable) + `db.commit()` **per accepted event** (durable, releases the stream-row lock immediately → tight gapless serialization under concurrent batches). Rejections open no txn; a bad event N cannot undo accepted N−1.
3. **Rejection-code map:**
   - `permission_denied` — workspace mismatch, author-binding mismatch, `can_write`/`can_read` False (absent **or** forbidden private stream — uniform, D13 non-disclosure), guest `channel.created`, member doing admin-only lifecycle, **archived-write** (obligation b).
   - `invalid_schema` — item shape, `Body` gate failure, known-type payload failure (obligation c), **JCS out-of-domain body**, **genesis-id collision** (obligation a), **§2.2 homing violation** (point 9).
   - `hash_mismatch` — `hash_event(raw) != event_hash` only (coercion tamper; redacted-smuggle). Never `verify_hash`.
   - `payload_too_large` — single-event `{body,event_hash}` > 64 KB.
   - `unknown_stream` — lifecycle event referencing an absent `channel_stream_id` (obligation d's non-confidential path).
   - **Unknown types (D9) accepted**, membership-gated via `can_read` (not `can_write`, which default-denies unknown types).
4. **Batch-cap enforcement:** body >1 MB → 413 `/problems/payload-too-large`; count >100 → 422 `/problems/batch-too-large`; both reject the whole request (problem+json), distinct from the per-event `payload_too_large` code (64 KB). Enforced on `len(await request.body())` and `len(events)`.
5. **WS seam:** `events/fanout.py::publish_event(envelope)` — no-op async callable, invoked after each per-event commit, once per newly accepted event (not on idempotent re-accept); ENG-68 replaces the body.
6. **Rate limit:** two `app.state` limiters (60/60 s + 20/1 s) via a dedicated `event_rate_limit(ctx, request)` dependency keyed `user:{ctx.user_id}`; batch-request granularity in M1 (documented deviation).

## Risks / open questions

- **Shared-file merge coordination with ENG-67:** both append `include_router(...)` in `app.py` and may edit `deps.py`. Keep edits additive and symbol-disjoint (`events_upload.router` vs ENG-67's routers; `event_rate_limit` is ENG-66-only). Expect a trivial 2-line conflict at the router-mount block.
- **Unknown-type write-permission split:** `can_write` default-denies unrecognized types, which would violate D9; ENG-66 routes unknown types through `can_read` instead. Subtle — flag for review and as a candidate for a future `can_write` "unknown type → membership" branch (would let ENG-66 drop the split).
- **`unknown_stream` sourcing:** the only non-leaky M1 producer is the lifecycle `channel_stream_id`-existence check. If a reviewer deems lifecycle referential checks out of M1 scope, `unknown_stream` loses its producer and the "every code exercised" criterion needs another path — so keep this check.
- **Existence non-disclosure (D13) on the write path:** absent and forbidden confidential streams both return `permission_denied` (no `unknown_stream` for private/DM). Security-review-worthy; the adversary test asserts identical code+detail for absent-vs-forbidden.
- **Idempotent `server_received_at` reproduction:** relies on deterministic millisecond truncation of the stored TIMESTAMPTZ matching the original response string. The idempotency test asserts exact string equality; if it ever diverges, store the formatted string alongside the column (not needed now).
- **Archived-write gate duplication:** a local `archived_at` query in `validate.py` rather than editing `can_write`. Flagged to consolidate into `can_write` later.
- **Rate-limit granularity:** batch-request, not per-event (RateLimiter has no weight). Documented; revisit if a client can abuse 100-event batches.
- **`messages_proj` not populated:** M1 convergence is via the event log only; the message projection / search arrives in a later ticket that adds a `message.created` reducer. Confirmed out of ENG-66 scope.
