# Deploying Serin

Self-hosting Serin is two containers — the FastAPI **app** and **Postgres** — wired
by [`docker-compose.yml`](../docker-compose.yml). No MinIO, no Redis, no message
queue (TDD §11 / §4.1). TLS is terminated by your own reverse proxy.

---

## Quickstart

```sh
# 1. Secrets — copy the template and fill it in (.env is gitignored)
cp .env.example .env
chmod 600 .env
#    POSTGRES_PASSWORD=<a strong password>
#    MSG_SECRET_KEY=$(openssl rand -hex 32)

# 2. Bring the stack up (builds the app image on first run)
docker compose up -d

# 3. Watch it become healthy — the app migrates the DB, then serves
docker compose ps
docker compose logs -f app

# 4. Confirm
curl -fsS localhost:8080/healthz          # -> {"status":"ok"}
docker compose exec app msgctl --version  # msgctl ships inside the image
```

The app listens on plain HTTP `:8080`, **bound to loopback only**
(`127.0.0.1:8080` in the compose file): it must only be reached through your TLS
reverse proxy. Docker port-publishing bypasses host firewalls, so operators who
genuinely want LAN-direct access must widen the bind consciously in
`docker-compose.yml`. Migrations run automatically on every startup (idempotent
— a no-op once the schema is at head), so a fresh `up` and a redeploy both
converge to the right schema with no manual step.

`msgctl` is on the image `PATH`, so any ops command runs via
`docker compose exec app msgctl <cmd>`.

---

## TLS with Caddy (recommended)

The app stays plain-HTTP on `:8080`; your reverse proxy terminates TLS. Caddy is
two lines and does automatic HTTPS (Let's Encrypt) out of the box:

```caddy
chat.example.com {
    reverse_proxy localhost:8080
}
```

WebSocket upgrades pass through `reverse_proxy` automatically — no extra config
is needed for the M1 WebSocket push path. nginx/Traefik work equally well; you
just have to wire the upgrade headers yourself.

---

## Single worker — do not scale this

The app runs **exactly one uvicorn worker**, and you should run **exactly one app
container**. This is deliberate, not an oversight:

- The WebSocket connection registry and the fanout hub are **in-process, in
  memory**. A second worker (or a second replica) would not see the first's
  connections, so fanout would silently drop messages to half your users.
- Horizontal scale requires a shared pub/sub bus (Redis/NATS), which is
  explicitly out of MVP scope (TDD §11 / §4.1).

At 5–50 users the single-process ceiling is far away. The constraint is
documented in both `docker-compose.yml` and `server/docker-entrypoint.sh`. **Do
not raise `--workers` or add replicas without first adding a shared fanout bus.**

---

## Backups (TDD §4.3)

All durable state lives in exactly two places: the **Postgres volume** and the
**blob directory**. Back up both.

**Postgres — logical dump:**

```sh
docker compose exec postgres pg_dump -U msg msg > backup.sql
# restore into an empty DB:
#   docker compose exec -T postgres psql -U msg msg < backup.sql
```

**Blobs** live under the host bind mount (`./data/blobs`), so a plain file copy
is enough:

```sh
rsync -a ./data/blobs/ /path/to/backup/blobs/
```

Or snapshot the single data directory / the `pgdata` volume with your usual
volume-snapshot tooling.

**Portable logical backup (arrives M4):** `msgctl export` produces the portable
NDJSON workspace folder (streams as NDJSON + content-addressed blobs +
`manifest.json`) — itself a full logical backup; restore is `msgctl import`. This
command lands at **M4** and is **not available today**; use `pg_dump` + blob copy
until then.

---

## Blob directory permissions (M3 caveat)

The app runs as a non-root `msg` user inside the container. The `./data/blobs`
bind mount is owned by whatever host UID created it, which may not match the
container's `msg` UID — leading to write failures once blob writes exist.

Nothing writes blobs at M1 (the blob store lands at M3), so this is currently
latent. Before M3, ensure `./data/blobs` is writable by the container user, e.g.
`chown` it to the container `msg` UID or relax its mode. This will be revisited
when the blob store ships.

---

## Configuration

Environment consumed by the app today (set in `docker-compose.yml`, secrets from
`.env`):

| Variable | Purpose | Default |
|---|---|---|
| `MSG_DATABASE_URL` | asyncpg DSN | (set by compose) |
| `MSG_DATA_DIR` | root for on-disk state; blobs at `$MSG_DATA_DIR/blobs` | `/data` |
| `MSG_SECRET_KEY` | session-token / signing material | (required, from `.env`) |
| `MSG_LOG_LEVEL` | `DEBUG`/`INFO`/`WARNING`/`ERROR` | `INFO` |

### Reserved operational guardrails (not yet configurable)

TDD §4.3 defines the operational guardrails below. They are **reserved**:
enforced by later milestones, **not yet consumable via environment variables**.
They are listed here so operators do not set env that does nothing today — no
dead config ships. When each enforcing subsystem lands (events / auth / files /
WebSocket tickets), that ticket adds the corresponding `MSG_*` setting to
`settings.py` **and** the compose file together.

| Guardrail | Default | Enforced by |
|---|---|---|
| Max event size | 64 KB | events upload |
| Max batch | 100 events / 1 MB | events upload |
| Rate limit: events per user | 60/min sustained, burst 20/s | events upload |
| Rate limit: auth attempts | 10/min per IP + per email | auth |
| Max file size | 100 MB | files |
| Per-workspace file quota | 10 GiB default | files |
| WebSocket connections per user | 10 | WebSocket hub |
| Pull page size | ≤ 500 events | events pull |
