"""Session + device lifecycle (ENG-64 D3/D4).

Pure data-access helpers over an :class:`~sqlalchemy.ext.asyncio.AsyncSession`;
no FastAPI coupling (the ``require_auth`` dependency in :mod:`msgd.api.deps`
composes these). Covers device mint-or-reuse, session mint, lookup-by-hash, the
throttled rolling bump, and revoke/list.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.auth.tokens import mint_token
from msgd.core.ids import new_device_id
from msgd.db.models import Device, Session, User
from msgd.settings import Settings


def utcnow() -> datetime:
    """Timezone-aware current time (matches the TIMESTAMPTZ columns)."""
    return datetime.now(UTC)


async def mint_or_reuse_device(
    db: AsyncSession,
    *,
    user_id: str,
    device_label: str | None,
    device_id: str | None,
    now: datetime | None = None,
) -> Device | None:
    """Mint a new device or reuse a caller-supplied one (D3).

    * No ``device_id`` → mint (``d_`` ULID) and insert with ``device_label``.
    * ``device_id`` given → it must exist **and** be owned by ``user_id``.
      On success reuse it (update ``label``; ``created_at`` immutable). If it is
      unknown or owned by another user, return ``None`` — the caller maps that to
      a 400 ``/problems/invalid-device``. This runs only after successful auth,
      so it discloses nothing about credentials.
    """
    if device_id is not None:
        device = await db.get(Device, device_id)
        if device is None or device.user_id != user_id:
            return None
        device.label = device_label
        return device

    device = Device(
        device_id=new_device_id(),
        user_id=user_id,
        label=device_label,
        created_at=now or utcnow(),
    )
    db.add(device)
    return device


async def create_session(
    db: AsyncSession,
    *,
    user_id: str,
    device_id: str,
    settings: Settings,
    now: datetime | None = None,
) -> tuple[Session, str]:
    """Mint a session row and return ``(session, raw_token)``.

    The raw token is returned to the caller once and never persisted; only its
    sha256 hex ``token_hash`` (PK) is stored (D2). Expiry is ``now + ttl`` (D4).
    """
    moment = now or utcnow()
    raw, token_hash = mint_token()
    session = Session(
        token_hash=token_hash,
        user_id=user_id,
        device_id=device_id,
        created_at=moment,
        last_seen_at=moment,
        expires_at=moment + timedelta(days=settings.session_ttl_days),
    )
    db.add(session)
    return session, raw


async def lookup_session(db: AsyncSession, token_hash: str) -> tuple[Session, User, Device] | None:
    """Load ``(session, user, device)`` by ``token_hash`` (exact PK equality).

    Exact equality on a PK-indexed sha256 hex of a 256-bit secret — no usable
    timing surface, so no ``compare_digest`` is needed here (D2).
    """
    stmt = (
        select(Session, User, Device)
        .join(User, Session.user_id == User.user_id)
        .join(Device, Session.device_id == Device.device_id)
        .where(Session.token_hash == token_hash)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        return None
    return row[0], row[1], row[2]


async def bump_session(
    db: AsyncSession,
    session: Session,
    *,
    settings: Settings,
    now: datetime | None = None,
) -> bool:
    """Throttled rolling-window bump (D4).

    Roll ``last_seen_at``/``expires_at`` only when at least
    ``session_bump_interval_seconds`` have passed since the last bump; otherwise
    skip the write entirely. Returns whether a write occurred. Net cost: at most
    one cheap PK UPDATE per hour per active session — never a write-per-request.
    """
    moment = now or utcnow()
    interval = timedelta(seconds=settings.session_bump_interval_seconds)
    if moment - session.last_seen_at < interval:
        return False
    session.last_seen_at = moment
    session.expires_at = moment + timedelta(days=settings.session_ttl_days)
    return True


async def list_sessions(db: AsyncSession, user_id: str) -> list[Session]:
    """All sessions for ``user_id`` (for GET /v1/auth/sessions)."""
    stmt = select(Session).where(Session.user_id == user_id).order_by(Session.created_at)
    return list((await db.execute(stmt)).scalars().all())


async def revoke_session(db: AsyncSession, *, token_hash: str, user_id: str) -> bool:
    """Delete one session, scoped to its owner. Returns whether a row was deleted.

    Scoping the DELETE by ``user_id`` means a user can only revoke *their own*
    sessions; another user's ``token_hash`` matches no row → returns ``False``.
    """
    stmt = (
        delete(Session)
        .where(Session.token_hash == token_hash, Session.user_id == user_id)
        .returning(Session.token_hash)
    )
    result = await db.execute(stmt)
    return result.first() is not None
