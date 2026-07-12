# syntax=docker/dockerfile:1
# msg server image (TDD §11, ENG-72). Multi-stage: a uv builder that resolves the
# workspace into a self-contained /app/.venv, and a lean slim runtime that carries
# only that venv + the entrypoint. `msgctl` ships on PATH for
# `docker compose exec app msgctl …` (TDD §11 acceptance criterion).

# ── builder ──────────────────────────────────────────────────────────────────
# Base pinned by tag + digest comment (ENG-72 D1, Ruling 4). Digest resolved at
# build time; the comment records the digest this Dockerfile was authored against.
FROM python:3.12-slim AS builder
# python:3.12-slim @sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf

# uv is copied from its official minimal image, pinned by digest per our
# SHA-pinning convention (D1). No `curl | sh` installer (unpinned + network step).
COPY --from=ghcr.io/astral-sh/uv:0.11.26@sha256:3d868e555f8f1dbc324afa005066cd11e1053fc4743b9808ca8025283e65efa5 /uv /uvx /usr/local/bin/

# Deterministic, offline resolve. UV_PYTHON_DOWNLOADS=0 forces uv to use the
# image's system CPython (matches .python-version 3.12) rather than fetching one.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

# Copy the workspace source needed to resolve + build. `github-notifier`
# (plugins/) is an OUT-OF-PROCESS external plugin (D12): it must NOT ship inside
# the runtime image, but it IS a workspace member (so the repo-root ruff/mypy/
# pytest gates cover it), and `[tool.uv.sources]` maps it to the workspace — so
# uv must still SEE its directory at resolve time or the locked sync aborts with
# "references a workspace ... but is not a workspace member". Its source is
# copied into the builder ONLY (never into the runtime stage below) and is
# excluded from the venv install just below, so nothing plugin-related crosses
# the stage boundary. `--no-editable` builds real wheels, so msgd + msgctl source
# must be present.
COPY pyproject.toml uv.lock .python-version ./
COPY server/ server/
COPY cli/ cli/
COPY plugins/ plugins/

# --no-dev  drops the pytest/mypy/testcontainers group (never ships).
# --no-editable installs msgd + msgctl as built wheels (not .pth shims), so the
#   runtime venv is self-contained and independent of the source tree; the
#   msgctl console script lands at /app/.venv/bin/msgctl.
# --no-install-package github-notifier / msg-sdk  resolves each plugin as a
#   workspace member (keeping --locked honest) but keeps its wheel OUT of
#   /app/.venv, so the runtime image stays plugin-free (D12 — plugins run as
#   their own processes; msg-sdk is a client library, not a server component).
# --locked  fails if uv.lock is stale (reproducible builds).
RUN uv sync --locked --no-dev --no-editable \
    --no-install-package github-notifier --no-install-package msg-sdk

# ── web build ────────────────────────────────────────────────────────────────
# Builds the Vue SPA (web/) to web/dist so the runtime image can serve it
# single-origin (ENG-84, TDD §5.1 D4). Its own stage so the Node/pnpm toolchain
# never lands in the final runtime image — only the built dist is copied out.
# Node 22 + pnpm 9.15.0 match web/package.json ("engines".node / "packageManager")
# and the CI `web` job (Corepack-activated pnpm on Node 22).
FROM node:22-slim AS web-builder
# node:22-slim @sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4

WORKDIR /web

# Corepack ships with Node; activate the exact pnpm the repo pins so the build
# is byte-reproducible with local + CI. Pin matches web/package.json
# "packageManager": "pnpm@9.15.0".
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Manifest + lockfile first so the dependency layer caches independently of a
# source-only edit. --frozen-lockfile fails on a stale lockfile (reproducible).
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Now the source; `pnpm build` runs vue-tsc typecheck + `vite build`, emitting
# /web/dist. The typecheck needs only the web tree (no server/ files).
COPY web/ ./
RUN pnpm build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS runtime
# python:3.12-slim @sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf

# Non-root runtime user (D3). Migrations and uvicorn run as `msg`.
RUN groupadd --system msg \
    && useradd --system --gid msg --home-dir /app --no-create-home msg

# Self-contained venv from the builder; put its bin dir first on PATH so `python`,
# `uvicorn`, and `msgctl` all resolve to the venv without activation.
COPY --from=builder /app/.venv /app/.venv
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

# Entrypoint (migrate → serve, single worker). Reused verbatim from ENG-63; the
# Dockerfile does not rewrite it (TDD §11 / plan D2). No alembic.ini is shipped:
# migrate.py builds Config(None) with the packaged msgd/db/migrations
# script_location, verified in-image under --no-editable (R2).
COPY server/docker-entrypoint.sh /app/docker-entrypoint.sh

# Baked SPA (ENG-84). settings.py resolves web_dist_dir=web/dist relative to the
# WORKDIR (/app), so the built dist must land at /app/web/dist for create_app()'s
# `web_dist_dir.is_dir()` mount to fire and serve the client single-origin. Only
# the static dist crosses the stage boundary — the Node toolchain stays behind.
COPY --from=web-builder /web/dist /app/web/dist

# Data root (blobs live at /data/blobs per §6); owned by the runtime user.
RUN mkdir -p /data/blobs \
    && chown -R msg:msg /app /data

WORKDIR /app
USER msg

# App listens on 8080 (entrypoint); documented for operators/tooling.
EXPOSE 8080

ENTRYPOINT ["/app/docker-entrypoint.sh"]
