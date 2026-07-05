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

# Copy the full workspace needed to build both members as wheels. `--no-editable`
# (below) builds real wheels, so the source of both members must be present.
COPY pyproject.toml uv.lock .python-version ./
COPY server/ server/
COPY cli/ cli/

# --no-dev  drops the pytest/mypy/testcontainers group (never ships).
# --no-editable installs msgd + msgctl as built wheels (not .pth shims), so the
#   runtime venv is self-contained and independent of the source tree; the
#   msgctl console script lands at /app/.venv/bin/msgctl. Both workspace members
#   install because the root workspace resolves both.
# --locked  fails if uv.lock is stale (reproducible builds).
RUN uv sync --locked --no-dev --no-editable

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
# Dockerfile does not rewrite it (TDD §11 / plan D2).
COPY server/docker-entrypoint.sh /app/docker-entrypoint.sh
# Belt-and-suspenders: migrate.py resolves the packaged migrations dir and falls
# back to Config(None) when alembic.ini is absent, so migrations run under
# --no-editable regardless. This copy + WORKDIR /app removes any residual doubt
# (R2). Verified path in-image: packaged msgd/db/migrations + Config(None).
COPY server/alembic.ini /app/alembic.ini

# Data root (blobs live at /data/blobs per §6); owned by the runtime user.
RUN mkdir -p /data/blobs \
    && chown -R msg:msg /app /data

WORKDIR /app
USER msg

# App listens on 8080 (entrypoint); documented for operators/tooling.
EXPOSE 8080

ENTRYPOINT ["/app/docker-entrypoint.sh"]
