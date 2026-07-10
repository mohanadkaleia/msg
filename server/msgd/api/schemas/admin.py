"""Admin request/response schemas (ENG-151): member roster + role management + invites.

Role assignment is a PRIVILEGE-ESCALATION surface, so the boundary is locked
structurally: :class:`UpdateMemberRequest.role` is a Literal that EXCLUDES
``owner`` — mirroring :class:`~msgd.api.schemas.auth.CreateInviteRequest` — so
no API request can ever *assign* the owner role. Combined with the router-side
rule that an existing owner row is immutable, ``owner`` is only ever set at
``/v1/setup`` and the workspace always keeps ≥1 active owner (see
``routers/admin.py:check_member_update`` for the proof).

:class:`MemberInfo` exposes emails deliberately: this is the ADMIN surface of a
self-hosted server, and the admin invited each member by email in the first
place. The client-facing ``directory.list`` projection stays name-only —
member emails never leave the owner/admin-gated ``/v1/admin`` prefix.

:class:`InviteInfo.id` is the invite's sha256 ``token_hash`` — irreversible,
usable only as a revoke handle (the same "not a credential" precedent as
``GET /v1/auth/sessions``). The RAW invite token appears in no admin response:
it was returned exactly once at create time and is never persisted.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

__all__ = [
    "MemberInfo",
    "MemberListResponse",
    "UpdateMemberRequest",
    "InviteInfo",
    "InviteListResponse",
    "WorkspaceInfo",
    "UpdateWorkspaceRequest",
    "WORKSPACE_DESCRIPTION_MAX_LENGTH",
]

#: Bound on the free-text workspace description (ENG-152).
WORKSPACE_DESCRIPTION_MAX_LENGTH = 1000

#: Same constraint as ``SetupRequest.workspace_name`` (1..200) — the rename
#: cannot mint a name ``/v1/setup`` could not have.
WorkspaceName = Annotated[str, Field(min_length=1, max_length=200)]

#: ``""`` is a VALID value (it clears the description) — absence means unchanged.
WorkspaceDescription = Annotated[str, Field(max_length=WORKSPACE_DESCRIPTION_MAX_LENGTH)]


class MemberInfo(BaseModel):
    """One workspace member in the admin roster (GET /v1/admin/members).

    ``deactivated`` is the boolean projection of ``users.deactivated_at IS NOT
    NULL`` — the timestamp itself is not exposed (the UI only needs the state).
    ``is_bot`` lets the UI render bot rows distinctly (their role is not
    editable; see the PATCH authz rules).
    """

    user_id: str
    display_name: str
    email: str
    role: str
    is_bot: bool
    deactivated: bool


class MemberListResponse(BaseModel):
    members: list[MemberInfo]


class UpdateMemberRequest(BaseModel):
    """PATCH /v1/admin/members/{user_id} — change role and/or active state.

    ``role`` excludes ``owner`` by Literal (422 at the boundary): the owner role
    is structurally unassignable via the API, exactly like invite creation. An
    empty PATCH is rejected 422 — a body must request at least one change.
    """

    role: Literal["admin", "member", "guest"] | None = None
    active: bool | None = None

    @model_validator(mode="after")
    def _require_a_change(self) -> UpdateMemberRequest:
        if self.role is None and self.active is None:
            raise ValueError("at least one of 'role' or 'active' must be provided")
        return self


class WorkspaceInfo(BaseModel):
    """The workspace settings row (GET/PATCH /v1/admin/workspace, ENG-152).

    ``description`` is ``None`` when never set; ``""`` when explicitly cleared
    (the row stores what the admin last sent, verbatim). The workspace icon is
    a separate follow-up (it shares the avatar image-upload work).
    """

    workspace_id: str
    name: str
    description: str | None


class UpdateWorkspaceRequest(BaseModel):
    """PATCH /v1/admin/workspace — change the workspace name and/or description.

    PRESENCE-SIGNIFICANT fields, mirroring :class:`UpdateMemberRequest`: an
    absent field is unchanged, and an empty PATCH is a 422. ``name`` reuses the
    ``/v1/setup`` bound (1..200 — non-empty); ``description`` may be ``""``
    (clears it), bounded at ``WORKSPACE_DESCRIPTION_MAX_LENGTH``.
    """

    name: WorkspaceName | None = None
    description: WorkspaceDescription | None = None

    @model_validator(mode="after")
    def _require_a_change(self) -> UpdateWorkspaceRequest:
        if self.name is None and self.description is None:
            raise ValueError("at least one of 'name' or 'description' must be provided")
        return self


class InviteInfo(BaseModel):
    """One PENDING invite (GET /v1/admin/invites).

    ``id`` is the sha256 ``token_hash`` — the revoke handle, not a credential
    (it cannot be reversed to the join token; sessions-list precedent). The raw
    token is never serialized here or anywhere else after create.
    """

    id: str
    role: str
    created_by: str
    expires_at: datetime


class InviteListResponse(BaseModel):
    invites: list[InviteInfo]
