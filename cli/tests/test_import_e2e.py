"""E2E for ``msgctl import`` (ENG-157, M4-3): two real servers, one bundle.

Drives a REAL instance **A** (Postgres testcontainer + subprocess uvicorn, the
``_e2e_server`` mechanism) into a dogfood-shaped workspace (public + private
channels, a DM, a thread, an edit, a delete, a reaction, a mention, an image
upload with a server-generated thumbnail + a private text attachment), exports
it with the actual ``msgctl export``, then runs the actual ``msgctl import``
against a second, FRESH instance **B** and proves:

* the **M4-2 verify gate**: a tampered bundle is refused before a byte is
  written, and ``--skip-verify`` still fails closed on the import's own hash
  re-check — B stays importable afterwards (nothing committed);
* **owner re-credentialing**: the owner logs into B with the
  ``--set-owner-password`` password; the member's OLD (instance-A) password is
  rejected (sentinel hash) until reset;
* the **§9 M4 exit criterion**: ``export → import → export`` is byte-identical
  modulo ``exported_at``/``bundle_digest`` — sequences, timestamps, hashes,
  bodies, users, files, and blobs all round-tripped verbatim;
* **live serving from B**: ``/v1/sync`` heads match A, blob + thumbnail
  downloads are byte-exact, and a NEW message sequences from the restored
  ``head_seq`` (the ENG-150 class);
* the **fresh-instance guard**: a second import into B is refused.

Marked ``integration`` (needs Docker); ``-m "not integration"`` skips it.
"""

from __future__ import annotations

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

pytestmark = pytest.mark.integration

OWNER_PASSWORD = "correct-horse-battery-staple"
MEMBER_PASSWORD = "another-valid-password-42"
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


def test_import_bundle_end_to_end(
    server_a: ServerHandle,
    server_b: ServerHandle,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out: list[str] = []

    # ==== Phase 1: populate instance A over the real API ======================
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

        inv = client.post("/v1/admin/invites", json={"role": "member"}, headers=_hdr(owner))
        assert inv.status_code == 201, inv.text
        raw_token = inv.json()["url"].rsplit("/join/", 1)[1]
        joined = client.post(
            "/v1/auth/accept-invite",
            json={
                "token": raw_token,
                "email": "bob@example.com",
                "display_name": "Bob",
                "password": MEMBER_PASSWORD,
            },
        )
        assert joined.status_code == 200, joined.text
        member: dict[str, Any] = joined.json()

        sync = client.get("/v1/sync", headers=_hdr(owner)).json()
        general_id = next(s["stream_id"] for s in sync["streams"] if s.get("name") == "general")

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
                _msg(owner, general_id, "a reply", thread_root_id=m_root),
                _msg(owner, general_id, "hey @bob", mentions=[member["user_id"]]),
                _msg(owner, general_id, "before edit", message_id=m_edit),
                _msg(owner, general_id, "to be deleted", message_id=m_del),
            ],
        )
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
            ],
        )
        _post_batch(client, owner, [_msg(owner, private_id, "private plans")])
        _post_batch(client, member, [_msg(member, dm_id, "dm from bob")])

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

    # ==== Phase 2: msgctl export from A =======================================
    monkeypatch.setenv("MSG_DATABASE_URL", server_a.database_url)
    monkeypatch.setenv("MSG_DATA_DIR", str(server_a.data_dir))
    bundle = tmp_path / "bundle"
    export_summary = json.loads(_run(capsys, out, "export", str(bundle)))
    assert export_summary["events"] == sum(a_heads.values())

    # ==== Phase 3: point msgctl at FRESH instance B ===========================
    monkeypatch.setenv("MSG_DATABASE_URL", server_b.database_url)
    monkeypatch.setenv("MSG_DATA_DIR", str(server_b.data_dir))
    monkeypatch.setenv("MSGCTL_OWNER_PASSWORD", NEW_OWNER_PASSWORD)
    # Weak argon2 for the CLI-side owner-password hash (matches the harness).
    monkeypatch.setenv("MSG_ARGON2_TIME_COST", "1")
    monkeypatch.setenv("MSG_ARGON2_MEMORY_COST_KIB", "8")
    monkeypatch.setenv("MSG_ARGON2_PARALLELISM", "1")

    # --- the M4-2 verify gate refuses a tampered bundle -----------------------
    tampered = tmp_path / "tampered"
    shutil.copytree(bundle, tampered)
    _tamper_one_message(tampered)
    assert main(["import", str(tampered), "--set-owner-password"]) == 1
    err = capsys.readouterr().err
    assert "bundle verification failed" in err
    assert "hash_mismatch" in err

    # --- --skip-verify still fails closed on the import's own hash re-check ---
    assert main(["import", str(tampered), "--skip-verify", "--set-owner-password"]) == 1
    err = capsys.readouterr().err
    assert "event_hash" in err

    # ==== Phase 4: the real import (B was left untouched by the failures) =====
    import_summary = json.loads(_run(capsys, out, "import", str(bundle), "--set-owner-password"))
    assert import_summary["imported"] is True
    assert import_summary["workspace_id"] == owner["workspace_id"]
    assert import_summary["events"] == sum(a_heads.values())
    assert import_summary["head_seqs"] == a_heads
    assert import_summary["blobs"] == 3  # png + generated thumbnail + text
    assert "issue admin reset links" in out[-1]

    # ==== Phase 5: B serves the workspace live =================================
    with httpx.Client(base_url=server_b.base_url, timeout=30.0) as client_b:
        # Owner logs in with the NEW password.
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

        # The owner's OLD password and the member's password are unusable.
        for email, password in (
            ("owner@example.com", OWNER_PASSWORD),
            ("bob@example.com", MEMBER_PASSWORD),
        ):
            denied = client_b.post(
                "/v1/auth/login",
                json={"email": email, "password": password, "device_label": "e2e"},
            )
            assert denied.status_code == 401, (email, denied.text)

        # Heads identical to A; a blob + its thumbnail download byte-exact.
        assert _heads(client_b, owner_b) == a_heads
        got = client_b.get(f"/v1/files/{img_file_id}", headers=_hdr(owner_b))
        assert got.status_code == 200, got.text
        assert got.content == png
        thumb = client_b.get(f"/v1/files/{img_file_id}/thumbnail", headers=_hdr(owner_b))
        assert thumb.status_code == 200, thumb.text

        # ==== Phase 6: §9 M4 exit criterion — export(B) ≡ export(A) ===========
        bundle_b = tmp_path / "bundle-b"
        _run(capsys, out, "export", str(bundle_b))
        rel_a = [p.relative_to(bundle) for p in _bundle_files(bundle)]
        assert rel_a == [p.relative_to(bundle_b) for p in _bundle_files(bundle_b)]
        for rel in rel_a:
            if rel.name == "manifest.json":
                continue
            assert (bundle / rel).read_bytes() == (bundle_b / rel).read_bytes(), rel
        manifest_a = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
        manifest_b = json.loads((bundle_b / "manifest.json").read_text(encoding="utf-8"))
        assert manifest_a.pop("exported_at") != manifest_b.pop("exported_at")
        manifest_a.pop("bundle_digest"), manifest_b.pop("bundle_digest")
        assert manifest_a == manifest_b

        # ==== Phase 7: a NEW send on B sequences from the restored head ========
        _post_batch(client_b, owner_b, [_msg(owner_b, general_id, "first post-import")])
        heads_after = _heads(client_b, owner_b)
        assert heads_after[general_id] == a_heads[general_id] + 1
        assert {k: v for k, v in heads_after.items() if k != general_id} == {
            k: v for k, v in a_heads.items() if k != general_id
        }

    # ==== Phase 8: the fresh-instance guard refuses a re-import ================
    assert main(["import", str(bundle), "--set-owner-password"]) == 1
    err = capsys.readouterr().err
    assert "not empty" in err


def test_import_requires_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Env preconditions mirror `export`: clear failures, never a traceback."""
    monkeypatch.delenv("MSG_DATABASE_URL", raising=False)
    monkeypatch.delenv("MSG_DATA_DIR", raising=False)
    assert main(["import", str(tmp_path)]) == 1
    monkeypatch.setenv("MSG_DATABASE_URL", "postgresql+asyncpg://u:p@localhost:1/x")
    assert main(["import", str(tmp_path)]) == 1
    monkeypatch.setenv("MSG_DATA_DIR", str(tmp_path))
    # --owner-email without --set-owner-password is a usage mistake.
    assert main(["import", str(tmp_path), "--owner-email", "a@b.c"]) == 1
