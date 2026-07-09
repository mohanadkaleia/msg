"""E2E for ``msgctl verify`` bundle mode (ENG-156, M4-2): a REAL exported bundle.

The fast tamper matrix in ``test_verify.py`` runs against fixture-built bundles;
this suite closes the loop against the real thing. It drives a live server
(Postgres testcontainer + subprocess uvicorn, the ``_e2e_server`` mechanism) into
a workspace with messages and a file upload (image => server-generated
thumbnail), runs the actual ``msgctl export``, and proves:

* ``msgctl verify`` on the pristine export is CLEAN (exit 0, zero findings) —
  the strongest evidence the verifier's re-derivations match export's sealing;
* representative tampers on copies of the REAL bundle yield the same specific
  findings the fixture matrix pins — including the swap-and-renumber tamper that
  only the sealed manifest can catch (the no-prev-hash-chain proof, on real
  export bytes);
* the ``--allow-missing-blobs`` export path verifies as WARNING-only (exit 0).

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
from msgctl import verify
from msgctl.cli import main
from msgd.core import ids
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339

pytestmark = pytest.mark.integration

OWNER_PASSWORD = "correct-horse-battery-staple"


@pytest.fixture(scope="module")
def bundle_server(tmp_path_factory: pytest.TempPathFactory) -> Any:
    with start_live_server(tmp_path_factory) as handle:
        yield handle


def _hdr(auth: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {auth['token']}"}


def _msg(auth: dict[str, Any], stream_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
    return build_message_created_body(
        workspace_id=auth["workspace_id"],
        stream_id=stream_id,
        author_user_id=auth["user_id"],
        author_device_id=auth["device_id"],
        client_created_at=now_rfc3339(),
        text=text,
        **kwargs,
    ).model_dump(mode="json")


def _post_batch(client: httpx.Client, auth: dict[str, Any], bodies: list[dict[str, Any]]) -> None:
    items = [{"body": b, "event_hash": hash_event(b)} for b in bodies]
    resp = client.post("/v1/events/batch", json={"events": items}, headers=_hdr(auth))
    assert resp.status_code == 200, resp.text
    assert resp.json()["rejected"] == []


def _png_bytes() -> bytes:
    """A real (tiny) PNG so the server's Pillow path generates a thumbnail."""
    from PIL import Image

    img = Image.new("RGB", (32, 24), (30, 30, 200))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _classes(report: verify.VerifyReport) -> list[str]:
    return [f.cls for f in report.findings]


def _copy(src: Path, dest: Path) -> Path:
    shutil.copytree(src, dest)
    return dest


def _dump_line(obj: dict[str, Any]) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def test_verify_real_export_bundle(
    bundle_server: ServerHandle,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out: list[str] = []

    # ==== Phase 1: populate the workspace over the real API ======================
    with httpx.Client(base_url=bundle_server.base_url, timeout=30.0) as client:
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
        sync = client.get("/v1/sync", headers=_hdr(owner)).json()
        general_id = next(s["stream_id"] for s in sync["streams"] if s.get("name") == "general")

        _post_batch(client, owner, [_msg(owner, general_id, f"msg {n}") for n in range(8)])

        png = _png_bytes()
        png_sha = hashlib.sha256(png).hexdigest()
        initiated = client.post(
            "/v1/files/initiate",
            json={
                "sha256": png_sha,
                "name": "logo.png",
                "mime_type": "image/png",
                "size_bytes": len(png),
                "stream_id": general_id,
            },
            headers=_hdr(owner),
        ).json()
        assert initiated["upload_needed"]
        put = client.put(f"/v1/files/{initiated['file_id']}/blob", content=png, headers=_hdr(owner))
        assert put.status_code == 200, put.text
        _post_batch(
            client,
            owner,
            [
                {
                    "event_id": ids.new_event_id(),
                    "workspace_id": owner["workspace_id"],
                    "stream_id": general_id,
                    "type": "file.uploaded",
                    "type_version": 1,
                    "author_user_id": owner["user_id"],
                    "author_device_id": owner["device_id"],
                    "client_created_at": now_rfc3339(),
                    "payload": {
                        "file_id": initiated["file_id"],
                        "sha256": png_sha,
                        "name": "logo.png",
                        "mime_type": "image/png",
                        "size_bytes": len(png),
                    },
                },
                _msg(owner, general_id, "see attached", file_ids=[initiated["file_id"]]),
            ],
        )

    # ==== Phase 2: real export, then verify => CLEAN ==============================
    monkeypatch.setenv("MSG_DATABASE_URL", bundle_server.database_url)
    monkeypatch.setenv("MSG_DATA_DIR", str(bundle_server.data_dir))
    dest = tmp_path / "bundle"
    summary = json.loads(_run(capsys, out, "export", str(dest)))
    assert summary["exported"] is True
    assert summary["missing_blobs"] == []

    report = verify.verify_path(dest)
    assert report.findings == [], [f"{f.cls}: {f.detail}" for f in report.findings]
    assert report.exit_code == 0
    assert report.total_events == summary["events"]
    assert main(["verify", str(dest)]) == 0
    capsys.readouterr()  # drain the human report before capturing the JSON one
    payload = json.loads(_run(capsys, out, "verify", str(dest), "--json"))
    assert payload["ok"] is True
    assert payload["summary"]["failures"] == 0

    # ==== Phase 3: representative tampers on copies of the REAL bundle ===========
    month_file = next((dest / "streams" / general_id).glob("*.ndjson"))
    rel_month = month_file.relative_to(dest)

    # (a) flip one body byte => hash_mismatch + file_digest_mismatch.
    flipped = _copy(dest, tmp_path / "flipped")
    target = flipped / rel_month
    target.write_text(
        target.read_text(encoding="utf-8").replace('"text":"msg 3"', '"text":"msg Z"', 1),
        encoding="utf-8",
    )
    classes = _classes(verify.verify_bundle(flipped))
    assert "hash_mismatch" in classes
    assert "file_digest_mismatch" in classes

    # (b) swap two events AND renumber their server_sequence: every per-event hash
    # and the gapless sequence still pass — ONLY the sealed manifest catches it.
    swapped = _copy(dest, tmp_path / "swapped")
    target = swapped / rel_month
    lines = [ln for ln in target.read_text(encoding="utf-8").split("\n") if ln]
    first, second = json.loads(lines[0]), json.loads(lines[1])
    first["server"]["server_sequence"], second["server"]["server_sequence"] = (
        second["server"]["server_sequence"],
        first["server"]["server_sequence"],
    )
    lines[0], lines[1] = _dump_line(second), _dump_line(first)
    target.write_text("".join(ln + "\n" for ln in lines), encoding="utf-8")
    swapped_report = verify.verify_bundle(swapped)
    classes = _classes(swapped_report)
    assert "hash_mismatch" not in classes
    assert "gap" not in classes and "out_of_order" not in classes
    assert classes == ["file_digest_mismatch"]
    assert swapped_report.exit_code == 1

    # (c) delete a referenced blob => blob_missing FAILURE.
    unblobbed = _copy(dest, tmp_path / "unblobbed")
    (unblobbed / "blobs" / png_sha[:2] / png_sha).unlink()
    unblobbed_report = verify.verify_bundle(unblobbed)
    assert "blob_missing" in _classes(unblobbed_report)
    assert unblobbed_report.exit_code == 1

    # ==== Phase 4: --allow-missing-blobs export verifies WARNING-only =============
    (bundle_server.data_dir / "blobs" / png_sha[:2] / png_sha).unlink()
    allowed = tmp_path / "allowed"
    summary2 = json.loads(_run(capsys, out, "export", str(allowed), "--allow-missing-blobs"))
    assert summary2["missing_blobs"] == [png_sha]
    allowed_report = verify.verify_bundle(allowed)
    assert allowed_report.failures == 0
    warn_classes = _classes(allowed_report)
    assert "blob_missing" in warn_classes
    assert all(f.severity is verify.Severity.WARNING for f in allowed_report.findings)
    assert allowed_report.exit_code == 0
    assert main(["verify", str(allowed)]) == 0
    capsys.readouterr()
