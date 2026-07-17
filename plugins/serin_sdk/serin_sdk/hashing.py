"""``event_hash`` = ``"sha256:" + sha256(JCS(body))`` — the msg event hash.

A byte-for-byte port of ``server/msgd/core/hashing.py``. The server recomputes
this over the raw uploaded body and rejects any mismatch (``hash_mismatch``), so
the SDK MUST agree with it exactly. Correctness is pinned by the frozen
cross-language vectors (``server/msgd/core/testdata/vectors.json``) and the live
end-to-end test.
"""

from __future__ import annotations

import hashlib
from typing import Any

from serin_sdk.jcs import canonicalize

__all__ = ["HASH_ALGORITHM", "hash_event"]

#: The one hash algorithm msg uses; the digest is prefixed with ``"sha256:"`` so
#: the algorithm travels with the value.
HASH_ALGORITHM = "sha256"


def hash_event(body: Any) -> str:
    """Return ``event_hash`` = ``"sha256:<hex>"`` over the JCS bytes of ``body``.

    ``body`` is the event-envelope body dict exactly as it will be uploaded.

    Raises:
        JCSError: if ``body`` is outside the canonicalizable domain.
    """
    return f"{HASH_ALGORITHM}:{hashlib.sha256(canonicalize(body)).hexdigest()}"
