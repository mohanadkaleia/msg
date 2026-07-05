"""Problem+json error convention across the API (RFC 9457, §3.2)."""

from __future__ import annotations

from authutil import (
    accept_invite,
    auth_header,
    create_invite,
    do_setup,
    join_token,
)
from httpx import AsyncClient, Response

PROBLEM = "application/problem+json"
_REQUIRED = {"type", "title", "status"}


def _assert_problem(resp: Response, status: int) -> dict[str, object]:
    assert resp.status_code == status
    assert resp.headers["content-type"] == PROBLEM
    body: dict[str, object] = resp.json()
    assert _REQUIRED <= set(body)
    assert body["status"] == status
    return body


async def test_missing_authorization_401(client: AsyncClient) -> None:
    """A protected endpoint with no Authorization header → 401 problem+json."""
    resp = await client.get("/v1/auth/sessions")
    body = _assert_problem(resp, 401)
    assert body["type"] == "/problems/unauthenticated"


async def test_malformed_authorization_401(client: AsyncClient) -> None:
    """A non-Bearer / empty Authorization header → 401 problem+json."""
    for header in ({"Authorization": "Basic zzz"}, {"Authorization": "Bearer "}):
        resp = await client.get("/v1/auth/sessions", headers=header)
        _assert_problem(resp, 401)


async def test_validation_error_422(client: AsyncClient) -> None:
    """A schema violation surfaces as 422 problem+json (not FastAPI's default)."""
    resp = await client.post("/v1/auth/login", json={"email": "x"})
    body = _assert_problem(resp, 422)
    assert body["type"] == "/problems/validation-error"


async def test_unknown_route_404(client: AsyncClient) -> None:
    """Even framework 404s are normalized to problem+json."""
    resp = await client.get("/v1/does-not-exist")
    _assert_problem(resp, 404)


async def test_forbidden_403(client: AsyncClient) -> None:
    """A role-gated endpoint refused for a member → 403 problem+json."""
    owner_token = (await do_setup(client))["token"]
    invite = await create_invite(client, owner_token, role="member")
    raw = join_token(invite.json()["url"])
    member_token = (await accept_invite(client, raw, email="mm@example.com")).json()["token"]

    resp = await client.post(
        "/v1/admin/invites", json={"role": "member"}, headers=auth_header(member_token)
    )
    body = _assert_problem(resp, 403)
    assert body["type"] == "/problems/forbidden"
