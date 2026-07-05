"""Opaque bearer tokens for sessions and invites (ENG-64 D2).

Discipline (identical for session tokens and invite tokens):

* **Mint:** ``secrets.token_urlsafe(32)`` → 32 bytes = 256 bits of entropy, a
  URL-safe string. This is the raw bearer token, returned to the client *once*.
* **Store:** ``sha256(raw).hexdigest()`` (hex) → the ``token_hash`` PK column.
  The raw token is never persisted.
* **Lookup:** exact equality on the PK-indexed sha256 hex. There is no usable
  timing surface on a full high-entropy hash, so no ``compare_digest`` is needed
  on the DB lookup itself (D2). The real timing surface — the argon2 verify on
  login — is handled separately in :mod:`msgd.auth.passwords`.
"""

from __future__ import annotations

import hashlib
import secrets

_TOKEN_BYTES = 32  # 256 bits


def hash_token(raw: str) -> str:
    """Return the sha256 hex digest of a raw token — the stored ``token_hash``."""
    return hashlib.sha256(raw.encode()).hexdigest()


def mint_token() -> tuple[str, str]:
    """Mint a fresh opaque token; return ``(raw, token_hash)``.

    The raw string is the bearer credential (returned once); the hash is stored.
    """
    raw = secrets.token_urlsafe(_TOKEN_BYTES)
    return raw, hash_token(raw)
