"""Client-minted typed-ULID identifiers — a dependency-free port of the server.

Every msg entity id is a `ULID <https://github.com/ulid/spec>`_ (Crockford
base32, 26 chars, lexicographically sortable) with a short type prefix, EXCEPT
``event_id`` which is a **bare** ULID with no prefix (TDD §2.1)::

    w_ workspace   u_ user   s_ stream   m_ message   f_ file   d_ device

Ids are client-mintable (offline-safe): the ULID timestamp + randomness give
global sortability with no server round-trip. This mirrors
``server/msgd/core/ids.py`` byte-for-byte (the encoder is validated against
``python-ulid`` and every id it mints is accepted by the server's
``ULID.from_str`` validator) but imports nothing from ``msgd`` and uses only the
standard library.

Minting is lock-guarded and **strictly monotonic**: two ids minted in the same
millisecond differ by an incremented randomness, so ``new_ulid() < new_ulid()``
always holds (matching the server, which relies on ULID sort order client-side).
"""

from __future__ import annotations

import secrets
import threading
import time

__all__ = [
    "ENTITY_PREFIXES",
    "new_ulid",
    "new_event_id",
    "new_message_id",
    "new_file_id",
    "new_workspace_id",
    "new_user_id",
    "new_stream_id",
    "new_device_id",
    "is_valid_ulid",
    "ulid_to_bytes",
]

#: Crockford base32 alphabet (excludes I, L, O, U), MSB-first — the ULID encoding.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_DECODE = {c: i for i, c in enumerate(_ALPHABET)}

_ULID_LENGTH = 26
_TIMESTAMP_BYTES = 6  # 48-bit millisecond timestamp
_RANDOMNESS_BYTES = 10  # 80-bit randomness
_RANDOMNESS_MAX = (1 << (_RANDOMNESS_BYTES * 8)) - 1

ENTITY_PREFIXES = frozenset({"w_", "u_", "s_", "m_", "f_", "d_"})

_mint_lock = threading.Lock()
_last_ms = -1
_last_randomness = 0


def _encode_ulid(data: bytes) -> str:
    """Crockford-base32-encode 16 bytes into a canonical 26-char ULID string."""
    n = int.from_bytes(data, "big")  # 128-bit big-endian
    # 26 chars * 5 bits = 130 bits: the two most-significant bits are zero, so the
    # first char is always <= '7'. char i covers bits [125-5i .. 129-5i].
    return "".join(_ALPHABET[(n >> (5 * (25 - i))) & 0x1F] for i in range(_ULID_LENGTH))


def ulid_to_bytes(value: str) -> bytes:
    """Decode a 26-char ULID string back to its 16 bytes (inverse of the encoder).

    Raises:
        ValueError: if ``value`` is not a syntactically valid 26-char ULID.
    """
    if len(value) != _ULID_LENGTH:
        raise ValueError(f"ULID must be {_ULID_LENGTH} chars, got {len(value)}")
    n = 0
    for ch in value:
        digit = _DECODE.get(ch)
        if digit is None:
            raise ValueError(f"invalid ULID character: {ch!r}")
        n = (n << 5) | digit
    if n >= (1 << 128):
        raise ValueError("ULID overflows 128 bits (first char must be <= '7')")
    return n.to_bytes(16, "big")


def new_ulid() -> str:
    """Return a fresh 26-char ULID, strictly increasing across calls."""
    global _last_ms, _last_randomness
    with _mint_lock:
        now_ms = time.time_ns() // 1_000_000
        if now_ms > _last_ms:
            _last_ms = now_ms
            _last_randomness = secrets.randbits(_RANDOMNESS_BYTES * 8)
        else:
            # Same millisecond (or a backwards clock): keep the timestamp and bump
            # the randomness so the id still strictly increases.
            _last_randomness += 1
            if _last_randomness > _RANDOMNESS_MAX:
                _last_ms += 1
                _last_randomness = secrets.randbits(_RANDOMNESS_BYTES * 8)
        raw = _last_ms.to_bytes(_TIMESTAMP_BYTES, "big") + _last_randomness.to_bytes(
            _RANDOMNESS_BYTES, "big"
        )
    return _encode_ulid(raw)


def is_valid_ulid(value: str) -> bool:
    """True if ``value`` is a syntactically valid bare 26-char ULID."""
    try:
        ulid_to_bytes(value)
    except ValueError:
        return False
    return True


def new_event_id() -> str:
    """A bare ULID for use as an ``event_id`` (no prefix, per §2.1)."""
    return new_ulid()


def new_message_id() -> str:
    return "m_" + new_ulid()


def new_file_id() -> str:
    return "f_" + new_ulid()


def new_workspace_id() -> str:
    return "w_" + new_ulid()


def new_user_id() -> str:
    return "u_" + new_ulid()


def new_stream_id() -> str:
    return "s_" + new_ulid()


def new_device_id() -> str:
    return "d_" + new_ulid()
