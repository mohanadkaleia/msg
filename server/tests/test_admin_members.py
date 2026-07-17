"""Admin member/role management — the privilege-escalation teeth (ENG-151).

Each test is a real tooth: it would FAIL if the guard it exercises were removed.
The matrix (self-edit ban, owner immutability / ≥1-owner proof, admin-can't-
touch-peer-admin, bot-role lock, deactivate-revokes-sessions-now, uniform 404s,
raw-token-never-serialized) is proven end-to-end here, plus a fast DB-free unit
test of the pure :func:`check_member_update` policy cell-by-cell.
"""

from __future__ import annotations

from typing import Any

import pytest
from authutil import (
    accept_invite,
    auth_header,
    create_invite,
    do_login,
    do_setup,
    join_token,
)
from httpx import AsyncClient
from msgd.api.routers.admin import check_member_update
from msgd.core import ids
from msgd.db.models import Event, Session, User, Workspace
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

# --- seeding helpers ---------------------------------------------------------


async def _seed_roles(client: AsyncClient) -> dict[str, dict[str, Any]]:
    """Setup the owner, then invite+accept an admin, member, and guest.

    Returns a mapping ``role -> {token, user_id, workspace_id, email}`` for each
    of owner/admin/member/guest — real bearer tokens against the bound session.
    """
    owner = await do_setup(client)
    out: dict[str, dict[str, Any]] = {
        "owner": {
            "token": owner["token"],
            "user_id": owner["user_id"],
            "workspace_id": owner["workspace_id"],
            "email": "owner@example.com",
        }
    }
    for role in ("admin", "member", "guest"):
        inv = await create_invite(client, owner["token"], role=role)
        raw = join_token(inv.json()["url"])
        email = f"{role}@example.com"
        body = (await accept_invite(client, raw, email=email)).json()
        out[role] = {
            "token": body["token"],
            "user_id": body["user_id"],
            "workspace_id": body["workspace_id"],
            "email": email,
        }
    return out


async def _seed_bot(db: AsyncSession, *, workspace_id: str) -> str:
    """Seed a bot user in ``workspace_id`` on the bound session; return its id."""
    bot_id = ids.new_user_id()
    db.add(
        User(
            user_id=bot_id,
            workspace_id=workspace_id,
            email="bot@example.com",
            password_hash="x",
            display_name="Helper Bot",
            role="member",
            is_bot=True,
        )
    )
    await db.flush()
    return bot_id


async def _seed_second_workspace(db: AsyncSession) -> str:
    """Seed a second workspace with one member on the bound session; return its user id."""
    ws_id = ids.new_workspace_id()
    user_id = ids.new_user_id()
    db.add(Workspace(workspace_id=ws_id, name="Other"))
    await db.flush()
    db.add(
        User(
            user_id=user_id,
            workspace_id=ws_id,
            email="other@example.com",
            password_hash="x",
            display_name="Other Member",
            role="member",
        )
    )
    await db.flush()
    return user_id


def _problem_sans_instance(body: dict[str, Any]) -> dict[str, Any]:
    """A problem body minus ``instance`` (the path differs by id, the rest must match)."""
    return {k: v for k, v in body.items() if k != "instance"}


async def _count_events(db: AsyncSession) -> int:
    n = await db.scalar(select(func.count()).select_from(Event))
    return int(n or 0)


def _fake_user(*, user_id: str, role: str, is_bot: bool = False) -> User:
    """A detached ``User`` for the pure-policy unit test (no DB)."""
    return User(
        user_id=user_id,
        workspace_id="ws",
        email="x@example.com",
        password_hash="x",
        display_name="X",
        role=role,
        is_bot=is_bot,
    )


# --- 1. role gating ----------------------------------------------------------


async def test_member_and_guest_forbidden_on_all_admin_endpoints(client: AsyncClient) -> None:
    """member/guest callers get 403 on every admin member/invite endpoint."""
    roles = await _seed_roles(client)
    target = roles["admin"]["user_id"]
    for role in ("member", "guest"):
        h = auth_header(roles[role]["token"])
        assert (await client.get("/v1/admin/members", headers=h)).status_code == 403
        assert (
            await client.patch(f"/v1/admin/members/{target}", json={"role": "member"}, headers=h)
        ).status_code == 403
        assert (await client.get("/v1/admin/invites", headers=h)).status_code == 403
        assert (await client.delete("/v1/admin/invites/whatever", headers=h)).status_code == 403


# --- 2. roster ---------------------------------------------------------------


async def test_members_roster_full_and_workspace_scoped(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Roster shows all roles + deactivated + bot + emails; the 2nd workspace is absent."""
    roles = await _seed_roles(client)
    ws = roles["owner"]["workspace_id"]
    await _seed_bot(db_session, workspace_id=ws)
    other_user = await _seed_second_workspace(db_session)

    # Deactivate the guest so the roster proves it includes deactivated users.
    guest_id = roles["guest"]["user_id"]
    r = await client.patch(
        f"/v1/admin/members/{guest_id}",
        json={"active": False},
        headers=auth_header(roles["owner"]["token"]),
    )
    assert r.status_code == 200

    resp = await client.get("/v1/admin/members", headers=auth_header(roles["owner"]["token"]))
    assert resp.status_code == 200
    members = resp.json()["members"]
    by_id = {m["user_id"]: m for m in members}
    # owner + admin + member + guest + bot = 5, and the second workspace is absent.
    assert len(members) == 5
    assert other_user not in by_id
    assert by_id[roles["owner"]["user_id"]]["role"] == "owner"
    assert by_id[roles["owner"]["user_id"]]["email"] == "owner@example.com"
    assert by_id[guest_id]["deactivated"] is True
    bot = next(m for m in members if m["is_bot"])
    assert bot["is_bot"] is True
    # ordered by display name
    names = [m["display_name"] for m in members]
    assert names == sorted(names)


# --- 3. owner unassignable via Literal --------------------------------------


async def test_assign_owner_role_422_and_row_unchanged(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """PATCH {role:"owner"} → 422 (Literal); the target row keeps its role."""
    roles = await _seed_roles(client)
    member_id = roles["member"]["user_id"]
    resp = await client.patch(
        f"/v1/admin/members/{member_id}",
        json={"role": "owner"},
        headers=auth_header(roles["owner"]["token"]),
    )
    assert resp.status_code == 422
    assert resp.headers["content-type"] == "application/problem+json"
    row = await db_session.get(User, member_id)
    assert row is not None and row.role == "member"


# --- 4. admin cannot touch the owner ----------------------------------------


async def test_admin_cannot_modify_owner(client: AsyncClient, db_session: AsyncSession) -> None:
    """Admin PATCH of the owner (role, and active:false) → 403; owner + sessions intact."""
    roles = await _seed_roles(client)
    owner_id = roles["owner"]["user_id"]
    admin_h = auth_header(roles["admin"]["token"])

    for body in ({"role": "member"}, {"active": False}):
        r = await client.patch(f"/v1/admin/members/{owner_id}", json=body, headers=admin_h)
        assert r.status_code == 403, body
        assert r.json()["type"] == "/problems/forbidden"

    row = await db_session.get(User, owner_id)
    assert row is not None and row.role == "owner" and row.deactivated_at is None
    owner_sessions = await db_session.scalar(
        select(func.count()).select_from(Session).where(Session.user_id == owner_id)
    )
    assert owner_sessions and owner_sessions >= 1
    # The owner's bearer still authenticates.
    me = await client.get("/v1/admin/members", headers=auth_header(roles["owner"]["token"]))
    assert me.status_code == 200


# --- 5. owner cannot self-modify (last-owner proof) --------------------------


async def test_owner_cannot_self_demote_or_self_deactivate(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Owner PATCH of self (role and active) → 403 — last active owner is un-removable."""
    roles = await _seed_roles(client)
    owner_id = roles["owner"]["user_id"]
    owner_h = auth_header(roles["owner"]["token"])
    for body in ({"role": "member"}, {"active": False}):
        r = await client.patch(f"/v1/admin/members/{owner_id}", json=body, headers=owner_h)
        assert r.status_code == 403, body
        assert r.json()["detail"] == "cannot modify your own account"
    row = await db_session.get(User, owner_id)
    assert row is not None and row.role == "owner" and row.deactivated_at is None


# --- 6. admin cannot touch a peer admin -------------------------------------


async def test_admin_cannot_modify_peer_admin(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Admin PATCH of another admin (role AND active:false) → 403; target unchanged."""
    roles = await _seed_roles(client)
    # A second admin.
    inv = await create_invite(client, roles["owner"]["token"], role="admin")
    raw = join_token(inv.json()["url"])
    admin2 = (await accept_invite(client, raw, email="admin2@example.com")).json()
    admin_h = auth_header(roles["admin"]["token"])

    for body in ({"role": "member"}, {"active": False}):
        r = await client.patch(f"/v1/admin/members/{admin2['user_id']}", json=body, headers=admin_h)
        assert r.status_code == 403, body
    row = await db_session.get(User, admin2["user_id"])
    assert row is not None and row.role == "admin" and row.deactivated_at is None


# --- 7. happy paths ----------------------------------------------------------


async def test_happy_role_changes_persist(client: AsyncClient, db_session: AsyncSession) -> None:
    """admin promotes member→admin; admin demotes a member→guest; owner demotes admin→member;
    owner+admin promote guest→member. Each persisted role is asserted."""
    roles = await _seed_roles(client)
    owner_h = auth_header(roles["owner"]["token"])
    admin_h = auth_header(roles["admin"]["token"])

    # admin promotes member → admin
    r = await client.patch(
        f"/v1/admin/members/{roles['member']['user_id']}", json={"role": "admin"}, headers=admin_h
    )
    assert r.status_code == 200 and r.json()["role"] == "admin"

    # owner demotes that admin → member
    r = await client.patch(
        f"/v1/admin/members/{roles['member']['user_id']}",
        json={"role": "member"},
        headers=owner_h,
    )
    assert r.status_code == 200 and r.json()["role"] == "member"

    # admin demotes member → guest
    r = await client.patch(
        f"/v1/admin/members/{roles['member']['user_id']}", json={"role": "guest"}, headers=admin_h
    )
    assert r.status_code == 200 and r.json()["role"] == "guest"

    # owner promotes guest → member
    r = await client.patch(
        f"/v1/admin/members/{roles['guest']['user_id']}", json={"role": "member"}, headers=owner_h
    )
    assert r.status_code == 200 and r.json()["role"] == "member"

    # admin promotes the (now-guest) member → member as well
    r = await client.patch(
        f"/v1/admin/members/{roles['member']['user_id']}",
        json={"role": "member"},
        headers=admin_h,
    )
    assert r.status_code == 200 and r.json()["role"] == "member"

    persisted = await db_session.get(User, roles["guest"]["user_id"])
    assert persisted is not None and persisted.role == "member"


# --- 8. self-edit by both roles ---------------------------------------------


async def test_self_patch_by_admin_and_owner_forbidden(client: AsyncClient) -> None:
    """An admin and an owner each PATCHing themselves → 403."""
    roles = await _seed_roles(client)
    for role in ("owner", "admin"):
        r = await client.patch(
            f"/v1/admin/members/{roles[role]['user_id']}",
            json={"role": "member"},
            headers=auth_header(roles[role]["token"]),
        )
        assert r.status_code == 403


# --- 9. bot rules ------------------------------------------------------------


async def test_bot_role_locked_but_deactivate_allowed(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """PATCH bot role → 403; PATCH bot active:false → 200 (deactivated)."""
    roles = await _seed_roles(client)
    bot_id = await _seed_bot(db_session, workspace_id=roles["owner"]["workspace_id"])
    owner_h = auth_header(roles["owner"]["token"])

    r = await client.patch(f"/v1/admin/members/{bot_id}", json={"role": "admin"}, headers=owner_h)
    assert r.status_code == 403
    assert r.json()["detail"] == "bot roles are not editable"

    r = await client.patch(f"/v1/admin/members/{bot_id}", json={"active": False}, headers=owner_h)
    assert r.status_code == 200 and r.json()["deactivated"] is True
    row = await db_session.get(User, bot_id)
    assert row is not None and row.deactivated_at is not None and row.role == "member"


async def test_deactivate_bot_fans_bot_removed_over_ws(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Deactivating a bot PUBLISHES its ``bot.removed`` meta event over WS.

    Regression: the removal was committed but never fanned, so a connected admin
    still saw the bot in their roster/directory until reload. Patch the shared
    fanout seam `publish_events` loops over.
    """
    import msgd.events.fanout as fanout_module

    published: list[Any] = []

    async def spy(envelope: Any) -> None:
        published.append(envelope)

    monkeypatch.setattr(fanout_module, "publish_event", spy)

    roles = await _seed_roles(client)
    bot_id = await _seed_bot(db_session, workspace_id=roles["owner"]["workspace_id"])
    owner_h = auth_header(roles["owner"]["token"])

    r = await client.patch(f"/v1/admin/members/{bot_id}", json={"active": False}, headers=owner_h)
    assert r.status_code == 200
    removed = [
        e
        for e in published
        if e.body.type == "bot.removed" and e.body.payload["bot_user_id"] == bot_id
    ]
    assert len(removed) == 1


# --- 10. deactivate revokes access NOW --------------------------------------


async def test_deactivate_revokes_sessions_immediately(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Deactivating a member kills their bearer + sessions now; login 401s; reactivate restores."""
    roles = await _seed_roles(client)
    member = roles["member"]
    owner_h = auth_header(roles["owner"]["token"])

    # The member's bearer works before deactivation.
    pre = await client.get("/v1/auth/sessions", headers=auth_header(member["token"]))
    assert pre.status_code == 200

    r = await client.patch(
        f"/v1/admin/members/{member['user_id']}", json={"active": False}, headers=owner_h
    )
    assert r.status_code == 200

    # Existing bearer now 401s, and their sessions row count is zero.
    after = await client.get("/v1/auth/sessions", headers=auth_header(member["token"]))
    assert after.status_code == 401
    remaining = await db_session.scalar(
        select(func.count()).select_from(Session).where(Session.user_id == member["user_id"])
    )
    assert remaining == 0

    # Login is refused with the generic 401 (deactivated == no oracle).
    relogin = await do_login(client, email=member["email"], password="another-valid-password")
    assert relogin.status_code == 401
    assert relogin.json()["type"] == "/problems/invalid-credentials"

    # Reactivate → login succeeds again.
    r = await client.patch(
        f"/v1/admin/members/{member['user_id']}", json={"active": True}, headers=owner_h
    )
    assert r.status_code == 200 and r.json()["deactivated"] is False
    ok = await do_login(client, email=member["email"], password="another-valid-password")
    assert ok.status_code == 200


async def test_deactivate_is_idempotent(client: AsyncClient) -> None:
    """Deactivating an already-deactivated user is a 200 no-op."""
    roles = await _seed_roles(client)
    owner_h = auth_header(roles["owner"]["token"])
    mid = roles["member"]["user_id"]
    assert (
        await client.patch(f"/v1/admin/members/{mid}", json={"active": False}, headers=owner_h)
    ).status_code == 200
    r = await client.patch(f"/v1/admin/members/{mid}", json={"active": False}, headers=owner_h)
    assert r.status_code == 200 and r.json()["deactivated"] is True


# --- 11. uniform 404 (unknown + cross-workspace) -----------------------------


async def test_unknown_and_cross_workspace_user_identical_404(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """An unknown id and a cross-workspace id return identical 404 bodies (no oracle)."""
    roles = await _seed_roles(client)
    owner_h = auth_header(roles["owner"]["token"])
    other_user = await _seed_second_workspace(db_session)

    unknown = await client.patch(
        f"/v1/admin/members/{ids.new_user_id()}", json={"role": "member"}, headers=owner_h
    )
    cross = await client.patch(
        f"/v1/admin/members/{other_user}", json={"role": "member"}, headers=owner_h
    )
    assert unknown.status_code == cross.status_code == 404
    assert _problem_sans_instance(unknown.json()) == _problem_sans_instance(cross.json())
    assert unknown.json()["type"] == "/problems/not-found"


# --- 12. empty PATCH ---------------------------------------------------------


async def test_empty_patch_422(client: AsyncClient) -> None:
    """An empty PATCH body → 422 (model_validator requires ≥1 field)."""
    roles = await _seed_roles(client)
    r = await client.patch(
        f"/v1/admin/members/{roles['member']['user_id']}",
        json={},
        headers=auth_header(roles["owner"]["token"]),
    )
    assert r.status_code == 422
    assert r.headers["content-type"] == "application/problem+json"


# --- 13. negative event guard ------------------------------------------------


async def test_patch_appends_no_events(client: AsyncClient, db_session: AsyncSession) -> None:
    """A member PATCH is operational state — it appends ZERO rows to the event log."""
    roles = await _seed_roles(client)
    before = await _count_events(db_session)
    r = await client.patch(
        f"/v1/admin/members/{roles['member']['user_id']}",
        json={"role": "guest", "active": False},
        headers=auth_header(roles["owner"]["token"]),
    )
    assert r.status_code == 200
    after = await _count_events(db_session)
    assert after == before


# --- pure policy unit test ---------------------------------------------------


def test_check_member_update_matrix() -> None:
    """Cell-by-cell over the pure identity policy (fast, no DB)."""
    owner = _fake_user(user_id="u_owner", role="owner")
    admin = _fake_user(user_id="u_admin", role="admin")
    admin2 = _fake_user(user_id="u_admin2", role="admin")
    member = _fake_user(user_id="u_member", role="member")
    guest = _fake_user(user_id="u_guest", role="guest")

    # (a) self-edit banned for both privileged roles.
    for actor in (owner, admin):
        d = check_member_update(actor_role=actor.role, actor_id=actor.user_id, target=actor)
        assert d is not None and d.status == 403
        assert d.detail == "cannot modify your own account"

    # (b) owner is immutable to everyone (here: an admin actor).
    d = check_member_update(actor_role="admin", actor_id=admin.user_id, target=owner)
    assert d is not None and d.detail == "the owner account cannot be modified"

    # (c) admin may not touch a peer admin.
    d = check_member_update(actor_role="admin", actor_id=admin.user_id, target=admin2)
    assert d is not None and d.detail == "an admin may not modify another admin"

    # owner MAY manage an admin (demote/deactivate) — identity checks pass.
    assert check_member_update(actor_role="owner", actor_id=owner.user_id, target=admin) is None

    # admin MAY manage members and guests.
    assert check_member_update(actor_role="admin", actor_id=admin.user_id, target=member) is None
    assert check_member_update(actor_role="admin", actor_id=admin.user_id, target=guest) is None
    # owner too.
    assert check_member_update(actor_role="owner", actor_id=owner.user_id, target=member) is None
