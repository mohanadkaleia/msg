"""Fixture + file-manipulation helpers for the ``msgctl verify`` suite.

The discipline (§6): build the log with REAL ``msgctl`` sends via subprocess, then craft
each corruption by direct byte/line manipulation of the produced month file — so verify
is proven against genuinely-produced logs, not hand-built straw men.

Bundle mode (M4-2, ENG-156) adds a §9 export-bundle builder (:func:`write_bundle` /
:func:`build_clean_bundle`) that reproduces ``msgd.export.bundle``'s exact on-disk
shape — compact NDJSON lines, indented sidecars/manifest, the JCS-sealed
``bundle_digest`` — so the tamper matrix runs fast and Docker-free. The builder is
proven faithful by ``test_verify_bundle_e2e.py``, which verifies a bundle produced by
the REAL ``msgctl export`` against a live server.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from conftest import run_cli
from msgd.core import ids
from msgd.core.hashing import hash_event
from msgd.core.jcs import canonicalize


def init_ws(root: Path, name: str = "test-ws") -> None:
    """``msgctl init`` a fresh workspace at ``root`` (asserts success)."""
    proc = run_cli("init", str(root), "--name", name)
    assert proc.returncode == 0, proc.stderr


def send(root: Path, stream: str, text: str, **flags: str) -> dict[str, Any]:
    """``msgctl send`` one message; return the stored envelope dict (asserts success)."""
    args = ["send", str(root), "--stream", stream, "--text", text]
    for key, value in flags.items():
        args += [f"--{key.replace('_', '-')}", value]
    proc = run_cli(*args)
    assert proc.returncode == 0, proc.stderr
    result: dict[str, Any] = json.loads(proc.stdout.splitlines()[0])
    return result


def stream_dirs(root: Path) -> list[Path]:
    return sorted(p for p in (root / "streams").iterdir() if p.is_dir())


def month_file(stream_dir: Path) -> Path:
    """The single month file of a stream (tests send within one month)."""
    files = sorted(stream_dir.glob("*.ndjson"))
    assert len(files) == 1, f"expected one month file, found {files}"
    return files[0]


def read_raw_lines(path: Path) -> list[str]:
    """Terminated lines of a month file, newline stripped (no trailing empty)."""
    return [line for line in path.read_text(encoding="utf-8").split("\n") if line]


def write_lines(path: Path, lines: list[str]) -> None:
    """Overwrite a month file with ``lines`` (each newline-terminated)."""
    path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")


def rehash(obj: dict[str, Any]) -> str:
    """The correct raw ``event_hash`` for ``obj``'s body (mirrors production)."""
    return hash_event(obj["body"])


def make_stored_event(
    *,
    workspace_id: str,
    stream_id: str,
    server_sequence: int,
    type: str = "message.created",
    type_version: int = 1,
    payload: dict[str, Any] | None = None,
    event_id: str | None = None,
    event_hash: str | None = None,
    server_received_at: str = "2026-07-04T00:00:00.000Z",
) -> dict[str, Any]:
    """Hand-build one stored envelope dict with a CORRECT raw hash (unless overridden).

    Used for the unknown-type / schema-invalid cases where we need a specific ``type`` or
    a deliberately-bad payload but an otherwise-faithful line, and (M4-2) as the event
    factory for the bundle builder — ``server_received_at`` controls the month file.
    """
    body: dict[str, Any] = {
        "event_id": event_id or ids.new_event_id(),
        "workspace_id": workspace_id,
        "stream_id": stream_id,
        "type": type,
        "type_version": type_version,
        "author_user_id": ids.new_user_id(),
        "author_device_id": ids.new_device_id(),
        "client_created_at": "2026-07-04T00:00:00.000Z",
        "payload": payload if payload is not None else {},
    }
    return {
        "body": body,
        "event_hash": event_hash if event_hash is not None else hash_event(body),
        "signature": None,
        "server": {
            "server_sequence": server_sequence,
            "server_received_at": server_received_at,
            "payload_redacted": False,
        },
    }


def make_envelope_line(
    *,
    workspace_id: str,
    stream_id: str,
    server_sequence: int,
    type: str = "message.created",
    type_version: int = 1,
    payload: dict[str, Any] | None = None,
    event_id: str | None = None,
    event_hash: str | None = None,
) -> str:
    """One stored envelope as a compact NDJSON line (:func:`make_stored_event`)."""
    obj = make_stored_event(
        workspace_id=workspace_id,
        stream_id=stream_id,
        server_sequence=server_sequence,
        type=type,
        type_version=type_version,
        payload=payload,
        event_id=event_id,
        event_hash=event_hash,
    )
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


# ------------------------------------------------------------------ §9 bundle fixtures


def _dump_bundle_json(obj: Any) -> bytes:
    """The manifest/sidecar byte shape ``msgd.export.bundle._dump_json`` writes."""
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def event_line(evt: dict[str, Any]) -> str:
    """The canonical compact NDJSON form of one stored event (newline-terminated)."""
    return json.dumps(evt, ensure_ascii=False, separators=(",", ":")) + "\n"


def seal_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """Stamp ``bundle_digest`` exactly the way export seals it (JCS sans the key)."""
    manifest.pop("bundle_digest", None)
    manifest["bundle_digest"] = f"sha256:{hashlib.sha256(canonicalize(manifest)).hexdigest()}"
    return manifest


def reseal_manifest(root: Path) -> None:
    """Re-seal ``manifest.json`` after a deliberate manifest edit.

    Lets a tamper test change ONE manifest fact (a count, a size) while keeping
    ``bundle_digest`` honest — proving the targeted check fires on its own, not just
    as a side effect of ``manifest_digest_mismatch``.
    """
    path = root / "manifest.json"
    manifest = seal_manifest(json.loads(path.read_text(encoding="utf-8")))
    path.write_bytes(_dump_bundle_json(manifest))


def write_bundle(
    dest: Path,
    *,
    workspace_id: str,
    streams: dict[str, dict[str, Any]],
    users: list[dict[str, Any]] | None = None,
    files: list[dict[str, Any]] | None = None,
    blobs: dict[str, bytes] | None = None,
    missing_blobs: list[str] | None = None,
    workspace_name: str = "bundle-ws",
) -> dict[str, Any]:
    """Materialize a §9 export bundle at ``dest``, byte-shape-identical to export.

    ``streams`` maps ``stream_id`` -> ``{"kind", "name", "visibility", "events"}``
    where ``events`` is an ordered list of stored envelope dicts
    (:func:`make_stored_event`); month files are split on
    ``server_received_at[:7]`` exactly like export. ``blobs`` maps a bare-hex
    sha256 to its content bytes. Returns the sealed manifest dict.
    """
    dest.mkdir(parents=True, exist_ok=True)
    users_bytes = _dump_bundle_json(users if users is not None else [])
    (dest / "users.json").write_bytes(users_bytes)
    files_bytes = _dump_bundle_json(files if files is not None else [])
    (dest / "files.json").write_bytes(files_bytes)

    streams_manifest: dict[str, Any] = {}
    event_count_total = 0
    for sid in sorted(streams):
        spec = streams[sid]
        events: list[dict[str, Any]] = spec["events"]
        sdir = dest / "streams" / sid
        sdir.mkdir(parents=True)
        months: dict[str, list[dict[str, Any]]] = {}
        for evt in events:
            months.setdefault(evt["server"]["server_received_at"][:7], []).append(evt)
        files_map: dict[str, Any] = {}
        for month in sorted(months):
            data = "".join(event_line(evt) for evt in months[month]).encode("utf-8")
            (sdir / f"{month}.ndjson").write_bytes(data)
            seqs = [evt["server"]["server_sequence"] for evt in months[month]]
            files_map[f"{month}.ndjson"] = {
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
                "event_count": len(seqs),
                "first_seq": seqs[0],
                "last_seq": seqs[-1],
            }
        event_count_total += len(events)
        streams_manifest[sid] = {
            "kind": spec.get("kind", "channel"),
            "name": spec.get("name"),
            "visibility": spec.get("visibility", "public"),
            "archived_at": None,
            "head_seq": events[-1]["server"]["server_sequence"] if events else 0,
            "event_count": len(events),
            "files": files_map,
        }

    blob_index: dict[str, Any] = {}
    total_blob_bytes = 0
    for sha in sorted(blobs or {}):
        content = (blobs or {})[sha]
        target = dest / "blobs" / sha[:2] / sha
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        blob_index[sha] = {"bytes": len(content)}
        total_blob_bytes += len(content)

    manifest: dict[str, Any] = {
        "format_version": 1,
        "exported_at": "2026-07-04T12:00:00.000Z",
        "tool": "msgctl/test",
        "hash_algorithm": "sha256",
        "projection_version": 1,
        "workspace": {
            "workspace_id": workspace_id,
            "name": workspace_name,
            "created_at": "2026-06-01T00:00:00.000Z",
            "file_quota_bytes": 1073741824,
        },
        "streams": streams_manifest,
        "event_count_total": event_count_total,
        "blobs": {
            "count": len(blob_index),
            "total_bytes": total_blob_bytes,
            "index": blob_index,
        },
        "sidecars": {
            "users.json": hashlib.sha256(users_bytes).hexdigest(),
            "files.json": hashlib.sha256(files_bytes).hexdigest(),
        },
        "missing_blobs": missing_blobs if missing_blobs is not None else [],
    }
    seal_manifest(manifest)
    (dest / "manifest.json").write_bytes(_dump_bundle_json(manifest))
    return manifest


@dataclass(frozen=True)
class BundleInfo:
    """Everything a bundle tamper test needs to aim its corruption precisely."""

    workspace_id: str
    stream_a: str  # "general": seqs 1..3 in 2026-06, 4..5 (incl. file.uploaded) in 2026-07
    stream_b: str  # "random": seqs 1..2 in 2026-07
    file_id: str
    content_sha: str
    content: bytes
    thumb_sha: str
    manifest: dict[str, Any]


def _message_payload(text: str) -> dict[str, Any]:
    return {"message_id": ids.new_message_id(), "text": text, "format": "markdown"}


def build_clean_bundle(dest: Path) -> BundleInfo:
    """The canonical green bundle for the tamper matrix.

    Two streams (one spanning two month files), a ``file.uploaded`` event, a
    files.json row with content + thumbnail blobs, and two users — every check in
    bundle mode has something real to bite on.
    """
    workspace_id = ids.new_workspace_id()
    stream_a = ids.new_stream_id()
    stream_b = ids.new_stream_id()
    file_id = ids.new_file_id()
    content = b"the quarterly numbers, attached\n" * 4
    content_sha = hashlib.sha256(content).hexdigest()
    thumb = b"\x89PNG-not-really-a-thumbnail"
    thumb_sha = hashlib.sha256(thumb).hexdigest()

    def _evt(sid: str, seq: int, received: str, **kwargs: Any) -> dict[str, Any]:
        return make_stored_event(
            workspace_id=workspace_id,
            stream_id=sid,
            server_sequence=seq,
            server_received_at=received,
            **kwargs,
        )

    events_a = [
        _evt(stream_a, 1, "2026-06-10T09:00:00.000Z", payload=_message_payload("one")),
        _evt(stream_a, 2, "2026-06-11T09:00:00.000Z", payload=_message_payload("two")),
        _evt(stream_a, 3, "2026-06-12T09:00:00.000Z", payload=_message_payload("three")),
        _evt(
            stream_a,
            4,
            "2026-07-01T09:00:00.000Z",
            type="file.uploaded",
            payload={
                "file_id": file_id,
                "sha256": content_sha,
                "name": "numbers.txt",
                "mime_type": "text/plain",
                "size_bytes": len(content),
            },
        ),
        _evt(stream_a, 5, "2026-07-02T09:00:00.000Z", payload=_message_payload("five")),
    ]
    events_b = [
        _evt(stream_b, 1, "2026-07-01T10:00:00.000Z", payload=_message_payload("b-one")),
        _evt(stream_b, 2, "2026-07-02T10:00:00.000Z", payload=_message_payload("b-two")),
    ]
    manifest = write_bundle(
        dest,
        workspace_id=workspace_id,
        streams={
            stream_a: {"kind": "channel", "name": "general", "events": events_a},
            stream_b: {"kind": "channel", "name": "random", "events": events_b},
        },
        users=[
            {
                "user_id": ids.new_user_id(),
                "email": "owner@example.com",
                "display_name": "Owner",
                "role": "owner",
                "is_bot": False,
                "deactivated_at": None,
            },
            {
                "user_id": ids.new_user_id(),
                "email": "bob@example.com",
                "display_name": "Bob",
                "role": "member",
                "is_bot": False,
                "deactivated_at": None,
            },
        ],
        files=[
            {
                "file_id": file_id,
                "sha256": content_sha,
                "name": "numbers.txt",
                "mime_type": "text/plain",
                "size_bytes": len(content),
                "uploaded_by": ids.new_user_id(),
                "stream_id": stream_a,
                "created_at": "2026-07-01T09:00:00.000Z",
                "thumbnail_sha256": thumb_sha,
            }
        ],
        blobs={content_sha: content, thumb_sha: thumb},
    )
    return BundleInfo(
        workspace_id=workspace_id,
        stream_a=stream_a,
        stream_b=stream_b,
        file_id=file_id,
        content_sha=content_sha,
        content=content,
        thumb_sha=thumb_sha,
        manifest=manifest,
    )
