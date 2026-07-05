"""The ``AuthContext`` dependency contract (ENG-64 D5).

Every protected M1 router receives an :class:`AuthContext` from
``Depends(require_auth)``. It is a frozen read-snapshot of the authenticated
principal plus the loaded ORM rows (bound to the request session). Downstream
tickets (ENG-65+) read workspace scoping, membership, and author-field checks
off this object and must never re-parse the ``Authorization`` header.
"""

from __future__ import annotations

from dataclasses import dataclass

from msgd.db.models import Device, Session, User


@dataclass(frozen=True)
class AuthContext:
    """Immutable snapshot of the authenticated principal for a request."""

    user_id: str
    workspace_id: str
    role: str
    device_id: str
    session_token_hash: str
    # Live ORM rows (bound to the request's AsyncSession); routers that need
    # fresh fields reuse the same Depends(get_session) rather than re-querying.
    user: User
    device: Device
    session: Session
