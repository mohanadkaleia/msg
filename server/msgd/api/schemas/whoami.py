"""Response schema for ``GET /v1/whoami`` (ENG-179).

The caller's OWN identity — a pure projection of the already-populated
:class:`~msgd.auth.context.AuthContext`. Unlike ``GET /v1/me`` (a human-profile
surface that omits ``device_id`` and ``workspace_id``), this returns exactly the
three ids a client needs to author events (``author_user_id`` /
``author_device_id`` / ``workspace_id`` are validated against the credential on
upload) plus the ``is_bot`` / ``role`` flags. It exposes nothing the caller does
not already know about itself, so it is safe to leave ungated (any valid
credential — human session or bot token — may read its own identity).
"""

from __future__ import annotations

from pydantic import BaseModel


class WhoAmIResponse(BaseModel):
    """The authenticated caller's own identity (``GET /v1/whoami``)."""

    user_id: str
    device_id: str
    workspace_id: str
    is_bot: bool
    role: str
