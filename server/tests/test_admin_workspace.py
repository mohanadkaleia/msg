"""Workspace settings surface — GET/PATCH ``/v1/admin/workspace`` (ENG-152).

The teeth: the PATCH persists name/description to the ``workspaces`` row and
returns them; validation mirrors the setup bound (name 1..200, description
≤1000, empty PATCH 422); the surface is owner/admin only (member/guest 403);
each PATCH appends exactly ONE server-authored ``workspace.updated`` carrying
exactly the changed fields; a CLIENT upload of ``workspace.updated`` is
rejected ``permission_denied`` (the SERVER_AUTHORED guard — without it any
member could rename the workspace on every client); and the export manifest
reflects the updated values so a bundle round-trips them.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from authutil import (
    accept_invite,
    auth_header,
    create_invite,
    do_setup,
    fetch_meta_stream_id,
    fetch_stream_events,
    join_token,
)
from eventsutil import post_batch, wire_item
from httpx import AsyncClient
from msgd.core import ids
from msgd.core.time import now_rfc3339
from msgd.db.models import Workspace
from sqlalchemy.ext.asyncio import AsyncSession

# --- seeding -------------------------------------------------------------------


async def _seed_role(client: AsyncClient, owner_token: str, role: str) -> dict[str, Any]:
    """Invite + accept a user with ``role``; return their login body."""
    inv = await create_invite(client, owner_token, role=role)
    raw = join_token(inv.json()["url"])
    body: dict[str, Any] = (await accept_invite(client, raw, email=f"{role}@example.com")).json()
    return body


# --- read ------------------------------------------------------------------------


async def test_get_workspace_returns_the_settings_row(client: AsyncClient) -> None:
    """GET returns the setup name, a null (never-set) description, and the id."""
    owner = await do_setup(client)
    resp = await client.get("/v1/admin/workspace", headers=auth_header(owner["token"]))
    assert resp.status_code == 200
    assert resp.json() == {
        "workspace_id": owner["workspace_id"],
        "name": "Acme",
        "description": None,
    }


async def test_workspace_surface_is_owner_admin_only(client: AsyncClient) -> None:
    """Member and guest are 403'd on BOTH verbs; no bearer is a 401; admin passes."""
    owner = await do_setup(client)
    admin = await _seed_role(client, owner["token"], "admin")

    assert (await client.get("/v1/admin/workspace")).status_code == 401
    assert (await client.patch("/v1/admin/workspace", json={"name": "X"})).status_code == 401

    for role in ("member", "guest"):
        who = await _seed_role(client, owner["token"], role)
        h = auth_header(who["token"])
        assert (await client.get("/v1/admin/workspace", headers=h)).status_code == 403, role
        resp = await client.patch("/v1/admin/workspace", json={"name": "Nope"}, headers=h)
        assert resp.status_code == 403, role

    # An admin (not only the owner) may read and write the settings.
    h = auth_header(admin["token"])
    assert (await client.get("/v1/admin/workspace", headers=h)).status_code == 200
    resp = await client.patch("/v1/admin/workspace", json={"name": "Adminland"}, headers=h)
    assert resp.status_code == 200
    assert resp.json()["name"] == "Adminland"


# --- update -----------------------------------------------------------------------


async def test_patch_updates_name_and_description_and_persists(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """PATCH returns the new values; the row and a fresh GET agree."""
    owner = await do_setup(client)
    h = auth_header(owner["token"])

    resp = await client.patch(
        "/v1/admin/workspace",
        json={"name": "Acme Corp", "description": "Where widgets happen"},
        headers=h,
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "workspace_id": owner["workspace_id"],
        "name": "Acme Corp",
        "description": "Where widgets happen",
    }

    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None
    assert row.name == "Acme Corp"
    assert row.description == "Where widgets happen"
    assert (await client.get("/v1/admin/workspace", headers=h)).json() == resp.json()


async def test_patch_fields_are_presence_significant(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """An absent field is UNCHANGED; ``description: ""`` explicitly clears it."""
    owner = await do_setup(client)
    h = auth_header(owner["token"])

    # Set a description, then rename only — the description must survive.
    await client.patch("/v1/admin/workspace", json={"description": "Keep me"}, headers=h)
    resp = await client.patch("/v1/admin/workspace", json={"name": "Renamed"}, headers=h)
    assert resp.json() == {
        "workspace_id": owner["workspace_id"],
        "name": "Renamed",
        "description": "Keep me",
    }

    # Description-only PATCH leaves the name; "" clears the description.
    resp = await client.patch("/v1/admin/workspace", json={"description": ""}, headers=h)
    assert resp.json()["name"] == "Renamed"
    assert resp.json()["description"] == ""

    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.name == "Renamed" and row.description == ""


async def test_patch_validation_mirrors_the_setup_bounds(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Empty/oversized name, oversized description, and an empty PATCH are 422s."""
    owner = await do_setup(client)
    h = auth_header(owner["token"])

    for bad in ({"name": ""}, {"name": "x" * 201}, {"description": "x" * 1001}, {}):
        resp = await client.patch("/v1/admin/workspace", json=bad, headers=h)
        assert resp.status_code == 422, bad
        assert resp.json()["type"] == "/problems/validation-error"

    # Nothing changed and nothing was appended by the rejected PATCHes.
    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.name == "Acme" and row.description is None
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    events = await fetch_stream_events(db_session, meta_stream_id)
    assert all(e.type != "workspace.updated" for e in events)


# --- the meta event ------------------------------------------------------------


async def test_patch_emits_exactly_one_workspace_updated(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """One PATCH → ONE ``workspace.updated`` carrying exactly the changed fields.

    The client workspace-identity fold renames the switcher/header from this
    event, so it must be authored by the acting admin and carry ONLY what
    changed (presence-significant: an untouched field must be ABSENT, so a
    fold never misreads "unchanged" as "cleared").
    """
    owner = await do_setup(client)
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    resp = await client.patch(
        "/v1/admin/workspace", json={"name": "Acme Corp"}, headers=auth_header(owner["token"])
    )
    assert resp.status_code == 200

    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before) + 1
    event = after[-1]
    assert event.type == "workspace.updated"
    body = event.body
    assert body["author_user_id"] == owner["user_id"]
    assert body["payload"] == {"name": "Acme Corp"}  # description ABSENT, not null


async def test_patch_description_only_event_omits_the_name(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A description-only PATCH emits a payload WITHOUT ``name``."""
    owner = await do_setup(client)
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None

    resp = await client.patch(
        "/v1/admin/workspace",
        json={"description": "All about Acme"},
        headers=auth_header(owner["token"]),
    )
    assert resp.status_code == 200

    events = await fetch_stream_events(db_session, meta_stream_id)
    assert events[-1].type == "workspace.updated"
    assert events[-1].body["payload"] == {"description": "All about Acme"}


# --- forged upload (the SERVER_AUTHORED guard) -----------------------------------


def _forged_body(
    *, auth: dict[str, Any], home_stream_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """A ``workspace.updated`` body forged by a CLIENT (author = the session)."""
    return {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": home_stream_id,
        "type": "workspace.updated",
        "type_version": 1,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": payload,
    }


async def test_forged_workspace_updated_upload_is_rejected(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """A member uploading ``workspace.updated`` is rejected ``permission_denied``.

    Without the SERVER_AUTHORED guard this would append to workspace-meta and
    rename the workspace in every client's fold — a member exercising an
    owner/admin privilege. Nothing may be appended and the row must not change.
    """
    owner = await do_setup(client)
    member = await _seed_role(client, owner["token"], "member")
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None
    before = await fetch_stream_events(db_session, meta_stream_id)

    forged = _forged_body(auth=member, home_stream_id=meta_stream_id, payload={"name": "PWNED"})
    resp = await post_batch(client, member["token"], [wire_item(forged)])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] == []
    assert len(body["rejected"]) == 1
    assert body["rejected"][0]["code"] == "permission_denied"

    after = await fetch_stream_events(db_session, meta_stream_id)
    assert len(after) == len(before)
    row = await db_session.get(Workspace, owner["workspace_id"])
    assert row is not None and row.name == "Acme"


async def test_forged_workspace_updated_by_owner_is_rejected_too(
    client: AsyncClient, db_session: AsyncSession
) -> None:
    """Even the OWNER cannot upload the type — the PATCH handler is the only producer."""
    owner = await do_setup(client)
    meta_stream_id = await fetch_meta_stream_id(db_session, owner["workspace_id"])
    assert meta_stream_id is not None

    forged = _forged_body(auth=owner, home_stream_id=meta_stream_id, payload={"name": "Side door"})
    resp = await post_batch(client, owner["token"], [wire_item(forged)])
    assert resp.status_code == 200, resp.text
    assert resp.json()["rejected"][0]["code"] == "permission_denied"


# --- export consistency ----------------------------------------------------------


async def test_export_manifest_reflects_the_updated_values(
    client: AsyncClient, db_session: AsyncSession, tmp_path: Path
) -> None:
    """``manifest.workspace`` carries the post-PATCH name + description.

    The export reads the same ``workspaces`` row the PATCH writes, so a bundle
    taken after a rename round-trips the CURRENT values (import re-creates the
    row from the manifest, not from the genesis event's original name).
    """
    import json

    from msgd.blobs.store import LocalDiskBlobStore
    from msgd.export.bundle import export_workspace

    owner = await do_setup(client)
    resp = await client.patch(
        "/v1/admin/workspace",
        json={"name": "Acme Corp", "description": "Post-rename"},
        headers=auth_header(owner["token"]),
    )
    assert resp.status_code == 200

    dest = tmp_path / "bundle"
    await export_workspace(
        db_session,
        LocalDiskBlobStore(tmp_path / "blobs"),
        dest,
        exported_at="2026-07-09T00:00:00.000Z",
        tool="test",
    )
    manifest = json.loads((dest / "manifest.json").read_text())
    assert manifest["workspace"]["name"] == "Acme Corp"
    assert manifest["workspace"]["description"] == "Post-rename"
