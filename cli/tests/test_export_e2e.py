"""E2E for ``msgctl export`` (ENG-155, M4-1): a real dogfood-shaped workspace.

Drives a REAL server (Postgres testcontainer + subprocess uvicorn, the
``_e2e_server`` mechanism) into a workspace with public + private channels, a
DM, threads, edits, deletes, reactions, mentions, and file uploads (an image
with a generated thumbnail + a content-addressed dedup), then runs the actual
``msgctl export`` CLI against the server's ``MSG_DATABASE_URL`` /
``MSG_DATA_DIR`` and checks the §9 bundle:

* layout + manifest counts (per-stream ``event_count == head_seq`` from
  ``/v1/sync``) + ``bundle_digest`` recompute;
* every NDJSON line is THE canonical serialization (compact dumps, hash-valid);
* the exported ``streams/`` tree is byte-identical to what a fully-``pull``-ed
  ``msgctl`` client holds on disk — the strongest "exactly as served by the
  API" check there is;
* secrets (password hashes, session tokens) appear nowhere in the bundle,
  while private streams and DMs DO (whole-workspace admin export);
* determinism: two exports differ only in ``exported_at``/``bundle_digest``;
* the missing-blob policy end to end (hard fail → ``--allow-missing-blobs``).

Marked ``integration`` (needs Docker); ``-m "not integration"`` skips it.
"""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from _e2e_server import ServerHandle, _run, start_live_server
from msgctl.cli import main
from msgd.core import ids
from msgd.core.hashing import hash_event
from msgd.core.jcs import canonicalize
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339

pytestmark = pytest.mark.integration

OWNER_PASSWORD = "correct-horse-battery-staple"
MEMBER_PASSWORD = "another-valid-password-42"

#: Enough general-channel traffic to cross the export's (and pull's) 500-event
#: page boundary — the keyset-pagination path runs for real, not just page one.
BULK_MESSAGES = 520


@pytest.fixture(scope="module")
def export_server(tmp_path_factory: pytest.TempPathFactory) -> Any:
    """The shared E2E server, with the full handle (DB DSN + data dir) exposed."""
    with start_live_server(tmp_path_factory) as handle:
        yield handle


# --- tiny HTTP driver helpers (the CLI has no channel/DM/file surface yet) -----


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
    assert len(data["accepted"]) == len(bodies)


def _upload_file(
    client: httpx.Client,
    auth: dict[str, Any],
    *,
    stream_id: str,
    data: bytes,
    name: str,
    mime_type: str,
) -> tuple[str, str, bool]:
    """initiate (+ PUT when needed); return (file_id, sha256, upload_was_needed)."""
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
    return str(initiated["file_id"]), sha256, bool(initiated["upload_needed"])


def _png_bytes() -> bytes:
    """A real (tiny) PNG so the server's Pillow path generates a thumbnail."""
    from PIL import Image

    img = Image.new("RGB", (32, 24), (200, 30, 30))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _bundle_files(dest: Path) -> list[Path]:
    return sorted(p for p in dest.rglob("*") if p.is_file())


def _canonical_line(evt: dict[str, Any]) -> str:
    return json.dumps(evt, ensure_ascii=False, separators=(",", ":")) + "\n"


def test_export_bundle_end_to_end(
    export_server: ServerHandle,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    base_url = export_server.base_url
    out: list[str] = []

    # ==== Phase 1: populate a dogfood-shaped workspace over the real API =====
    with httpx.Client(base_url=base_url, timeout=30.0) as client:
        # Owner + workspace (also seeds meta: workspace.created, user.joined,
        # channel.created for #general — ENG-109).
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

        # Second account via invite (role member).
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
        by_kind = {s["kind"]: s["stream_id"] for s in sync["streams"]}
        meta_id = by_kind["workspace-meta"]
        general_id = next(s["stream_id"] for s in sync["streams"] if s.get("name") == "general")

        # Private channel (self-homed genesis, §2.2) + DM (owner ↔ member).
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

        # general: thread + mentions + edit + delete + reactions.
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
                _body(
                    owner,
                    general_id,
                    "reaction.added",
                    {"message_id": m_root, "emoji": "🎉"},
                ),
                _body(
                    owner,
                    general_id,
                    "reaction.added",
                    {"message_id": m_root, "emoji": "✅"},
                ),
                _body(
                    owner,
                    general_id,
                    "reaction.removed",
                    {"message_id": m_root, "emoji": "✅"},
                ),
            ],
        )
        # Bulk traffic across the 500-event pull/export page boundary.
        for start in range(0, BULK_MESSAGES, 100):
            _post_batch(
                client,
                owner,
                [
                    _msg(owner, general_id, f"bulk {n}")
                    for n in range(start, min(start + 100, BULK_MESSAGES))
                ],
            )
        # Private + DM traffic (the member authors in the DM).
        _post_batch(
            client,
            owner,
            [
                _msg(owner, private_id, "private one"),
                _msg(owner, private_id, "private two"),
            ],
        )
        _post_batch(client, member, [_msg(member, dm_id, "dm from bob")])
        _post_batch(client, owner, [_msg(owner, dm_id, "dm from owner")])

        # Files: an image (thumbnail generated server-side), a dedup of the SAME
        # bytes by the member into the DM (upload_needed=false), and a text file
        # in the private channel.
        png = _png_bytes()
        img_file_id, img_sha, needed = _upload_file(
            client, owner, stream_id=general_id, data=png, name="logo.png", mime_type="image/png"
        )
        assert needed
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
        dedup_file_id, dedup_sha, dedup_needed = _upload_file(
            client, member, stream_id=dm_id, data=png, name="logo-copy.png", mime_type="image/png"
        )
        assert dedup_sha == img_sha
        assert not dedup_needed  # workspace-scoped dedup: no second upload
        text_data = b"quarterly numbers, very private\n" * 8
        txt_file_id, txt_sha, needed = _upload_file(
            client,
            owner,
            stream_id=private_id,
            data=text_data,
            name="numbers.txt",
            mime_type="text/plain",
        )
        assert needed

        # The authoritative per-stream event counts, straight from the server.
        final_sync = client.get("/v1/sync", headers=_hdr(owner)).json()
        head_seqs: dict[str, int] = {s["stream_id"]: s["head_seq"] for s in final_sync["streams"]}
        assert set(head_seqs) == {meta_id, general_id, private_id, dm_id}
        assert head_seqs[general_id] >= BULK_MESSAGES + 12

    # ==== Phase 2: a fully-pulled msgctl client (the byte-equality oracle) =====
    ws_dir = tmp_path / "owner-ws"
    _run(
        capsys,
        out,
        "login",
        str(ws_dir),
        "--server-url",
        base_url,
        "--email",
        "owner@example.com",
        "--password",
        OWNER_PASSWORD,
    )
    _run(capsys, out, "pull", str(ws_dir))

    # ==== Phase 3: msgctl export ================================================
    monkeypatch.setenv("MSG_DATABASE_URL", export_server.database_url)
    monkeypatch.setenv("MSG_DATA_DIR", str(export_server.data_dir))
    dest = tmp_path / "bundle"
    summary = json.loads(_run(capsys, out, "export", str(dest)))
    assert summary["exported"] is True
    assert summary["streams"] == 4
    assert summary["events"] == sum(head_seqs.values())
    assert summary["blobs"] == 3  # png + generated thumbnail + text (deduped)
    assert summary["missing_blobs"] == []

    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))

    # --- per-stream: manifest matches the server's heads; lines are canonical ---
    assert sorted(manifest["streams"]) == sorted(head_seqs)
    for stream_id, head_seq in head_seqs.items():
        entry = manifest["streams"][stream_id]
        assert entry["head_seq"] == head_seq
        assert entry["event_count"] == head_seq  # gapless from seq 1
        seqs: list[int] = []
        for name, meta in sorted(entry["files"].items()):
            path = dest / "streams" / stream_id / name
            data = path.read_bytes()
            assert hashlib.sha256(data).hexdigest() == meta["sha256"]
            assert len(data) == meta["bytes"]
            for line in data.decode("utf-8").splitlines(keepends=True):
                evt = json.loads(line)
                assert line == _canonical_line(evt)
                assert hash_event(evt["body"]) == evt["event_hash"]
                assert evt["server"]["server_received_at"][:7] == name.removesuffix(".ndjson")
                seqs.append(evt["server"]["server_sequence"])
        assert seqs == list(range(1, head_seq + 1))
    assert manifest["event_count_total"] == sum(head_seqs.values())

    # DMs + private channels ARE exported (whole-workspace admin op).
    private_entry = manifest["streams"][private_id]
    assert (private_entry["kind"], private_entry["visibility"]) == ("channel", "private")
    assert manifest["streams"][dm_id]["kind"] == "dm"

    # --- export streams/ ≡ a fully-pulled client's streams/ (byte-identical) ----
    pulled = ws_dir / "streams"
    assert sorted(p.name for p in pulled.iterdir() if p.is_dir()) == sorted(head_seqs)
    for stream_id in head_seqs:
        exported_files = {
            p.name: p.read_bytes() for p in (dest / "streams" / stream_id).glob("*.ndjson")
        }
        pulled_files = {p.name: p.read_bytes() for p in (pulled / stream_id).glob("*.ndjson")}
        assert exported_files == pulled_files, f"stream {stream_id} diverges from pull"

    # --- sidecars ----------------------------------------------------------------
    users = json.loads((dest / "users.json").read_text(encoding="utf-8"))
    assert {(u["email"], u["role"]) for u in users} == {
        ("owner@example.com", "owner"),
        ("bob@example.com", "member"),
    }
    assert all(
        set(u) == {"user_id", "email", "display_name", "role", "is_bot", "deactivated_at"}
        for u in users
    )

    files = json.loads((dest / "files.json").read_text(encoding="utf-8"))
    assert {f["name"] for f in files} == {"logo.png", "logo-copy.png", "numbers.txt"}
    by_name = {f["name"]: f for f in files}
    thumb_sha = by_name["logo.png"]["thumbnail_sha256"]
    assert thumb_sha is not None
    assert by_name["logo-copy.png"]["sha256"] == img_sha
    assert by_name["logo-copy.png"]["thumbnail_sha256"] == thumb_sha  # dedup inherits
    assert by_name["logo-copy.png"]["file_id"] == dedup_file_id
    assert by_name["numbers.txt"]["file_id"] == txt_file_id

    # --- blobs: content-addressed, deduped, thumbnails included -------------------
    assert sorted(manifest["blobs"]["index"]) == sorted({img_sha, thumb_sha, txt_sha})
    for sha in (img_sha, thumb_sha, txt_sha):
        blob = (dest / "blobs" / sha[:2] / sha).read_bytes()
        assert hashlib.sha256(blob).hexdigest() == sha
    assert (dest / "blobs" / img_sha[:2] / img_sha).read_bytes() == png

    # --- no secrets anywhere in the bundle ----------------------------------------
    for path in _bundle_files(dest):
        data = path.read_bytes()
        assert b"password_hash" not in data, path
        assert OWNER_PASSWORD.encode() not in data, path
        assert MEMBER_PASSWORD.encode() not in data, path
        assert owner["token"].encode() not in data, path
        assert member["token"].encode() not in data, path

    # --- bundle_digest seals the manifest ------------------------------------------
    digest = manifest.pop("bundle_digest")
    assert digest == f"sha256:{hashlib.sha256(canonicalize(manifest)).hexdigest()}"
    assert digest == summary["bundle_digest"]

    # ==== Phase 4: determinism ====================================================
    dest2 = tmp_path / "bundle-again"
    _run(capsys, out, "export", str(dest2))
    rel = [p.relative_to(dest) for p in _bundle_files(dest)]
    assert rel == [p.relative_to(dest2) for p in _bundle_files(dest2)]
    for r in rel:
        if r.name == "manifest.json":
            continue
        assert (dest / r).read_bytes() == (dest2 / r).read_bytes(), r
    m2 = json.loads((dest2 / "manifest.json").read_text(encoding="utf-8"))
    m2.pop("bundle_digest")
    exported_at, exported_at2 = manifest.pop("exported_at"), m2.pop("exported_at")
    assert exported_at != exported_at2
    assert manifest == m2

    # ==== Phase 5: missing-blob policy through the real CLI =======================
    # Refuse to overwrite a non-empty directory.
    assert main(["export", str(dest)]) == 1
    err = capsys.readouterr().err
    assert "not empty" in err

    (export_server.data_dir / "blobs" / txt_sha[:2] / txt_sha).unlink()
    assert main(["export", str(tmp_path / "fails")]) == 1
    err = capsys.readouterr().err
    assert "missing" in err
    assert txt_sha in err

    allowed = tmp_path / "allowed"
    summary2 = json.loads(_run(capsys, out, "export", str(allowed), "--allow-missing-blobs"))
    assert summary2["missing_blobs"] == [txt_sha]
    m3 = json.loads((allowed / "manifest.json").read_text(encoding="utf-8"))
    assert m3["missing_blobs"] == [txt_sha]
    assert txt_sha not in m3["blobs"]["index"]
    assert m3["blobs"]["count"] == 2
