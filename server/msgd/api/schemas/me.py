"""Self-profile request/response models (``/v1/me``).

``display_name`` reuses the exact :data:`~msgd.api.schemas.auth.DisplayName`
constraint enforced at signup/accept-invite (1..200 chars) — the profile edit
can never mint a name the join paths would have rejected.

ENG-164 richer profile: ``title`` (≤100), ``description`` (≤500) and a custom
``status`` (emoji + text + an optional ``clear_after`` duration). The PATCH is
a SUBSET update — only the fields the caller actually sent are applied
(pydantic ``model_fields_set`` distinguishes "absent" from an explicit
``null``, which CLEARS a field). ``status`` replaces the whole status as a
unit (a status is edited atomically, like every status editor); ``clear_after``
is a closed duration vocabulary the SERVER converts to an absolute
``status_expires_at`` — the client never mints a timestamp, so clock skew
cannot produce an already-expired status. ``status.emoji`` follows the
reaction-emoji discipline (:data:`~msgd.core.payloads.reaction.MAX_EMOJI_BYTES`
— a bounded opaque grapheme, no server-side emoji whitelist) plus a
no-whitespace guard so a sentence cannot masquerade as an emoji.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from msgd.api.schemas.auth import DisplayName
from msgd.core.payloads.reaction import MAX_EMOJI_BYTES

#: Bounds for the ENG-164 profile fields — enforced here as 422s, mirroring the
#: ``DisplayName`` precedent (the row + event payload are never bound-checked).
Title = Annotated[str, Field(max_length=100)]
Description = Annotated[str, Field(max_length=500)]
StatusText = Annotated[str, Field(max_length=100)]

#: The closed ``clear_after`` vocabulary — the server converts each to an
#: absolute ``status_expires_at`` (30/60 minutes from now; ``today`` = the end
#: of the current UTC day). Absent/``null`` means the status never auto-clears.
StatusClearAfter = Literal["30m", "1h", "today"]


class StatusUpdate(BaseModel):
    """The ``status`` object of ``PATCH /v1/me`` — replaces the status as a unit.

    ``emoji``/``text`` may each be ``null`` (that half is unset); when BOTH end
    up unset the status is cleared entirely (there is nothing to show).
    """

    emoji: str | None = None
    text: StatusText | None = None
    clear_after: StatusClearAfter | None = None

    @field_validator("emoji")
    @classmethod
    def _check_emoji(cls, value: str | None) -> str | None:
        """A single emoji grapheme, approximated the way reactions are.

        Same gate as ``reaction.added`` (no whitelist — base emoji, ZWJ
        sequences, skin tones and keycaps all pass; see the reaction module
        docstring): non-empty, ≤ ``MAX_EMOJI_BYTES`` UTF-8 bytes; plus a
        no-whitespace guard so multi-word text cannot ride the emoji slot.
        An empty string normalizes to ``null`` (= unset).
        """
        if value is None or value == "":
            return None
        if any(ch.isspace() for ch in value):
            raise ValueError("status emoji must be a single emoji (no whitespace)")
        n = len(value.encode("utf-8"))
        if n > MAX_EMOJI_BYTES:
            raise ValueError(
                f"status emoji is {n} bytes UTF-8, exceeds the {MAX_EMOJI_BYTES}-byte limit"
            )
        return value

    @field_validator("text")
    @classmethod
    def _normalize_text(cls, value: str | None) -> str | None:
        """An empty status text is "unset", never an empty string."""
        return None if value == "" else value


class MeResponse(BaseModel):
    """The caller's own profile (``GET /v1/me`` / the ``PATCH /v1/me`` echo).

    Mirrors the admin roster's ``MemberInfo`` field naming, minus the admin-only
    ``deactivated`` flag (a deactivated user cannot authenticate, so it would
    always be ``False`` here). ``email`` is the caller's OWN address — no other
    user's email ever leaves this self-scoped surface.

    The ENG-164 fields are ``null`` when unset. ``status_expires_at`` is an
    RFC 3339 string; the handler applies LAZY expiry before projecting the row
    (an expired status reads as cleared — nulls — with no background job),
    matching how the client fold/UI treats the event-carried timestamp.
    """

    user_id: str
    display_name: str
    email: str
    role: str
    is_bot: bool
    title: str | None = None
    description: str | None = None
    status_emoji: str | None = None
    status_text: str | None = None
    status_expires_at: str | None = None


class UpdateMeRequest(BaseModel):
    """``PATCH /v1/me`` — the editable profile surface (subset semantics).

    Every field is optional; ONLY the fields present in the request body are
    applied (``model_fields_set``). An explicit ``null`` clears ``title`` /
    ``description`` / ``status``; ``display_name`` is NOT clearable (the column
    is NOT NULL — an explicit ``null`` is a 422). An empty body updates nothing
    and is rejected (422), preserving the pre-ENG-164 behavior of ``{}``.
    """

    display_name: DisplayName | None = None
    title: Title | None = None
    description: Description | None = None
    status: StatusUpdate | None = None

    @field_validator("title", "description")
    @classmethod
    def _normalize_empty(cls, value: str | None) -> str | None:
        """An empty string means "clear", same as an explicit ``null``."""
        return None if value == "" else value

    @model_validator(mode="after")
    def _check_shape(self) -> UpdateMeRequest:
        provided = self.model_fields_set
        if not provided:
            raise ValueError("at least one profile field must be provided")
        if "display_name" in provided and self.display_name is None:
            raise ValueError("display_name cannot be cleared")
        return self
