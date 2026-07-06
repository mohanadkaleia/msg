# ENG-68 — M1: WebSocket `/v1/ws` — hub, permission-scoped fanout, heartbeat

**Tech-lead plan. Implementer: `python-engineer`. Do not implement from this file until the plan is accepted.**

Milestone M1 (TDD §13). Contract sources: §3.3 (WS frames + delivery contract), §3.6 enforcement point 3 (fanout recomputed on membership), §4.3 (10 conns/user, one worker), §11 (single app container / in-process fanout / no shared pub-sub), §14 (single-process fanout ceiling is a documented constraint).

This ticket fills the `publish_event(envelope)` seam that ENG-66 already wired and turns it into live, permission-scoped WebSocket fanout. It is additive to the merged M1 write path.

---

## 1. Goal (restated)

Ship a live in-process WebSocket surface:

- `GET /v1/ws?token=…` authenticates a socket (query-param token, WS can't set `Authorization`), registers it in an in-memory per-user registry, and runs a 30 s ping/pong heartbeat.
- The `publish_event(envelope)` seam (`server/msgd/events/fanout.py`), invoked post-commit once per newly accepted event, resolves the recipient set **permission-scoped at send time** and pushes `{"t":"event","event":{envelope}}` to every eligible connected socket.
- Delivery is a hint, not a guarantee (§3.3): cursors are the source of truth. This is what makes per-send permission resolution safe.

Areas changed: `server/` only (new `server/msgd/ws/` package, one-line seam delegation in `fanout.py`, two append-only lines in `app.py`, new tests). **No** `cli/`, `web/`, `projections/`, `simulation/`, CI, or compose changes.

---

## 2. Coordination / ownership (ENG-69/70/71 run in parallel)

**ENG-68 owns exclusively:**
- `server/msgd/ws/` package (new): `hub.py`, `registry.py`, `router.py`, `frames.py`, `__init__.py`.
- The `/v1/ws` route wiring.
- The **body** of `server/msgd/events/fanout.py` (`publish_event`) — replaced with a one-line delegation to the hub. **The public symbol name and signature `async def publish_event(envelope: Envelope) -> None` are unchanged.**
- Its own tests under `server/tests/`.

**Confirmed no collision on `fanout.py`:** repo-wide grep shows `publish_event` referenced only by (a) the ENG-66 call site `server/msgd/api/routers/events_upload.py:281` (merged, not edited here), (b) `fanout.py` itself, and (c) one ENG-66 test that monkeypatches `upload_module.publish_event`. No other planned ticket imports or edits `fanout.py`. ENG-68 is the sole writer of its body.

**Append-only edits to shared files** (must not reorder/rewrite existing lines):
- `server/msgd/api/app.py`: add `ws` to the routers import line and append one `app.include_router(ws.router)` after the existing includes. Nothing else.
- `pyproject.toml` (root `[dependency-groups] dev`): append the WS test-client dependency (see §7). Dev-only, does not ship.

**Signature is frozen.** The seam has no `db`/`app`/`request` handle. Do **not** change the call site in `events_upload.py` (owned by merged ENG-66) to pass a session. The hub reaches the DB independently (§4).

**Compatibility with the existing ENG-66 seam test:** `test_events_batch.py::test_ws_seam_invoked_once_per_new_accept` monkeypatches the router-level `publish_event` reference, bypassing the hub entirely. Keeping the symbol name/signature keeps that test green.

---

## 3. CENTRAL DESIGN RULING — recipient resolution: **per-send DB predicate** (not an in-memory membership map for M1)

**Ruling: at send time, for the envelope's `stream_id`, the hub resolves recipients by running the existing `readable_streams_predicate` / `can_read` (`server/msgd/events/permissions.py`) against the DB, once per distinct connected user, and pushes only to those who pass.** No in-memory membership cache in M1.

Why this over the in-memory map that §3.3's prose mentions ("invalidated by membership events"):

1. **Correctness over performance is the M1 mandate** (§12 is the go/no-go gate; §14 names sync-trust bugs as the #2 risk). The predicate is a **live `EXISTS` on `stream_members`** (permissions.py docstring: "deleting a member row cuts predicate access on the very next query"). Resolving per-send gives **instant revocation for free** — the §3.6 "removal cuts access immediately" property and §12 invariant 4 (permission isolation) hold by construction, with **zero cache-coherence code**.
2. **One shared predicate, tested once.** permissions.py is explicitly "the one shared SQL fragment reused by pull, search, and WS fanout scoping." Using it here means fanout scoping cannot diverge from pull/search scoping — the adversary client in the simulation suite asserts a single rule across all read surfaces.
3. **An in-memory map is a second source of truth** that must be seeded at hub start (it starts empty — no membership history) and invalidated correctly on `channel.member_added/removed`, `user.joined`, private→public visibility flips, guest role edges, DM member sets, and archival. Every one of those is a cache-coherence bug waiting to happen, and a stale map **leaks a private stream to a removed member** — exactly the §12.4 failure the simulation suite fails the build on. Not worth it at M1's 5–50-user scale.
4. **The delivery contract makes per-send safe.** §3.3: push is a hint; the client trusts only cursors and re-pulls on any `server_sequence != cursor+1` discontinuity. A recipient the predicate transiently mis-resolves during a membership race simply gets a missed frame → a pull → correct state. There is no correctness dependency on the push being complete or ordered — which is precisely why we can afford the "simple, live, per-send" resolution.

**Documented as the single-worker M1 choice.** The in-memory membership map is the **post-M1 optimization** (recorded here, not built): when the per-send fan-out query count becomes the fanout-latency bottleneck (§14 single-process ceiling), replace the per-send predicate with a map maintained from the meta-event stream the hub already fans out — but only behind the simulation suite proving isolation still holds. For M1: **live predicate, no cache.**

**Meta events need no special handling.** Because resolution is per-send against current DB state, the hub does **not** need to inspect `channel.member_added/removed` / `user.joined` to maintain any view. Those events flow through `publish_event` like any other and are themselves fanned out (they live on `workspace-meta` or the channel's own stream and are scoped by the same predicate). Membership changes take effect on the *next* event's resolution automatically.

### 3a. How the hub reaches the DB (the wiring consequence of this ruling)

The seam `publish_event(envelope)` carries **no** DB session. Per-send resolution therefore needs the hub to acquire its own **short-lived read-only** `AsyncSession`. Ruling:

- The `Hub` is constructed with an injectable **`session_factory: Callable[[], AsyncContextManager[AsyncSession]]`**.
- **Production default:** a factory that calls the engine's process-wide `async_sessionmaker` (the same one `msgd.db.engine.get_session` uses, installed by `create_app`'s lifespan via `set_sessionmaker`). The read runs post-commit in a fresh session and sees the just-committed event + current membership.
- **Tests:** the harness injects a factory that yields the bound, rolled-back `db_session` (§7), so fanout reads see the same per-test transaction as the upload that triggered them, under the existing isolation. This is the reason the factory is injectable rather than hard-wired to the global sessionmaker (the ASGI test transport does **not** run lifespan, so the global sessionmaker is `None` in tests).

This injectable factory is the single most important piece of wiring in the ticket — see Risk R1.

### 3b. The resolution query

Per event, the hub has: the envelope's `stream_id`/`workspace_id`, and the set of currently connected identities (each carrying `user_id`, `role`, `workspace_id` captured at connect — see §5). For each **distinct** connected user in the envelope's workspace, call `can_read(session, ctx=identity, stream_id=stream_id)` (one indexed `EXISTS` scalar). Push to all of that user's sockets iff it returns `True`. Users in a different workspace are skipped without a query.

M1 accepts N `EXISTS` queries per event where N = distinct connected users in the workspace (single worker, ≤10 conns/user, 5–50 users → tens of cheap indexed lookups). This is the documented fanout-latency cost; the in-memory map is the escape hatch when it bites. A micro-optimization available without a cache (optional, only if a test shows it matters): collapse to a single query — `SELECT user_id FROM users WHERE user_id = ANY(:connected) AND EXISTS(readable_streams_predicate for that row's role)`. Keep the per-user `can_read` loop for M1 unless profiling says otherwise; it reuses the audited helper verbatim.

---

## 4. Fanout execution model — synchronous post-commit resolve, isolated concurrent sends

**Ruling:** `publish_event` runs **inline in the upload request, after the per-event commit** (where ENG-66 already calls it), and does:

1. Snapshot the recipient socket set (resolve recipients per §3, collect their live `WebSocket` objects from the registry).
2. Serialize the wire frame once (§6).
3. **Send to all sockets concurrently with per-socket error isolation and a per-send timeout** — `asyncio.gather(*sends, return_exceptions=True)` where each send is wrapped in `asyncio.wait_for(...)` and a `try/except` that, on timeout/`WebSocketDisconnect`/any send error, **drops that one frame and schedules the socket's removal from the registry**, never propagating.

Rationale and guardrails:

- **A slow or dead socket must not block others or the accept path.** Per-socket isolation + `gather(return_exceptions=True)` + per-send `wait_for` timeout guarantee one wedged socket cannot stall the fan-out or the request. A failed send is not an error to the caller — the client will re-pull (delivery contract).
- **The accept path already committed** before `publish_event` is called (ENG-66, `events_upload.py:189-281`: `db.commit()` on line 193, `publish_event` on line 281). Fanout of an event whose txn later aborts is therefore **impossible by construction** — there is no later abort; the event is durable before any frame is built. A rejected event opens no transaction and never reaches the `publish_event` call. **Test this** (§7, T7): a batch with one accepted + one rejected event pushes exactly one frame.
- **Why inline, not a fire-and-forget background task.** Inline keeps the model dead-simple and deterministic for the simulation suite (no orphaned tasks, no ordering surprise between the response and the push), and the per-send timeout already bounds the request-latency contribution. The **single-worker fanout-latency ceiling** (§4.3 metrics call for a `fanout latency` gauge; §14 names the single-process ceiling) is: `resolve (N EXISTS queries) + one serialize + concurrent bounded sends`, added to each accepted event's post-commit tail. Documented as acceptable at M1 scale and as the first thing the post-M1 pub/sub layer or the in-memory map relieves.
- **Do not hold or reuse the request's `db` session for sends.** Resolution uses the hub's own session (§3a); sends touch only in-memory `WebSocket` objects.

Explicitly rejected alternative: spawning a detached `asyncio.create_task` per publish. It buys nothing at M1 (the per-send timeout already prevents head-of-line blocking) and costs determinism + task-lifecycle management. Revisit only with the post-M1 pub/sub layer.

---

## 5. Connection registry + cap (§4.3: 10/user, one worker)

**Ruling:** in-memory `dict[user_id -> set[Connection]]`, process-global (single worker per §11). A `Connection` wraps the live `WebSocket` plus the **identity captured at connect** (`user_id`, `role`, `workspace_id`, `device_id`) so per-send resolution needs no re-lookup of role.

- **Registration** happens *after* successful auth + accept.
- **Cap:** on register, if the user already has ≥ `ws_max_connections_per_user` (default **10**, config-overridable via `Settings`, §4.3) live sockets, the new socket is **accepted then closed** with a documented app close code **`4029`** (mirrors HTTP 429 "too many connections"). Accept-then-close is required so the client receives a close frame with the code rather than a bare handshake failure. The over-cap socket is never registered.
- **Cleanup:** a `finally` block around the receive loop removes the socket from its user's set on any exit (client disconnect, heartbeat-timeout close, over-cap close, server error). Remove the user's dict entry when its set empties (no leak). The concurrent-send failure path (§4) also schedules removal.
- **Concurrency:** all registry mutation is in the single asyncio loop; a small critical section (or plain dict/set ops, which are atomic under the GIL within a single `await`-free stretch) suffices. No lock needed beyond care that add/remove happen without interleaving `await`. Keep mutations synchronous (no `await` between read-check-and-mutate for the cap check).
- **Metrics hook (thin, optional for M1):** expose `hub.connection_count()` so a later `/metrics` (§4.3) can read it. No Prometheus wiring in this ticket.

---

## 6. Frames (§3.3)

**Server → client:**
- `{"t":"event","event":{envelope}}` — the full stored envelope, **raw-body-faithful and hash-valid**, byte-shaped identically to what the pull endpoint serves (`events_read._serialize_event`): `{"body":<raw body dict>, "event_hash":<str>, "signature":null, "server":{"server_sequence":…,"server_received_at":…,"payload_redacted":…}}`.
- `{"t":"pong"}` — reply to a client `{"t":"ping"}`.
- `{"t":"ping"}` — server heartbeat probe (see §heartbeat).

**Client → server (M1):**
- `{"t":"ping"}` / `{"t":"pong"}` only. A client `ping` → server `pong`; a client `pong` answers the server's `ping`. Any other/unknown/malformed inbound frame is **ignored** (never crash — mirrors D9's tolerance), optionally rate-limited by simply dropping.

**Reserved, NOT built in M1 (document in `frames.py` as the M3 surface):** server→client `read_state`, `presence`, `typing`; client→server `typing`, `presence`. These are the three-message-class non-event signals (D3) and land in M3. The frame module names them as reserved `t` values so M3 extends rather than redefines. Building them now is out of scope.

### 6a. Envelope serialization fidelity ruling

`publish_event` receives an `Envelope` (built by `insert_event` as `Body(**raw_body)`, `extra="allow"`). The frame must satisfy `hash_event(frame["event"]["body"]) == frame["event"]["event_hash"]` for **every** event including unknown types (the pull endpoint guarantees this by serving raw JSONB and never round-tripping through `Body.model_dump`).

**Ruling:** build the frame body via `envelope.body.model_dump(mode="json")` (faithful for all M1 typed str/int fields; `payload` is a pass-through `dict`; unknown fields survive via `extra="allow"`), and **assert hash-validity in a dedicated test** (§7, T8). If that test ever fails for a number-canonicalization edge case, the fallback (documented, not built unless needed) is: since the hub already holds a DB session for resolution, re-fetch the row and reuse the raw-JSONB serializer — i.e. lift `events_read._serialize_event`'s shape into a shared `ws`/`core` helper keyed off the row. For M1, `model_dump` + the guard test is the ruling; the delivery contract (a hash-mismatched hint just triggers a pull) makes any residual edge non-fatal.

Put the frame-building/serializing in `ws/frames.py` as pure functions (`event_frame(envelope) -> dict`, `PING`, `PONG` constants, `close code` enum) so they are unit-testable without a socket.

---

## 7. Auth, heartbeat, and the WS route (`ws/router.py`)

**Route:** `GET /v1/ws` (FastAPI `@router.websocket("/v1/ws")`). Token via **query param** `?token=…` (WS clients can't set `Authorization` cleanly — §3.3 specifies the query-param form).

**Auth (pre-accept reject):**
- Read `token` from `websocket.query_params`. Missing/empty → close during handshake (before `accept()`) with policy-violation code **`4401`** (mirrors HTTP 401). Do not `accept()` an unauthenticated socket.
- Resolve identically to `require_auth`'s session path (reuse `hash_token` + `lookup_session` + the same expiry/deactivation checks from `deps.require_auth` / `auth.sessions`) using an injected DB session (the standard `get_session` dependency works in WebSocket routes and is overridden in tests). **Do the throttled `bump_session` too** (D4) for parity, committing if it wrote.
- Unknown token / expired session / deactivated user → close pre-accept with `4401` (uniform, non-disclosing — same discipline as `require_auth`).
- On success, build the connection identity (`user_id`, `role`, `workspace_id`, `device_id`) from the loaded `(session, user, device)`.

**Do not** factor the session-loading out of `deps.require_auth` in a way that edits that merged file's behavior; if sharing is convenient, extract a small pure helper into `auth/sessions.py` (append-only) that both call, or simply re-call `lookup_session` + the two checks inline in `ws/router.py`. Prefer inline reuse of `lookup_session` to avoid touching `deps.py`.

**Accept + register:** `await websocket.accept()`, then register (cap check §5). If over cap, close `4029` and return.

**Heartbeat (30 s, §3.3):** the handler runs two concurrent coroutines for the socket's lifetime:
1. **Receive loop:** `await websocket.receive_json()` (or `receive_text` + `json.loads`, tolerant); on `{"t":"ping"}` send `{"t":"pong"}`; on `{"t":"pong"}` record liveness (clear the outstanding-ping flag); ignore everything else. On `WebSocketDisconnect`, exit.
2. **Heartbeat task:** every `ws_heartbeat_interval_seconds` (default **30**, config): if a prior server `ping` is still unanswered (no `pong` since), **close** the socket with code **`4408`** (missed heartbeat, mirrors HTTP 408); else send `{"t":"ping"}` and set the outstanding flag.

Use `asyncio.wait([...], return_when=FIRST_COMPLETED)` (or a `TaskGroup`) so whichever coroutine ends first tears the other down; a single `finally` deregisters (§5). Idle timeout on `receive` is also acceptable as a simpler heartbeat, but the explicit ping/pong is what §3.3 specifies and what the client implements — build ping/pong.

**Settings additions** (`server/msgd/settings.py`, append fields with defaults): `ws_max_connections_per_user: int = 10`, `ws_heartbeat_interval_seconds: int = 30`. Matches the §4.3 guardrail table and keeps them config-overridable like the rate limits.

---

## 8. WS test mechanism (works with the existing async testcontainer harness)

**Problem:** `httpx==0.28` (the harness client) has **no** WebSocket support. Starlette's sync `TestClient` runs the app in an anyio **portal thread with its own event loop**, but the harness's `db_session` is an asyncpg connection bound to the **test's** event loop (asyncpg connections are not usable across loops) — so `TestClient` WS + the rolled-back-transaction isolation would break on a cross-loop connection. Rejected.

**Ruling: add `httpx-ws` to the root `[dependency-groups] dev` list and drive the socket with `aconnect_ws(url, client=<harness AsyncClient>)`.** `httpx-ws` layers on the existing `httpx.AsyncClient(ASGITransport(app))`, runs **in the same event loop** as the test, and honors the app's `dependency_overrides` — so WS auth goes through the same overridden `get_session` → same rolled-back transaction as every other harness test. This is the only mechanism that composes cleanly with the current harness. (`httpx-ws` pulls `wsproto`; both are dev-only and never ship.)

**New harness fixtures (`server/tests/harness.py`, append-only):**
- A `ws_client` (or reuse `client`) exposing the base URL for `aconnect_ws`. `aconnect_ws("http://test/v1/ws?token=…", client=client)` reuses the existing ASGI transport.
- **Inject the hub's DB session factory** so per-send resolution reads the bound `db_session`: an autouse fixture that sets the hub singleton's `session_factory` to a context manager yielding the per-test `db_session`, and **resets the hub registry** before/after each test (the hub is a process-global singleton — see Risk R2 — so cross-test connection leakage must be cleared). Provide `hub.reset_for_tests()` and `hub.set_session_factory(...)` for this.

---

## 9. File list

**New (owned by ENG-68):**
| File | Purpose |
|---|---|
| `server/msgd/ws/__init__.py` | package marker; export `router`, `hub` |
| `server/msgd/ws/frames.py` | pure frame builders/constants: `event_frame(envelope)`, `PING`/`PONG`, close-code enum (`4401`,`4029`,`4408`), reserved M3 `t` names documented |
| `server/msgd/ws/registry.py` | `Connection` (socket + identity), `Registry` = `dict[user_id -> set[Connection]]`, add/remove/cap/count, cleanup |
| `server/msgd/ws/hub.py` | `Hub` singleton: injectable `session_factory`; `publish(envelope)` (resolve per §3 + concurrent isolated sends per §4); `register`/`deregister`; `reset_for_tests`; module-level `hub = Hub()` |
| `server/msgd/ws/router.py` | `@router.websocket("/v1/ws")`: query-token auth, accept, register/cap, ping/pong heartbeat, finally-deregister |
| `server/tests/test_ws.py` | the ENG-68 test suite (§10) |

**Edited (append-only / one-line):**
| File | Change |
|---|---|
| `server/msgd/events/fanout.py` | replace `publish_event` body with `await hub.publish(envelope)` (delegate to the `ws.hub` singleton); keep name + signature + docstring intent |
| `server/msgd/api/app.py` | add `ws` to the routers import; append `app.include_router(ws.router)` (append-only) |
| `server/msgd/settings.py` | append `ws_max_connections_per_user=10`, `ws_heartbeat_interval_seconds=30` |
| `server/tests/harness.py` | append `ws_client` helper + autouse hub session-factory-injection & registry-reset fixture |
| `pyproject.toml` | append `httpx-ws` to `[dependency-groups] dev` (regenerate `uv.lock`) |

**Import-cycle note:** `fanout.py` (under `msgd.events`) importing `msgd.ws.hub`, and `msgd.ws` importing `msgd.events.permissions` + `msgd.core.envelope`, must not cycle. `ws` → `events.permissions`/`core` is one-way; `events.fanout` → `ws.hub` is the only back-edge. To avoid an import cycle at module load, have `fanout.publish_event` do a **function-local import** of the hub (`from msgd.ws.hub import hub`) or import lazily; keep `ws.hub` free of any `import msgd.events.fanout`. Verify no cycle.

---

## 10. Test plan (`server/tests/test_ws.py`, `pytest` + the async harness)

All tests use the ASGI+testcontainer harness via `aconnect_ws` (§8). Reuse the existing setup helpers (`do_setup`, `bootstrap_channel`, `post_batch`, `wire_item`, `message_body`) from the ENG-66 test module where possible.

- **T1 — auth reject pre-accept:** no token / bad token / expired session / deactivated user → socket closed with `4401`, never accepted. (Four sub-cases; uniform code.)
- **T2 — happy path fanout:** owner connects; a `POST /v1/events/batch` message on a readable channel → the socket receives one `{"t":"event",...}` frame whose `event.body.event_id` matches and `event.server.server_sequence` is set.
- **T3 — ADVERSARY isolation (private stream):** a non-member user connects; an event on a **private** channel they are not in → they receive **zero** frames (per-send predicate). A member connected in parallel **does** receive it. This is the §12.4 invariant at the WS surface.
- **T4 — membership-removal mid-connection:** member connected and receiving; emit `channel.member_removed` for them; a subsequent message on that private stream → **no** further frames to the removed member (live predicate gives instant revocation, no cache). Confirms §3.6 "removal cuts access immediately."
- **T5 — connection cap:** open 10 sockets for one user (all live); the 11th is accepted-then-closed with `4029`; the first 10 stay live and still receive fanout.
- **T6 — heartbeat:** (a) client `{"t":"ping"}` → server `{"t":"pong"}`. (b) With a shrunk `ws_heartbeat_interval_seconds`, a socket that never answers the server ping is closed with `4408`. Use a tiny interval via test settings to keep the test fast.
- **T7 — post-commit only / rejected event no-frame:** a batch with one accepted + one **rejected** event (e.g. unauthorized stream or bad schema) → exactly **one** frame pushed. Proves fanout is per-*accepted*-event and post-commit (a rejected event never reaches `publish_event`).
- **T8 — hash fidelity of the pushed frame:** `hash_event(frame["event"]["body"]) == frame["event"]["event_hash"]`, for a known type **and** an unknown-type event (opaque body round-trips). Guards §6a.
- **T9 — idempotent re-accept no double-push:** re-POST the same batch → no second frame for the already-accepted event (mirrors the ENG-66 seam test, now at the live-hub level).
- **T10 — dead/slow socket isolation:** two members connected, one socket force-closed/abandoned; an event fans out → the healthy socket still receives its frame and the request completes (per-socket error isolation; failed send drops + deregisters). Optionally assert the dead socket is deregistered afterward.
- **T11 — multi-device same user:** two sockets for one user both receive the fanout frame (registry is a set per user).
- **T12 — unknown inbound frame tolerated:** client sends `{"t":"typing",…}` (reserved, M3) or garbage → socket stays open, no crash, no server frame.
- **Regression:** the existing `test_events_batch.py::test_ws_seam_invoked_once_per_new_accept` must remain green (it monkeypatches the router symbol) — do not break the seam name/signature.

---

## 11. Step-by-step implementation order

1. `settings.py` — append the two `ws_*` fields (defaults 10 / 30).
2. `ws/frames.py` — close-code enum, `PING`/`PONG`, `event_frame(envelope)` + `model_dump` serialization; unit-test `event_frame` hash fidelity in isolation first (fast feedback for §6a before any socket exists).
3. `ws/registry.py` — `Connection`, `Registry`, cap/add/remove/count.
4. `ws/hub.py` — `Hub` with injectable `session_factory`, `publish` (resolve via `can_read` loop + concurrent isolated timed sends), `register`/`deregister`/`reset_for_tests`; module singleton `hub`.
5. `ws/router.py` — websocket route: query-token auth (reuse `lookup_session`), accept, cap-register, ping/pong heartbeat, finally-deregister.
6. `ws/__init__.py` — export `router`, `hub`.
7. `fanout.py` — replace body with function-local `from msgd.ws.hub import hub` + `await hub.publish(envelope)`; verify no import cycle.
8. `app.py` — append the router import + `include_router` (append-only).
9. `pyproject.toml` — add `httpx-ws` to dev group; `uv lock`.
10. `harness.py` — `ws_client` helper + autouse hub session-factory injection & registry reset.
11. `test_ws.py` — T1–T12.
12. Run `-m "not integration"` unit slice (frames), then full integration suite; `ruff`, `mypy --strict`.

---

## 12. Risks / open questions

- **R1 (central) — hub DB-session acquisition across prod vs. test.** The frozen seam gives no session, so the hub owns an injectable `session_factory` (prod → global `sessionmaker`; test → bound `db_session`). If this injection is wrong, per-send resolution either can't run in tests (global sessionmaker is `None` under ASGITransport, which skips lifespan) or, in prod, opens a session with no live sessionmaker. **Mitigation:** make the factory a first-class `Hub` constructor arg + `set_session_factory`, default to the engine accessor, inject the bound session in the autouse harness fixture, and cover it by T2/T3 actually observing fanout under the rolled-back transaction. This is the make-or-break wiring.
- **R2 — process-global singleton leaks state across tests.** The hub must be a module singleton (the seam has no app handle), but the harness builds a fresh `create_app` per test. **Mitigation:** `hub.reset_for_tests()` (clear registry) in an autouse fixture, and never key correctness on app identity. Connections also self-clean on disconnect.
- **R3 — import cycle** `events.fanout ↔ ws.hub ↔ events.permissions`. **Mitigation:** function-local import of `hub` inside `publish_event`; keep `ws` importing only `events.permissions`/`core`, never `events.fanout`. Verify at module load.
- **R4 — envelope→frame hash fidelity for unknown/number-edge bodies** (§6a). **Mitigation:** T8 asserts `hash_event(body)==event_hash` for known + unknown types; documented raw-JSONB re-fetch fallback if it ever fails. Non-fatal by the delivery contract regardless.
- **R5 — heartbeat test flakiness / timing.** Real-time `asyncio.sleep` in a 30 s heartbeat is untestable as-is. **Mitigation:** drive the interval from `Settings` and shrink it (sub-second) in test settings; assert the `4408` close deterministically. Avoid wall-clock sleeps in assertions.
- **R6 — `httpx-ws` compatibility** with `httpx 0.28` + `ASGITransport` in-loop. Low risk (its documented use case), but if it fails to reuse `dependency_overrides`, fall back to driving the raw ASGI `websocket` scope directly (verbose but dependency-free). Confirm during step 9/10 before writing all of T1–T12.
- **R7 — concurrency correctness of registry mutation.** Single loop, but add/cap-check/remove must not interleave an `await` mid-check. **Mitigation:** keep the cap check-and-insert synchronous (no `await` between `len()` and `add()`); sends read a snapshot copy of the set.
- **R8 — session bump write on WS connect** inside the injected/test session. `bump_session` may write + commit; ensure it doesn't fight the rolled-back-transaction isolation. **Mitigation:** the WS route uses the standard overridden `get_session` (savepoint-isolated like every other endpoint), so a bump-commit lands on a savepoint, not the outer txn — same as `require_auth` today. Confirm parity.

---

## 13. Out of scope (record, do not build)

- In-memory membership map (post-M1 fanout optimization — §3).
- `read_state` / `presence` / `typing` frames (M3, D3 non-event classes) — reserved names only.
- `/metrics` Prometheus wiring for WS connection count / fanout latency (§4.3) — expose `hub.connection_count()` hook only.
- Any multi-worker / shared pub-sub fanout (§11/§14 explicitly single-process for MVP).
- Client-side sync engine / SharedWorker (M2, `web/`).
- Changing the `publish_event` signature or the `events_upload.py` call site.
```
