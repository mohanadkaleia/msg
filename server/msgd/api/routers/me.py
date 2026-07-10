"""Self-profile router: ``GET /v1/me`` + ``PATCH /v1/me``.

STRUCTURALLY SELF-ONLY: neither endpoint takes a ``user_id`` — the target is
always ``ctx.user_id`` from the authenticated session, so there is no
cross-user vector to authorize away (contrast ``PATCH /v1/admin/members/{id}``,
which needs the whole policy matrix). Authz is simply "authenticated".

PROFILE STORAGE (mirrors the codebase's split ownership):

* The ``users`` row is OPERATIONAL state authored by HTTP handlers
  (setup/accept-invite write it; ``reducers._reduce_noop`` documents that no
  reducer ever touches it) — so the PATCH updates the row directly. ENG-164
  extends the editable surface beyond ``display_name`` to ``title`` /
  ``description`` / the custom status trio, with SUBSET semantics (only the
  fields present in the body are applied; an explicit ``null`` clears).
* The update is ALSO emitted as a server-authored ``user.profile_updated``
  meta event (§2.2) carrying the RESULTING profile values: the client-side
  member directory is a fold over the workspace-meta log (``user.joined``
  adds, ``user.profile_updated`` updates), so without the event no client —
  including the caller's own sidebar — would ever see the change. Same
  handler-writes-row + handler-emits-meta-event shape as ``/v1/setup`` and
  ``/v1/auth/accept-invite``; ``user.profile_updated`` stays
  non-client-writable (``can_write`` rejects it), exactly like ``user.joined``.

LAZY STATUS EXPIRY (ENG-164): there is NO background job. A status whose
``status_expires_at <= now`` is treated as CLEARED at read time — ``GET
/v1/me`` (and the PATCH echo) project expired status fields as ``null``; the
client fold/UI applies the same rule to the event-carried timestamp at render
time. The stale row values are simply overwritten by the next status PATCH.
"""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.api.deps import CurrentAuth, require_scope
from msgd.api.schemas.me import MeResponse, StatusUpdate, UpdateMeRequest
from msgd.core.payloads import build_user_profile_updated_body
from msgd.core.time import now_rfc3339, to_rfc3339
from msgd.db.engine import get_session
from msgd.db.models import Stream, User
from msgd.events.emit import emit_event

router = APIRouter(prefix="/v1", tags=["me"])

DbSession = Annotated[AsyncSession, Depends(get_session)]


def _status_expired(user: User, now: datetime) -> bool:
    """True when the row carries a status that has lazily expired."""
    return user.status_expires_at is not None and user.status_expires_at <= now


def _me_response(user: User) -> MeResponse:
    """Project the caller's ``users`` row to the self-profile shape.

    Applies LAZY status expiry: an expired status reads as cleared (all three
    status fields ``null``) without touching the row — the module docstring's
    no-background-job contract.
    """
    expired = _status_expired(user, datetime.now(UTC))
    expires_at = user.status_expires_at
    return MeResponse(
        user_id=user.user_id,
        display_name=user.display_name,
        email=user.email,
        role=user.role,
        is_bot=user.is_bot,
        title=user.title,
        description=user.description,
        status_emoji=None if expired else user.status_emoji,
        status_text=None if expired else user.status_text,
        status_expires_at=None if (expired or expires_at is None) else to_rfc3339(expires_at),
    )


def _expiry_from_clear_after(clear_after: str | None, now: datetime) -> datetime | None:
    """Convert the closed ``clear_after`` vocabulary to an absolute expiry.

    Server-side conversion (the client never mints the timestamp): ``30m`` /
    ``1h`` are offsets from now; ``today`` is the end of the current UTC day.
    ``None`` (or an omitted field) means the status never auto-clears. The
    vocabulary is CLOSED at the schema (a 422 upstream), so the fall-through
    ``None`` is unreachable for an unknown string — kept total for safety.
    """
    if clear_after == "30m":
        return now + timedelta(minutes=30)
    if clear_after == "1h":
        return now + timedelta(hours=1)
    if clear_after == "today":
        return datetime.combine(now.date(), time.max, tzinfo=UTC)
    return None


def _apply_status(user: User, status: StatusUpdate | None, now: datetime) -> None:
    """Replace the status trio as a UNIT (``null`` or an all-unset object clears)."""
    if status is None or (status.emoji is None and status.text is None):
        user.status_emoji = None
        user.status_text = None
        user.status_expires_at = None
        return
    user.status_emoji = status.emoji
    user.status_text = status.text
    user.status_expires_at = _expiry_from_clear_after(status.clear_after, now)


@router.get("/me", response_model=MeResponse)
async def get_me(ctx: CurrentAuth) -> MeResponse:
    """The caller's own profile — the row ``require_auth`` already loaded."""
    return _me_response(ctx.user)


# ENG-159 (security review): PATCH /v1/me is a bot-reachable EVENT-LOG WRITE — it
# emits a server-authored ``user.profile_updated`` meta event — so it carries the
# same ``events:write`` verb gate as ``POST /v1/events/batch``. Without it a bot
# holding only ``events:read`` (or no write scope) could rename itself repeatedly
# and append unbounded meta events (the invariant-8 scope contract). Humans
# (``scopes is None``) bypass, so the self-rename golden path is unaffected. GET
# /v1/me stays ungated — it is a pure read of the caller's own identity.
@router.patch(
    "/me", response_model=MeResponse, dependencies=[Depends(require_scope("events:write"))]
)
async def update_me(req: UpdateMeRequest, ctx: CurrentAuth, db: DbSession) -> MeResponse:
    """Apply the provided profile subset; return the updated profile.

    One transaction: lock + update the caller's ``users`` row (the row lock
    serializes concurrent self-PATCHes, mirroring the admin member PATCH), emit
    ONE server-authored ``user.profile_updated`` into the workspace-meta stream
    carrying the RESULTING profile values (authored by the caller on their
    current device, like their ``user.joined``), commit. Validation (bounds,
    the closed ``clear_after`` vocabulary, non-clearable ``display_name``) is
    the schema's — enforced as a 422 upstream.
    """
    user = await db.scalar(select(User).where(User.user_id == ctx.user_id).with_for_update())
    assert user is not None  # require_auth just authenticated this user id
    now = datetime.now(UTC)
    provided = req.model_fields_set
    if "display_name" in provided and req.display_name is not None:
        user.display_name = req.display_name
    if "title" in provided:
        user.title = req.title
    if "description" in provided:
        user.description = req.description
    if "status" in provided:
        _apply_status(user, req.status, now)

    # Setup always creates the single workspace-meta stream (seq 1), so it must
    # exist for any real workspace — same assertion as accept-invite.
    meta_stream_id = await db.scalar(
        select(Stream.stream_id).where(
            Stream.workspace_id == ctx.workspace_id,
            Stream.kind == "workspace-meta",
        )
    )
    assert meta_stream_id is not None
    await emit_event(
        db,
        home_stream_id=meta_stream_id,
        body=build_user_profile_updated_body(
            workspace_id=ctx.workspace_id,
            stream_id=meta_stream_id,
            author_user_id=ctx.user_id,
            author_device_id=ctx.device_id,
            client_created_at=now_rfc3339(),
            user_id=ctx.user_id,
            display_name=user.display_name,
            title=user.title,
            description=user.description,
            status_emoji=user.status_emoji,
            status_text=user.status_text,
            status_expires_at=(
                None if user.status_expires_at is None else to_rfc3339(user.status_expires_at)
            ),
        ),
    )

    await db.commit()
    return _me_response(user)
