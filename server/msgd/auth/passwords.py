"""argon2id password hashing (ENG-64 D8).

argon2-cffi's default algorithm is **Argon2id**. The cost parameters are pinned
explicitly from :class:`~msgd.settings.Settings` — not inherited from library
defaults that can drift across versions — for auditability. The production
profile is t=3 / 64 MiB / p=4; tests override Settings to weak params so a suite
full of logins stays fast.

Two security properties this module implements:

* **Threadpool offload:** argon2 is CPU-bound; verifying/hashing on the event
  loop would stall the single worker. Every hash/verify runs via
  ``asyncio.to_thread`` so the loop (and the rate limiter's synchronous state)
  is never blocked.
* **Dummy-hash on unknown email (D2):** :func:`dummy_verify` verifies a
  submitted password against a precomputed throwaway hash. Login runs it when
  the email is unknown so the work — and the resulting 401 — is identical
  whether or not the email exists, defeating user enumeration by timing.

The hasher (and its paired dummy hash) is cached per parameter-tuple, so it is
effectively module-level for a running server while still honouring a test's
weak-param Settings override.
"""

from __future__ import annotations

import asyncio

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from msgd.settings import Settings

# A fixed plaintext used only to derive the per-hasher dummy hash. Never a real
# credential; its only job is to give dummy_verify a valid hash to burn CPU on.
_DUMMY_PLAINTEXT = "msg-dummy-password-for-timing-equalization"

# params-tuple -> (hasher, dummy_hash). Effectively module-level in production
# (one param set); a distinct entry appears when tests inject weak params.
_HASHER_CACHE: dict[tuple[int, int, int, int, int], tuple[PasswordHasher, str]] = {}


def _params(settings: Settings) -> tuple[int, int, int, int, int]:
    return (
        settings.argon2_time_cost,
        settings.argon2_memory_cost_kib,
        settings.argon2_parallelism,
        settings.argon2_hash_len,
        settings.argon2_salt_len,
    )


def _build(settings: Settings) -> tuple[PasswordHasher, str]:
    hasher = PasswordHasher(
        time_cost=settings.argon2_time_cost,
        memory_cost=settings.argon2_memory_cost_kib,
        parallelism=settings.argon2_parallelism,
        hash_len=settings.argon2_hash_len,
        salt_len=settings.argon2_salt_len,
    )
    dummy = hasher.hash(_DUMMY_PLAINTEXT)
    return hasher, dummy


def get_hasher(settings: Settings) -> PasswordHasher:
    """Return the process-wide :class:`PasswordHasher` for ``settings``' params."""
    key = _params(settings)
    entry = _HASHER_CACHE.get(key)
    if entry is None:
        entry = _build(settings)
        _HASHER_CACHE[key] = entry
    return entry[0]


def _dummy_hash(settings: Settings) -> str:
    key = _params(settings)
    entry = _HASHER_CACHE.get(key)
    if entry is None:
        entry = _build(settings)
        _HASHER_CACHE[key] = entry
    return entry[1]


def hash_password(settings: Settings, password: str) -> str:
    """Hash ``password`` with the settings-pinned argon2id parameters (sync).

    Used at user creation (setup / accept-invite) where the caller already runs
    off the event loop path is short; callers on the request path should prefer
    the async wrappers.
    """
    return get_hasher(settings).hash(password)


async def hash_password_async(settings: Settings, password: str) -> str:
    """Hash a password on a worker thread (keeps the event loop responsive)."""
    return await asyncio.to_thread(hash_password, settings, password)


def _verify_sync(hasher: PasswordHasher, password_hash: str, password: str) -> bool:
    try:
        hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False
    return True


async def verify_password(settings: Settings, password_hash: str, password: str) -> bool:
    """Verify ``password`` against ``password_hash`` on a worker thread."""
    hasher = get_hasher(settings)
    return await asyncio.to_thread(_verify_sync, hasher, password_hash, password)


def _dummy_verify_sync(hasher: PasswordHasher, dummy: str, password: str) -> None:
    try:
        hasher.verify(dummy, password)
    except VerifyMismatchError:
        pass


async def dummy_verify(settings: Settings, password: str) -> None:
    """Burn one argon2 verify against a throwaway hash (unknown-email path, D2).

    Equalizes CPU + latency with the real verify so an unknown email is
    indistinguishable from a wrong password.
    """
    hasher = get_hasher(settings)
    dummy = _dummy_hash(settings)
    await asyncio.to_thread(_dummy_verify_sync, hasher, dummy, password)


def needs_rehash(settings: Settings, password_hash: str) -> bool:
    """True if ``password_hash`` was made with stale parameters (D8).

    Wired for a future parameter-upgrade flow (re-hash on successful login with
    the plaintext in hand). M1 checks it but does not act on it.
    """
    return get_hasher(settings).check_needs_rehash(password_hash)
