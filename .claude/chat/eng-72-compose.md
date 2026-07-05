# ENG-72 — M1: docker-compose deployment (app + postgres, Dockerfile, Caddy recipe, backup docs)

- Linear: https://linear.app/kurras/issue/ENG-72 · Milestone M1 · Priority High · branch `mohanad/eng-72-m1-docker-compose-deployment-app-postgres-dockerfile-caddy`
- TDD refs: §11 (deployment), §4.3 (guardrails + backups), §4.1 (stack, one worker), §6 (blob path)
- Depends on merged ENG-63: `server/docker-entrypoint.sh`, `server/msgd/settings.py`, `server/msgd/db/migrate.py`, `/healthz` all exist. **Extend, do not duplicate.**

## Goal (restated)

Ship the self-hosting story from TDD §11: exactly two containers (app + postgres), a lean uv-built image with `msgctl` on PATH, a compose file operators can `docker compose up` from a clean checkout to a healthy server, a Caddy reverse-proxy recipe, a §4.3 backup doc, and CI that validates the compose file and builds the image. **This ticket is devops-pure** — no `settings.py` changes (see Ruling 3). Do not implement in this session; this is the plan.

## What already exists (reuse verbatim)

- `server/docker-entrypoint.sh` — `python -m msgd.db.migrate` then `exec uvicorn msgd.api.app:create_app --factory --host 0.0.0.0 --port 8080 --workers 1`. **App listens on 8080.** Single-worker rationale is already documented in this file's header. The Dockerfile's ENTRYPOINT is this script; do not rewrite it.
- `server/msgd/db/migrate.py` — `python -m msgd.db.migrate` upgrades to head using `MSG_DATABASE_URL`. It resolves `script_location` to the packaged `msgd/db/migrations` dir (cwd-independent) and **gracefully falls back to `Config(None)` when `server/alembic.ini` is absent** — relevant to the `--no-editable` image shape below.
- `server/msgd/settings.py` — live `MSG_*` vars today: `database_url` (required), `data_dir` (required, `Path`), `secret_key` (required), `log_level` (default `INFO`). **No guardrail vars exist in code.**
- `/healthz` (`server/msgd/api/routers/health.py`) — returns `200 {"status":"ok"}` on DB ping success, `503` otherwise. Perfect for the compose healthcheck.
- Root is a uv workspace (`pyproject.toml`: members `server` + `cli`; `package = false`). `cli/pyproject.toml` declares the `msgctl` console script (`msgctl = "msgctl.cli:main"`). `uv.lock` is committed. CI already SHA-pins all GitHub Actions (PR #2 convention).

---

## Decisions (pinned)

### D1 — Image base + uv delivery
`python:3.12-slim` (Debian bookworm-slim), **not distroless**. Distroless has no shell, which breaks the `sh` entrypoint, `docker compose exec app msgctl …` (an explicit acceptance criterion), and operator debugging — all core to the "boring and honest self-hosting" intent. Slim keeps `sh`, `pg_dump`/`pg_isready` availability path, and is small enough.

uv is pulled from the official distroless uv image and copied in, **pinned by digest** per our SHA-pinning convention:
```dockerfile
COPY --from=ghcr.io/astral-sh/uv:0.8.x@sha256:<digest> /uv /uvx /usr/local/bin/
```
Devops resolves the current uv release + digest at implementation time. Do not use the `curl | sh` installer (unpinned, adds a network step). Pin the base image by tag `python:3.12-slim` **plus a `@sha256:` digest comment** (Ruling 4 policy: images = tag-pin + comment, digest optional-but-preferred; Actions = mandatory SHA-pin).

### D2 — Multi-stage build + workspace install shape
Two stages:
- **builder** (`python:3.12-slim` + uv): copy `pyproject.toml`, `uv.lock`, `.python-version`, `server/`, `cli/`; run
  ```
  uv sync --locked --no-dev --no-editable
  ```
  into `/app/.venv`. `--no-dev` drops the pytest/mypy/testcontainers group (never ships). `--no-editable` installs `msgd` + `msgctl` as **built wheels** into the venv (not `.pth` shims), so the runtime venv is self-contained and independent of the source tree — cleaner, and the `msgctl` console script lands at `/app/.venv/bin/msgctl`. Both workspace members install because the root workspace resolves both.
- **runtime** (`python:3.12-slim`, no uv): `COPY --from=builder /app/.venv /app/.venv`; put `/app/.venv/bin` on `PATH`. Copy `server/docker-entrypoint.sh`. Create a non-root user, `chown` `/app` and `/data`. `ENTRYPOINT ["/app/docker-entrypoint.sh"]`.

`msgctl` on PATH: because the console script installs to `.venv/bin/msgctl` and `PATH` includes it, `docker compose exec app msgctl --version` resolves (acceptance criterion). Verify in the smoke step.

**alembic.ini nuance:** with `--no-editable` the source tree is gone at runtime, so `server/alembic.ini` won't be present. `migrate.py` already handles this (builds `Config(None)`, sets `script_location` to the packaged `msgd/db/migrations`). Confirm `msgd/db/migrations/` (incl. `env.py` and versions) is inside the wheel — it is under the `msgd` package that hatch packages. **Belt-and-suspenders:** also `COPY server/alembic.ini /app/alembic.ini` and set `WORKDIR /app` so the `.exists()` branch finds it; it's a tiny file and removes any doubt. Devops picks one; flag in the PR which path was verified.

### D3 — Non-root
Create `msg` user/group in runtime stage. Migrations and uvicorn run as `msg`. `/data` (and `/data/blobs`) owned by `msg`. **Risk (flag):** host bind-mount `./data/blobs` may be owned by the host UID, not the container's `msg` UID → write failures. At M1 nothing writes blobs (blob store lands M3), so this is latent; document in `deploy.md` that operators ensure `./data/blobs` is writable by the container user, and revisit at M3. (A named volume would dodge this but the ticket specifies a bind mount for the M3 placeholder — keep the bind mount, document the caveat.)

### D4 — Guardrail env vars: reserved, not wired (Ruling 3, decisive)
The §4.3 guardrail table (max event size, batch limits, rate limits, max file size, per-workspace quota, WS conns/user, pull page size) is **not** consumed by any code today. Per Ruling 3: **document these as reserved in `deploy.md` (a table with the TDD defaults) and do NOT set them in `docker-compose.yml`, `.env.example`, or `settings.py`.** No dead config. When the subsystems that enforce them land (events/auth/files/WS tickets), those tickets add the corresponding `MSG_*` fields to `settings.py` and the compose file together. This resolves the surface tension between the ticket's "surface guardrails as env" line and the no-dead-config rule: they are surfaced as **documentation**, not live env. Note this explicitly in the PR body so reviewers don't read it as a miss.

### D5 — Live env surface (what compose actually sets)
Only the four vars `settings.py` consumes today:
- `MSG_DATABASE_URL=postgresql+asyncpg://msg:${POSTGRES_PASSWORD}@postgres:5432/msg` — points at the `postgres` service name.
- `MSG_DATA_DIR=/data` — `data_dir` already exists in settings; blobs live at `/data/blobs` per §6 (`blobs/sha256/…` under data_dir).
- `MSG_SECRET_KEY=${MSG_SECRET_KEY}` — from `.env`.
- `MSG_LOG_LEVEL=${MSG_LOG_LEVEL:-INFO}` — optional, default INFO.
Postgres service reads `POSTGRES_DB=msg`, `POSTGRES_USER=msg`, `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`.
Secrets (`POSTGRES_PASSWORD`, `MSG_SECRET_KEY`) come from a gitignored `.env`; a committed `.env.example` carries placeholders only. **No secrets committed.**

### D6 — Blob volume path (Ruling 5, pin now)
`MSG_DATA_DIR=/data`; bind-mount `./data/blobs:/data/blobs`. Locking this path now means M3 wires the real blob store against `/data/blobs` with zero compose churn. Postgres data uses a **named volume** (`pgdata`), not a bind mount — avoids host-UID permission pain for the PG data dir and is the standard pattern. (TDD §11's sketch used a `./postgres` bind mount; the named volume is a deliberate, documented improvement — call it out in the PR.)

### D7 — Postgres image (Ruling 4)
`postgres:17`, tag-pin + `@sha256:<digest>` comment. Digest optional but preferred for reproducibility; do not block on it.

### D8 — CI scope (lean, decisive)
For M1: **`docker compose config` validation + `docker build` smoke only.** Do **not** run the full stack (`compose up`) in CI. Rationale: a real up requires pulling postgres, waiting on healthchecks, and the migrate→serve cycle — minutes of runner time and a flake surface, for coverage the **ENG-73 exit gate already owns** ("two `msgctl`-driven clients converge over the real server" is the M1 gate and exercises a live stack). A compose-up smoke here would duplicate that at higher cost. Verdict: build + config in CI now; live-stack verification is a manual PR checklist item (below) and ENG-73's job.

---

## Files to create / modify (all owned by **devops-engineer**)

| File | Action | Notes |
|---|---|---|
| `/Dockerfile` | create | Multi-stage per D1/D2/D3. ENTRYPOINT = copied `docker-entrypoint.sh`. |
| `/docker-compose.yml` | create | Two services per D5/D6/D7 + healthchecks + depends_on + restart. |
| `/.dockerignore` | create | Exclude `.venv`, `.git`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.hypothesis`, `.claude`, `docs`, `data`, `postgres`, `*.md`. Keeps build context tiny + reproducible. |
| `/.env.example` | create | `POSTGRES_PASSWORD=`, `MSG_SECRET_KEY=`, `MSG_LOG_LEVEL=INFO` placeholders + comments. Committed. |
| `/docs/deploy.md` | create | Caddy recipe, backup story (§4.3), single-worker constraint + why, reserved-guardrail table (D4). |
| `/.gitignore` | modify | Add `.env`, `/data/`, and (defensive) `/postgres/`. |
| `/.github/workflows/ci.yml` | modify | Add an `image` job: hadolint (if available) → `docker build` → `docker compose config`. SHA-pin any new actions. |
| `server/docker-entrypoint.sh` | reuse as-is | No change; Dockerfile copies it. |

**No changes to `server/msgd/settings.py`** (D4). If a reviewer or the assignee later wants guardrail vars live, that is a separate `python-engineer`-owned settings edit tied to the enforcing subsystem — out of scope here.

---

## docker-compose.yml shape (spec for devops)

```yaml
services:
  app:
    build: .                      # image: msg/server for CI tag
    ports: ["8080:8080"]
    environment:
      MSG_DATABASE_URL: postgresql+asyncpg://msg:${POSTGRES_PASSWORD}@postgres:5432/msg
      MSG_DATA_DIR: /data
      MSG_SECRET_KEY: ${MSG_SECRET_KEY}
      MSG_LOG_LEVEL: ${MSG_LOG_LEVEL:-INFO}
    volumes:
      - ./data/blobs:/data/blobs   # M3 blob store placeholder (path pinned now)
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:                   # slim has no curl/wget → use python stdlib
      test: ["CMD", "python", "-c",
             "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/healthz').status==200 else 1)"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s            # covers migrate-on-startup before first probe
    restart: unless-stopped
    # ── SINGLE WORKER, DELIBERATE ─────────────────────────────────────────
    # Exactly one app container / one uvicorn worker (--workers 1 in the
    # entrypoint). WebSocket registry + fanout hub are in-process/in-memory;
    # a second worker would not see the first's connections. Horizontal scale
    # needs shared pub/sub (Redis/NATS), explicitly out of MVP scope
    # (TDD §11 / §4.1: "no Redis, no queue"). Do NOT raise the worker count
    # or run replicas without adding a shared fanout bus first.
  postgres:
    image: postgres:17            # @sha256:<digest>  (pin per D7)
    environment:
      POSTGRES_DB: msg
      POSTGRES_USER: msg
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U msg -d msg"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
volumes:
  pgdata:
```
The single-worker comment satisfies acceptance criterion 3. Devops confirms healthcheck syntax exactly (the python one-liner must be robust; alternative: ship a 3-line `healthcheck.py` in the image if the inline form gets unwieldy).

## docs/deploy.md — required content

1. **Caddy recipe** (two lines, auto-HTTPS; TLS terminates at the operator's proxy, app stays plain-HTTP on 8080):
   ```
   chat.example.com {
       reverse_proxy localhost:8080
   }
   ```
   Note WebSocket upgrades pass through `reverse_proxy` automatically (needed for M1 WS push).
2. **Single-worker constraint** — restate the entrypoint/compose rationale so operators don't scale it.
3. **Backup story (§4.3)** — two places hold all state: the Postgres volume and the blob dir.
   - Logical DB backup: `docker compose exec postgres pg_dump -U msg msg > backup.sql`.
   - Blobs: `rsync -a ./data/blobs/ <dest>/` (bind mount is on the host).
   - Or snapshot the single data dir / volume.
   - Note `msgctl export` (NDJSON + blobs + manifest) is the **portable logical backup**; it lands at **M4** (ENG milestone M4), restore = import. Mark as "arrives M4," not available today.
4. **Guardrail table (reserved, D4)** — the §4.3 values with their TDD defaults, labeled "reserved — enforced by later milestones; not yet configurable via env." Prevents operators from setting env that does nothing.
5. **Secrets** — copy `.env.example` → `.env`, fill `POSTGRES_PASSWORD` + `MSG_SECRET_KEY` (`openssl rand -hex 32`).
6. **Blob dir permissions caveat** (D3 risk) — ensure `./data/blobs` is writable by the container user before M3.

## CI additions (ci.yml, new `image` job)

```yaml
  image:
    name: docker build · compose config
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>            # reuse pinned v4 sha from existing job
      - name: hadolint (if used)                 # hadolint/hadolint-action@<sha>, optional
        ...
      - name: Build image
        run: docker build -t msg/server:ci .
      - name: Validate compose config
        run: docker compose config
        env:                                      # config interpolates ${...}; feed dummies
          POSTGRES_PASSWORD: ci
          MSG_SECRET_KEY: ci
```
Runs in parallel with the existing `checks` job. No `compose up` (D8). `docker compose config` needs the interpolated vars present or it warns/fails on empties — supply dummy env in the step. Optionally add `docker run --rm msg/server:ci msgctl --version` as a build-time smoke that also proves the console script is on PATH (cheap, no DB needed).

---

## Test / validation plan

**Automated (CI):** hadolint (if available) · `docker build` · `docker run … msgctl --version` (optional PATH smoke) · `docker compose config`.

**Manual PR checklist (paste into PR body — this is the M1 acceptance evidence, ENG-73 does the convergence gate):**
1. `cp .env.example .env` and fill secrets → `docker compose up -d`.
2. `docker compose ps` → both healthy; app shows migrations applied in logs.
3. `curl -fsS localhost:8080/healthz` → `{"status":"ok"}` (acceptance #1).
4. `docker compose exec app msgctl --version` → prints version (acceptance #2).
5. Confirm compose file carries the single-worker comment (acceptance #3).
6. `docker compose exec postgres pg_dump -U msg msg | head` → backup path works.
7. `docker compose down && docker compose up -d` → pgdata volume persists (migrations no-op on second boot).

---

## Risks / open questions

- **R1 — bind-mount UID/perms (D3):** `./data/blobs` host ownership vs container `msg` UID. Latent until M3 (no blob writes at M1). Documented caveat now; revisit at M3. Do not switch to a named volume — ticket wants the bind-mount placeholder.
- **R2 — alembic.ini under `--no-editable` (D2):** migrate.py's `.exists()` fallback covers absence, but verify migrations actually run in-image (the manual checklist step 2 proves it). Copying `alembic.ini` + `WORKDIR /app` removes all doubt — recommended.
- **R3 — slim healthcheck tooling:** slim has no `curl`/`wget`; the python-stdlib one-liner is the chosen probe. Confirm it exits non-zero on 503 (it will — `urlopen` raises `HTTPError` on 503, which is a non-zero exit → unhealthy, correct behavior).
- **R4 — TDD §11 drift:** the sketch used a `./postgres` bind mount and `./data:/data`; we use a named `pgdata` volume and a narrower `./data/blobs` bind. These are deliberate improvements (perms + M3 path lock) — call them out in the PR so they read as intentional, not accidental deviations from the doc.
- **R5 — guardrail "surfaced as env" wording (D4):** the ticket line reads like live env; we surface them as docs only. Explicitly note the Ruling-3 rationale (no dead config) in the PR to preempt a "missing env" review comment.
- **Open — uv + base-image digests:** devops resolves current uv release and `python:3.12-slim` / `postgres:17` digests at implementation time.

## Agent assignment

- **devops-engineer** — all files above (Dockerfile, compose, .dockerignore, .env.example, docs/deploy.md, .gitignore, ci.yml). Whole ticket is devops-pure.
- **python-engineer** — not needed for ENG-72 (no `settings.py` change per D4). Would only be pulled in later, by a different ticket, when a guardrail's enforcing subsystem lands.
