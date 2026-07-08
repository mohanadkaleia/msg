"""In-memory per-user connection registry + the §4.3 per-user cap.

Process-global (single worker, §11): a ``dict[user_id -> set[Connection]]``. All
mutation is synchronous — there is **no** ``await`` between the cap check and the
insert — so under the single asyncio loop there is no interleaving to guard (R7).
A :class:`Connection` also carries the identity captured at connect
(``user_id``/``role``/``workspace_id``/``device_id``) so per-send permission
resolution never has to re-look-up the caller's role.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from starlette.websockets import WebSocket

__all__ = ["Connection", "Registry"]


@dataclass(eq=False)
class Connection:
    """A live socket plus the identity captured at connect time (§5).

    ``eq=False`` keeps identity-based hashing (each socket is a distinct object),
    so two connections for one user are two distinct set members.

    Snapshot caveat (security round 1, hardening note 2): ``role``/``workspace_id``
    are captured once at connect. **Stream membership is re-checked live per-send**
    by the hub, so channel removal cuts fanout on the next event; but session
    revocation and workspace-role changes are NOT re-evaluated mid-socket (that
    needs a hub teardown signal — M2/M3). "Instant revocation" is therefore scoped
    to stream membership, not session validity.
    """

    websocket: WebSocket
    user_id: str
    role: str
    workspace_id: str
    device_id: str


class Registry:
    """``dict[user_id -> set[Connection]]`` with a synchronous cap check."""

    def __init__(self) -> None:
        self._by_user: dict[str, set[Connection]] = {}

    def try_add(self, connection: Connection, *, max_connections: int) -> bool:
        """Register ``connection`` unless the user is already at the cap (§5).

        Synchronous check-and-insert: no ``await`` between ``len()`` and ``add()``
        (R7). Returns ``False`` (and does not register) when the user already holds
        ``max_connections`` live sockets — the caller closes the socket ``4029``.
        """
        conns = self._by_user.get(connection.user_id)
        if conns is not None and len(conns) >= max_connections:
            return False
        if conns is None:
            conns = set()
            self._by_user[connection.user_id] = conns
        conns.add(connection)
        return True

    def remove(self, connection: Connection) -> None:
        """Drop ``connection``; delete the user's entry when its set empties (no leak)."""
        conns = self._by_user.get(connection.user_id)
        if conns is None:
            return
        conns.discard(connection)
        if not conns:
            del self._by_user[connection.user_id]

    def connections_for(self, user_id: str) -> set[Connection]:
        """Return a COPY of ``user_id``'s live sockets (empty set if none) — D3.

        The direct ``_by_user`` lookup the read-state WS echo resolves against: a
        marker set by a user is echoed to EXACTLY that user's other devices and no
        one else. Distinct from the hub's per-send stream-readability resolve — this
        is a same-user-only fanout, so isolation is by construction (a different
        user's id is simply never looked up). Returns a copy so a caller may iterate
        while sends deregister failed sockets (identical to :meth:`snapshot`).
        """
        conns = self._by_user.get(user_id)
        return set(conns) if conns is not None else set()

    def snapshot(self) -> dict[str, set[Connection]]:
        """A shallow copy safe to iterate while sends deregister failed sockets."""
        return {user_id: set(conns) for user_id, conns in self._by_user.items()}

    def total(self) -> int:
        """Total live connections across all users (the ``connection_count`` hook)."""
        return sum(len(conns) for conns in self._by_user.values())

    def clear(self) -> None:
        """Drop every connection (test reset — the hub is a process singleton, R2)."""
        self._by_user.clear()
