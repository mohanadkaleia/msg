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

    # --- Invites (D7) --------------------------------------------------------
    invite_default_ttl_seconds: int = 604800  # 7 days
    invite_max_ttl_seconds: int = 2592000  # 30 days


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide cached :class:`Settings` instance."""
    return Settings()  # type: ignore[call-arg]  # values come from the environment
