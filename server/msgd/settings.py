"""Environment-driven application settings (TDD §4.1).

All configuration is read from ``MSG_``-prefixed environment variables via
``pydantic-settings``. :func:`get_settings` is cached so a single ``Settings``
instance is shared process-wide; tests clear the cache when they override env.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, populated from ``MSG_*`` environment variables."""

    model_config = SettingsConfigDict(env_prefix="MSG_", extra="ignore")

    # asyncpg DSN, e.g. ``postgresql+asyncpg://user:pass@host:5432/msg``.
    database_url: str
    # Root directory for blob storage and other on-disk state (§4.3 backups).
    data_dir: Path
    # Secret used for session-token / signing material by later tickets.
    secret_key: str
    log_level: str = "INFO"

    # --- API surface (ENG-64) ------------------------------------------------
    # Serve /docs, /redoc, /openapi.json. Secure prod default OFF; dev/compose
    # sets MSG_DOCS_ENABLED=true (PR #12 security-review carryover).
    docs_enabled: bool = False
    # Trust X-Forwarded-For for client-IP rate limiting. Default OFF → use the
    # socket peer (request.client.host); enable only behind a trusted proxy that
    # sets XFF, else all callers share the proxy's IP bucket (D6).
    trust_proxy: bool = False

    # --- Sessions (D4) -------------------------------------------------------
    # Rolling session lifetime and the throttle interval for last_seen bumps.
    session_ttl_days: int = 90
    session_bump_interval_seconds: int = 3600

    # --- Password policy (D8) ------------------------------------------------
    password_min_length: int = 12
    password_max_length: int = 1024

    # --- argon2id cost (D8) --------------------------------------------------
    # Pinned explicitly rather than inheriting library defaults (which can drift
    # across argon2-cffi versions). 64 MiB / t=3 / p=4 is the production profile;
    # tests override these to weak params so a suite full of logins stays fast.
    argon2_time_cost: int = 3
    argon2_memory_cost_kib: int = 65536  # 64 MiB
    argon2_parallelism: int = 4
    argon2_hash_len: int = 32
    argon2_salt_len: int = 16

    # --- Rate limiting (D6, §4.3) --------------------------------------------
    auth_rate_limit_per_minute: int = 10
    # Event upload limits (§4.3, ENG-66): sustained + burst, keyed per user.
    # M1 granularity is per batch REQUEST, not per event (documented deviation —
    # the fixed-window RateLimiter counts one hit per check and has no weight).
    event_rate_limit_per_minute: int = 60
    event_rate_limit_burst_per_second: int = 20
    # Search rate limit (ENG-122, §8): per user, keyed ``user:{user_id}`` exactly
    # like the event/file limiters. FTS (``websearch_to_tsquery`` + ``ts_rank_cd``
    # over a GIN index) is a cheap-ish read but not free, so it gets its own modest
    # per-user budget so a search flood cannot monopolize the DB.
    search_rate_limit_per_minute: int = 60
    # Read-state rate limit (ENG-123, D3): per user, keyed ``user:{user_id}`` like
    # the event/file/search limiters. ``PUT /v1/read-state`` is a scroll-frequent,
    # cheap idempotent monotonic upsert, so the budget is DELIBERATELY generous
    # (240/min ≈ 4/s per user) — a normal reader scrolling never trips it, but an
    # unbounded mutating endpoint is a DoS vector, so it is budgeted like every other
    # per-user write surface rather than left open.
    read_state_rate_limit_per_minute: int = 240

    # --- Invites (D7) --------------------------------------------------------
    invite_default_ttl_seconds: int = 604800  # 7 days
    invite_max_ttl_seconds: int = 2592000  # 30 days

    # --- File attachments (ENG-116, §6) --------------------------------------
    # Hard per-file byte cap, enforced at BOTH edges: ``POST /v1/files/initiate``
    # rejects a declared ``size_bytes`` over this (413), and the streaming
    # ``PUT .../blob`` aborts the moment the *actual* uploaded bytes cross it — so
    # a client that lies about ``size_bytes`` still cannot stream past the cap and
    # fill the disk. The 10 GiB PER-WORKSPACE quota is NOT here: it lives on the
    # ``workspaces.file_quota_bytes`` row (per-workspace, DB-authoritative).
    file_max_size_bytes: int = 52428800  # 50 MiB
    # Per-user file rate limits (availability, ENG-116 security review). Keyed
    # ``user:{user_id}`` exactly like the event limiters. Two budgets: the
    # DB-mutating/disk-touching writes (``initiate`` + ``blob``) share the tighter
    # ``file_rate_limit_per_minute``; the read-only ``download`` gets the more
    # generous ``file_download_rate_limit_per_minute`` (a client legitimately
    # fetches many attachments to render a channel).
    file_rate_limit_per_minute: int = 60
    file_download_rate_limit_per_minute: int = 120

    # --- Image thumbnails (ENG-118, §6) --------------------------------------
    # Best-effort WEBP thumbnails for ``image/*`` uploads, generated by Pillow in
    # the PUT path (offloaded to a thread) and stored as their own content-addressed
    # derived blob. The decode runs on UNTRUSTED bytes, so both bounds below are
    # security guards, not merely quality knobs.
    #
    # ``thumbnails_enabled`` — a kill switch. If image thumbnailing ever misbehaves
    # in production (a Pillow CVE, a decoder that hangs a thread), flip this OFF to
    # stop decoding untrusted images entirely; uploads keep working, just without
    # thumbnails. Default ON.
    thumbnails_enabled: bool = True
    # Longest-edge bound of the GENERATED thumbnail in pixels. ``img.thumbnail``
    # only ever downscales (never upscales), preserving aspect ratio.
    thumbnail_max_px: int = 720
    # Decompression-bomb guard: the maximum source W×H (in pixels) Pillow will
    # decode before raising, wired into ``Image.MAX_IMAGE_PIXELS`` per render. ~24
    # MP sits well above any real phone photo (a 48 MP sensor bins to ~12 MP JPEGs)
    # while capping the decoded-pixel buffer a malicious header can force us to
    # allocate — a 100000×100000 PNG that would balloon to tens of GB is rejected
    # instead of decoded. Bytes on disk are already capped by
    # ``file_max_size_bytes``; this bounds the DECODED (post-decompression) size,
    # which a tiny compressed file can still blow up.
    thumbnail_max_source_pixels: int = 24_000_000
    # Bounded worker count for the DEDICATED thumbnail-decode ThreadPoolExecutor
    # (ENG-118 review hardening). Untrusted image decodes are CPU-heavy (~70ms) and
    # memory-heavy (up to ~168 MB at the 24 MP cap), so they run on their OWN pool —
    # never the event loop's default ThreadPoolExecutor, which also serves argon2
    # password hashing and BlobStore fs I/O. A flood of attacker-triggered decodes is
    # thus confined to this pool (it cannot starve auth/verify or blob I/O) and
    # transient decode memory is capped at ``thumbnail_max_concurrency × ~168 MB``.
    thumbnail_max_concurrency: int = 2

    # --- First-run defaults (ENG-109) ----------------------------------------
    # Name of the default public channel /v1/setup auto-creates so a fresh
    # workspace is usable out of the box (the web channel-creation UI is not
    # built yet, so without a seeded channel the owner's sidebar is empty).
    default_channel_name: str = "general"

    # --- WebSocket fanout (ENG-68, §4.3) -------------------------------------
    # Max concurrent WS connections per user; the over-cap socket is accepted
    # then closed with app code 4029 (§5). The heartbeat is a 30 s ping/pong;
    # a missed pong closes the socket with 4408. Both are config-overridable
    # like the rate limits — the heartbeat test shrinks the interval (sub-second,
    # hence a float) to stay fast without a wall-clock 30 s wait (R5).
    ws_max_connections_per_user: int = 10
    ws_heartbeat_interval_seconds: float = 30.0

    # --- Single-origin SPA (ENG-75, §5.1 D4) --------------------------------
    # Serve the built web client (web/dist) from the FastAPI app at "/". Default
    # ON (the image bakes the dist); the is_dir() guard in create_app() means a
    # dev run without a build simply skips the mount and Vite serves the SPA.
    # Set MSG_SERVE_SPA=false for an API-only deploy.
    serve_spa: bool = True
    # Location of the built SPA. Baked at /app/web/dist under the image WORKDIR.
    web_dist_dir: Path = Path("web/dist")


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide cached :class:`Settings` instance."""
    return Settings()  # type: ignore[call-arg]  # values come from the environment
