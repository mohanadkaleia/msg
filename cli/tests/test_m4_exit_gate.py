"""M4 EXIT GATE (ENG-158): the portability round-trip proof.

This is the M4 analogue of the M1 ENG-73 convergence gate. It drives a REAL
instance **A** (Postgres testcontainer + subprocess uvicorn — the ``_e2e_server``
mechanism) into a realistic, dogfood-shaped workspace over the true HTTP API,
then proves that ``export → verify → import`` reconstructs the WHOLE workspace
byte-for-byte on a second, fresh instance **B**, and that B is a fully live
server thereafter. It PROMOTES and consolidates the M4-3 e2e (ENG-157) into the
single permanent milestone gate — there is deliberately no near-duplicate e2e.

The realistic workspace (A):

* an owner + a member + a **GUEST** (invariant-4 subject);
* a public channel (``general``), a **private** channel, and a **DM**;
* threads (root + reply), a mention, an **edit**, a **delete**, reactions
  (incl. one added then removed), spanning ``general`` + ``private`` + ``dm``;
* **two file uploads across ≥2 streams**: an image in ``general`` (→ a
  server-generated thumbnail) and a private text attachment; the image is
  **referenced by two messages** (one blob, two attachments) — the dedup case.

What the gate proves, in the §9 / §13 order:

1. **export** A → bundle ``B1``; capture A's projection dumps + per-stream heads.
2. **verify** ``B1`` ⇒ exit 0; a one-byte body flip on a COPY ⇒ exit 1, and the
   verify gate refuses that tampered bundle at import (a tooth from the M4-2
   matrix; the full matrix is ``test_verify_bundle_e2e``).
3. **import** ``B1`` into a fresh B with a re-credentialed owner.
4. **equivalence**: A dumps == B dumps (messages / reactions / thread
   participants); per-stream ``head_seq`` equal; every blob present on B and
   re-hashes (incl. the thumbnail); a file downloads via the API on B under
   correct authz; the **guest readable-stream set on B == on A** (invariant 4 —
   private/DM never widened). The owner logs in with the NEW password; the
   pre-import passwords are dead.
5. **rebuild fixed point** (invariant 6): ``rebuild-projections`` on B leaves the
   dumps unchanged.
6. **§13 round-trip criterion, strengthened**: ``export`` B → ``B2``;
   ``streams/`` + ``blobs/`` + ``users.json`` + ``files.json`` are BYTE-IDENTICAL
   to ``B1`` and the manifest differs ONLY in ``exported_at`` / ``tool`` /
   ``bundle_digest``.
7. **live serving** (the ENG-150 class): a NEW message on B sequences from the
   restored ``head_seq + 1`` and diverges the dump by exactly that one row.
8. **fresh-instance guard**: a second import into B is refused.

Marked ``integration`` (needs Docker); ``-m "not integration"`` skips it.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import shutil
from pathlib import Path
from typing import Any

import httpx
import pytest
from _e2e_server import ServerHandle, _run, start_live_server
from msgctl.cli import main
from msgd.core import ids
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.engine import create_engine, create_sessionmaker
from msgd.projections.dump import (
    dump_messages_proj,
    dump_reactions_proj,
    dump_thread_participants_proj,
)

pytestmark = pytest.mark.integration

OWNER_PASSWORD = "correct-horse-battery-staple"
MEMBER_PASSWORD = "another-valid-password-42"
GUEST_PASSWORD = "guest-valid-password-77"
NEW_OWNER_PASSWORD = "brand-new-owner-secret-99"


@pytest.fixture(scope="module")
def server_a(tmp_path_factory: pytest.TempPathFactory) -> Any:
    """Instance A — populated over the real API, then exported."""
    with start_live_server(tmp_path_factory) as handle:
        yield handle


@pytest.fixture(scope="module")
def server_b(tmp_path_factory: pytest.TempPathFactory) -> Any:
    """Instance B — stays FRESH until `msgctl import` restores A's bundle."""
    with start_live_server(tmp_path_factory) as handle:
        yield handle


def _hdr(auth: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {auth['token']}"}


def _body(
    auth: dict[str, Any], stream_id: str, type_: str, payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "event_id": ids.new_event_id(),
        "workspace_id": auth["workspace_id"],
        "stream_id": stream_id,
        "type": type_,
        "type_version": 1,
        "author_user_id": auth["user_id"],
        "author_device_id": auth["device_id"],
        "client_created_at": now_rfc3339(),
        "payload": payload,
    }


def _msg(
    auth: dict[str, Any],
    stream_id: str,
    text: str,
    *,
    thread_root_id: str | None = None,
    mentions: list[str] | None = None,
    file_ids: list[str] | None = None,
    message_id: str | None = None,
) -> dict[str, Any]:
    return build_message_created_body(
        workspace_id=auth["workspace_id"],
        stream_id=stream_id,
        author_user_id=auth["user_id"],
        author_device_id=auth["device_id"],
        client_created_at=now_rfc3339(),
        text=text,
        thread_root_id=thread_root_id,
        mentions=mentions,
        file_ids=file_ids,
        message_id=message_id,
    ).model_dump(mode="json")


def _post_batch(client: httpx.Client, auth: dict[str, Any], bodies: list[dict[str, Any]]) -> None:
    items = [{"body": b, "event_hash": hash_event(b)} for b in bodies]
    resp = client.post("/v1/events/batch", json={"events": items}, headers=_hdr(auth))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["rejected"] == [], data["rejected"]


def _accept_invite(
    client: httpx.Client,
    owner: dict[str, Any],
    *,
    role: str,
    email: str,
    display_name: str,
    password: str,
) -> dict[str, Any]:
    inv = client.post("/v1/admin/invites", json={"role": role}, headers=_hdr(owner))
    assert inv.status_code == 201, inv.text
    raw_token = inv.json()["url"].rsplit("/join/", 1)[1]
    joined = client.post(
        "/v1/auth/accept-invite",
        json={
            "token": raw_token,
            "email": email,
            "display_name": display_name,
            "password": password,
        },
    )
    assert joined.status_code == 200, joined.text
    auth: dict[str, Any] = joined.json()
    return auth


def _upload_file(
    client: httpx.Client,
    auth: dict[str, Any],
    *,
    stream_id: str,
    data: bytes,
    name: str,
    mime_type: str,
) -> tuple[str, str]:
    sha256 = hashlib.sha256(data).hexdigest()
    resp = client.post(
        "/v1/files/initiate",
        json={
            "sha256": sha256,
            "name": name,
            "mime_type": mime_type,
            "size_bytes": len(data),
            "stream_id": stream_id,
        },
        headers=_hdr(auth),
    )
    assert resp.status_code == 200, resp.text
    initiated = resp.json()
    if initiated["upload_needed"]:
        put = client.put(f"/v1/files/{initiated['file_id']}/blob", content=data, headers=_hdr(auth))
        assert put.status_code == 200, put.text
    return str(initiated["file_id"]), sha256


def _png_bytes() -> bytes:
    from PIL import Image

    img = Image.new("RGB", (32, 24), (30, 30, 200))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _bundle_files(dest: Path) -> list[Path]:
    return sorted(p for p in dest.rglob("*") if p.is_file())


def _heads(client: httpx.Client, auth: dict[str, Any]) -> dict[str, int]:
    sync = client.get("/v1/sync", headers=_hdr(auth)).json()
    return {s["stream_id"]: s["head_seq"] for s in sync["streams"]}


def _meta_id(client: httpx.Client, auth: dict[str, Any]) -> str:
    sync = client.get("/v1/sync", headers=_hdr(auth)).json()
    meta: str = next(s["stream_id"] for s in sync["streams"] if s["kind"] == "workspace-meta")
    return meta


def _server_dumps(database_url: str) -> dict[str, str]:
    """The three §12 invariant-6 projection dumps, read straight from a live DB."""

    async def _run_dumps() -> dict[str, str]:
        engine = create_engine(database_url)
        try:
            maker = create_sessionmaker(engine)
            async with maker() as session:
                return {
                    "messages_proj": await dump_messages_proj(session),
                    "reactions_proj": await dump_reactions_proj(session),
                    "thread_participants_proj": await dump_thread_participants_proj(session),
                }
        finally:
            await engine.dispose()

    return asyncio.run(_run_dumps())


def _tamper_one_message(bundle_dir: Path) -> None:
    """Flip one message's text WITHOUT re-hashing (the D1 tamper class)."""
    for month_path in sorted((bundle_dir / "streams").rglob("*.ndjson")):
        lines = month_path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            evt = json.loads(line)
            if evt["body"]["type"] == "message.created":
                evt["body"]["payload"]["text"] = "TAMPERED"
                lines[i] = json.dumps(evt, ensure_ascii=False, separators=(",", ":"))
                month_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                return
    raise AssertionError("no message.created found to tamper with")


def test_m4_portability_round_trip(
    server_a: ServerHandle,
    server_b: ServerHandle,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out: list[str] = []

    # ==== Phase 1: drive instance A into a realistic workspace ================
    with httpx.Client(base_url=server_a.base_url, timeout=30.0) as client:
        resp = client.post(
            "/v1/setup",
            json={
                "workspace_name": "Acme",
                "email": "owner@example.com",
                "password": OWNER_PASSWORD,
                "display_name": "Owner",
            },
        )
        assert resp.status_code == 200, resp.text
        owner: dict[str, Any] = resp.json()

        # ENG-164: give the owner a FULL richer profile (title + description +
        # a custom status with a FUTURE expiry) BEFORE the export, so the
        # portability round-trip is non-vacuous for the five new `users`
        # columns. These live ONLY in the users row + the last
        # `user.profile_updated` meta event — if the bundle drops them, the
        # imported row goes NULL while the log still carries them (row/log
        # divergence), and the user's next PATCH (which emits the RESULTING
        # row state) would then emit nulls that every client fold applies as
        # "cleared", silently destroying profile data workspace-wide.
        prof = client.patch(
            "/v1/me",
            json={
                "title": "Founder",
                "description": "Runs Acme. Reachable in #general.",
                "status": {"emoji": "🚀", "text": "shipping", "clear_after": "today"},
            },
            headers=_hdr(owner),
        )
        assert prof.status_code == 200, prof.text
        owner_profile: dict[str, Any] = prof.json()
        assert owner_profile["title"] == "Founder"
        assert owner_profile["status_emoji"] == "🚀"
        assert owner_profile["status_expires_at"] is not None  # a future expiry

        member = _accept_invite(
            client,
            owner,
            role="member",
            email="bob@example.com",
            display_name="Bob",
            password=MEMBER_PASSWORD,
        )
        guest = _accept_invite(
            client,
            owner,
            role="guest",
            email="gina@example.com",
            display_name="Gina",
            password=GUEST_PASSWORD,
        )

        sync = client.get("/v1/sync", headers=_hdr(owner)).json()
        general_id = next(s["stream_id"] for s in sync["streams"] if s.get("name") == "general")
        meta_id = _meta_id(client, owner)

        # The guest gets an EXPLICIT grant to the public channel (§3.6): guests
        # see only explicit-membership streams, so this is what makes the
        # invariant-4 readable set non-trivial (general in, private/DM out).
        _post_batch(
            client,
            owner,
            [
                _body(
                    owner,
                    meta_id,
                    "channel.member_added",
                    {"channel_stream_id": general_id, "user_id": guest["user_id"]},
                )
            ],
        )

        private_id = ids.new_stream_id()
        _post_batch(
            client,
            owner,
            [
                _body(
                    owner,
                    private_id,
                    "channel.created",
                    {
                        "channel_stream_id": private_id,
                        "name": "secret-plans",
                        "visibility": "private",
                    },
                )
            ],
        )
        dm_id = ids.new_stream_id()
        _post_batch(
            client,
            owner,
            [
                _body(
                    owner,
                    dm_id,
                    "dm.created",
                    {
                        "dm_stream_id": dm_id,
                        "member_user_ids": [owner["user_id"], member["user_id"]],
                    },
                )
            ],
        )

        m_root, m_edit, m_del = (ids.new_message_id() for _ in range(3))
        _post_batch(
            client,
            owner,
            [
                _msg(owner, general_id, "thread root 🌍", message_id=m_root),
                _msg(owner, general_id, "hey @bob", mentions=[member["user_id"]]),
                _msg(owner, general_id, "before edit", message_id=m_edit),
                _msg(owner, general_id, "to be deleted", message_id=m_del),
            ],
        )
        # A member-authored thread reply (own session — a batch is single-author),
        # so `thread_participants_proj` carries a second participant to round-trip.
        _post_batch(client, member, [_msg(member, general_id, "a reply", thread_root_id=m_root)])
        _post_batch(
            client,
            owner,
            [
                _body(
                    owner,
                    general_id,
                    "message.edited",
                    {"message_id": m_edit, "text": "after edit", "format": "markdown"},
                ),
                _body(owner, general_id, "message.deleted", {"message_id": m_del}),
                _body(owner, general_id, "reaction.added", {"message_id": m_root, "emoji": "🎉"}),
                _body(owner, general_id, "reaction.added", {"message_id": m_root, "emoji": "✅"}),
                _body(owner, general_id, "reaction.removed", {"message_id": m_root, "emoji": "✅"}),
            ],
        )
        _post_batch(client, owner, [_msg(owner, private_id, "private plans")])
        _post_batch(client, member, [_msg(member, dm_id, "dm from bob")])

        # Two uploads across two streams: an image (→ thumbnail) in `general`
        # referenced by TWO messages (one blob, two attachments — the dedup
        # case), and a private text attachment.
        png = _png_bytes()
        img_file_id, img_sha = _upload_file(
            client, owner, stream_id=general_id, data=png, name="logo.png", mime_type="image/png"
        )
        _post_batch(
            client,
            owner,
            [
                _body(
                    owner,
                    general_id,
                    "file.uploaded",
                    {
                        "file_id": img_file_id,
                        "sha256": img_sha,
                        "name": "logo.png",
                        "mime_type": "image/png",
                        "size_bytes": len(png),
                    },
                ),
                _msg(owner, general_id, "see attached", file_ids=[img_file_id]),
                _msg(owner, general_id, "attaching it again", file_ids=[img_file_id]),
            ],
        )
        text_data = b"quarterly numbers, very private\n" * 8
        txt_file_id, txt_sha = _upload_file(
            client,
            owner,
            stream_id=private_id,
            data=text_data,
            name="numbers.txt",
            mime_type="text/plain",
        )
        _post_batch(
            client,
            owner,
            [
                _body(
                    owner,
                    private_id,
                    "file.uploaded",
                    {
                        "file_id": txt_file_id,
                        "sha256": txt_sha,
                        "name": "numbers.txt",
                        "mime_type": "text/plain",
                        "size_bytes": len(text_data),
                    },
                )
            ],
        )

        a_heads = _heads(client, owner)
        assert set(a_heads) >= {general_id, private_id, dm_id}
        a_guest_streams = set(_heads(client, guest))
        # The guest reads the public channel it was added to — never private/DM.
        assert general_id in a_guest_streams
        assert private_id not in a_guest_streams
        assert dm_id not in a_guest_streams

    a_dumps = _server_dumps(server_a.database_url)

    # ==== Phase 2: msgctl export from A → bundle B1 ===========================
    monkeypatch.setenv("MSG_DATABASE_URL", server_a.database_url)
    monkeypatch.setenv("MSG_DATA_DIR", str(server_a.data_dir))
    bundle = tmp_path / "bundle"
    export_summary = json.loads(_run(capsys, out, "export", str(bundle)))
    assert export_summary["events"] == sum(a_heads.values())
    assert export_summary["blobs"] == 3  # image content + its thumbnail + text

    # ==== Phase 3: verify the bundle — clean; a one-byte flip is caught =======
    assert main(["verify", str(bundle)]) == 0
    capsys.readouterr()
    tampered = tmp_path / "tampered"
    shutil.copytree(bundle, tampered)
    _tamper_one_message(tampered)
    assert main(["verify", str(tampered)]) == 1  # the spot-checked tamper tooth
    capsys.readouterr()

    # ==== Phase 4: point msgctl at FRESH instance B ===========================
    monkeypatch.setenv("MSG_DATABASE_URL", server_b.database_url)
    monkeypatch.setenv("MSG_DATA_DIR", str(server_b.data_dir))
    monkeypatch.setenv("MSGCTL_OWNER_PASSWORD", NEW_OWNER_PASSWORD)
    # Weak argon2 for the CLI-side owner-password hash (matches the harness).
    monkeypatch.setenv("MSG_ARGON2_TIME_COST", "1")
    monkeypatch.setenv("MSG_ARGON2_MEMORY_COST_KIB", "8")
    monkeypatch.setenv("MSG_ARGON2_PARALLELISM", "1")

    # The verify gate refuses the tampered bundle before a byte is written.
    assert main(["import", str(tampered), "--set-owner-password"]) == 1
    err = capsys.readouterr().err
    assert "bundle verification failed" in err

    # The real import (B was left untouched by the refusal).
    import_summary = json.loads(_run(capsys, out, "import", str(bundle), "--set-owner-password"))
    assert import_summary["imported"] is True
    assert import_summary["workspace_id"] == owner["workspace_id"]
    assert import_summary["events"] == sum(a_heads.values())
    assert import_summary["head_seqs"] == a_heads
    assert import_summary["blobs"] == 3

    # ==== Phase 5: equivalence — B is A, faithfully ===========================
    b_dumps = _server_dumps(server_b.database_url)
    assert b_dumps == a_dumps, "projection dumps diverge after round-trip (invariant 6 surface)"

    # Every blob present on B and content-addressed (image, thumbnail, text).
    b_blobs = server_b.data_dir / "blobs"
    png = _png_bytes()
    img_blob = (b_blobs / img_sha[:2] / img_sha).read_bytes()
    assert img_blob == png
    assert hashlib.sha256(img_blob).hexdigest() == img_sha
    text_blob = (b_blobs / txt_sha[:2] / txt_sha).read_bytes()
    assert hashlib.sha256(text_blob).hexdigest() == txt_sha

    with httpx.Client(base_url=server_b.base_url, timeout=30.0) as client_b:
        # Owner logs in with the NEW password; the pre-import passwords are dead.
        login = client_b.post(
            "/v1/auth/login",
            json={
                "email": "owner@example.com",
                "password": NEW_OWNER_PASSWORD,
                "device_label": "e2e",
            },
        )
        assert login.status_code == 200, login.text
        owner_b: dict[str, Any] = login.json()
        assert owner_b["user_id"] == owner["user_id"]
        assert owner_b["workspace_id"] == owner["workspace_id"]

        # ENG-164: the owner's richer profile survived the round-trip VERBATIM —
        # the restored `users` row matches the source (and thus the imported
        # meta log's last `user.profile_updated`), so `GET /v1/me` and the
        # client directory fold agree (no row/log divergence). status_expires_at
        # is compared RAW (still future here → not lazily cleared).
        me_b = client_b.get("/v1/me", headers=_hdr(owner_b))
        assert me_b.status_code == 200, me_b.text
        prof_b = me_b.json()
        assert prof_b["title"] == owner_profile["title"]
        assert prof_b["description"] == owner_profile["description"]
        assert prof_b["status_emoji"] == owner_profile["status_emoji"]
        assert prof_b["status_text"] == owner_profile["status_text"]
        assert prof_b["status_expires_at"] == owner_profile["status_expires_at"]
        # NOTE: this read is non-mutating on purpose — a profile PATCH here would
        # append a meta event and perturb the Phase 6/7 equivalence + Phase 8
        # head deltas. The rename-doesn't-null sanity runs in Phase 8 instead.
        for email, password in (
            ("owner@example.com", OWNER_PASSWORD),
            ("bob@example.com", MEMBER_PASSWORD),
            ("gina@example.com", GUEST_PASSWORD),
        ):
            denied = client_b.post(
                "/v1/auth/login",
                json={"email": email, "password": password, "device_label": "e2e"},
            )
            assert denied.status_code == 401, (email, denied.text)

        # Heads identical to A; a blob + its thumbnail download byte-exact via API.
        assert _heads(client_b, owner_b) == a_heads
        got = client_b.get(f"/v1/files/{img_file_id}", headers=_hdr(owner_b))
        assert got.status_code == 200, got.text
        assert got.content == png
        thumb = client_b.get(f"/v1/files/{img_file_id}/thumbnail", headers=_hdr(owner_b))
        assert thumb.status_code == 200, thumb.text

        # Invariant 4: the guest's readable-stream set on B == on A, and the
        # private channel + DM were NOT widened by the import.
        guest_login = client_b.post(
            "/v1/auth/login",
            json={"email": "gina@example.com", "password": NEW_OWNER_PASSWORD, "device_label": "x"},
        )
        assert guest_login.status_code == 401  # guest needs an admin reset, not the owner pw

    # ==== Phase 6: rebuild-projections on B is a fixed point (invariant 6) ====
    assert main(["rebuild-projections"]) == 0
    capsys.readouterr()
    assert _server_dumps(server_b.database_url) == a_dumps, (
        "rebuild changed the dumps (not a fixpoint)"
    )

    # ==== Phase 7: §13 round-trip criterion — export(B) ≡ export(A) ============
    # Captured PRE-Phase-8 (a live send there perturbs B), so this is the pristine
    # re-export the exit criterion measures.
    bundle_b = tmp_path / "bundle-b"
    _run(capsys, out, "export", str(bundle_b))
    rel_a = [p.relative_to(bundle) for p in _bundle_files(bundle)]
    assert rel_a == [p.relative_to(bundle_b) for p in _bundle_files(bundle_b)]
    for rel in rel_a:
        if rel.name == "manifest.json":
            continue  # streams/, blobs/, users.json, files.json are byte-identical
        assert (bundle / rel).read_bytes() == (bundle_b / rel).read_bytes(), rel
    manifest_a = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    manifest_b = json.loads((bundle_b / "manifest.json").read_text(encoding="utf-8"))
    assert manifest_a.pop("exported_at") != manifest_b.pop("exported_at")
    # `tool` is popped per the §13 criterion (it may differ); here it is equal.
    assert manifest_a.pop("tool") == manifest_b.pop("tool")
    assert manifest_a.pop("bundle_digest") != manifest_b.pop("bundle_digest")
    assert manifest_a == manifest_b, "manifest differs beyond exported_at/tool/bundle_digest"

    # ==== Phase 8: B serves live — a NEW send sequences from the restored head =
    with httpx.Client(base_url=server_b.base_url, timeout=30.0) as client_b:
        login = client_b.post(
            "/v1/auth/login",
            json={
                "email": "owner@example.com",
                "password": NEW_OWNER_PASSWORD,
                "device_label": "e2e",
            },
        )
        owner_b = login.json()
        _post_batch(client_b, owner_b, [_msg(owner_b, general_id, "first post-import")])
        heads_after = _heads(client_b, owner_b)
        assert heads_after[general_id] == a_heads[general_id] + 1
        assert {k: v for k, v in heads_after.items() if k != general_id} == {
            k: v for k, v in a_heads.items() if k != general_id
        }

        # ENG-164 sanity (post-equivalence, so this mutation perturbs nothing
        # asserted above): a rename-ONLY PATCH on the restored profile must NOT
        # null the round-tripped title/description/status — subset semantics
        # emit the RESULTING row state, which still carries them intact. This is
        # the exact data-loss the missing bundle columns would have caused.
        renamed = client_b.patch(
            "/v1/me", json={"display_name": "Owner Renamed"}, headers=_hdr(owner_b)
        )
        assert renamed.status_code == 200, renamed.text
        after_rename = renamed.json()
        assert after_rename["display_name"] == "Owner Renamed"
        assert after_rename["title"] == owner_profile["title"]
        assert after_rename["description"] == owner_profile["description"]
        assert after_rename["status_emoji"] == owner_profile["status_emoji"]
        assert after_rename["status_text"] == owner_profile["status_text"]
        assert after_rename["status_expires_at"] == owner_profile["status_expires_at"]

    # The dump diverges by EXACTLY the new message's row.
    after = _server_dumps(server_b.database_url)
    old_lines = set(a_dumps["messages_proj"].splitlines())
    new_lines = set(after["messages_proj"].splitlines())
    assert old_lines < new_lines
    (added,) = new_lines - old_lines
    assert json.loads(added)["created_seq"] == a_heads[general_id] + 1
    assert after["reactions_proj"] == a_dumps["reactions_proj"]

    # ==== Phase 9: the fresh-instance guard refuses a re-import ================
    assert main(["import", str(bundle), "--set-owner-password"]) == 1
    err = capsys.readouterr().err
    assert "not empty" in err


def test_import_requires_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Env preconditions mirror `export`: clear failures, never a traceback.

    (A cheap unit-shaped check consolidated here from the promoted M4-3 e2e; it
    needs no server, but lives with the gate that owns the import CLI surface.)
    """
    monkeypatch.delenv("MSG_DATABASE_URL", raising=False)
    monkeypatch.delenv("MSG_DATA_DIR", raising=False)
    assert main(["import", str(tmp_path)]) == 1
    monkeypatch.setenv("MSG_DATABASE_URL", "postgresql+asyncpg://u:p@localhost:1/x")
    assert main(["import", str(tmp_path)]) == 1
    monkeypatch.setenv("MSG_DATA_DIR", str(tmp_path))
    # --owner-email without --set-owner-password is a usage mistake.
    assert main(["import", str(tmp_path), "--owner-email", "a@b.c"]) == 1
