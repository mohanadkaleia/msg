"""Workspace restore from a §9 export bundle (TDD §9 / D11, ENG-157 — M4-3).

:func:`import_workspace` replays a bundle written by
:func:`msgd.export.bundle.export_workspace` into a **fresh** instance:
restore blobs, then — in ONE database transaction — insert the workspace +
users, replay every event through the SAME :func:`~msgd.events.reducers
.apply_reducer` the live accept path uses (so ``streams``/``stream_members``
state is identical to live ingest), insert each ``events`` row **verbatim**
via :func:`import_event`, restore ``files`` rows, and finish with
:func:`~msgd.projections.rebuild.rebuild_projections` (whose single commit is
the transaction's commit — §12 invariant 6 by construction).

Correctness pins (each locked by a test):

* **Fresh-instance only.** The emptiness guard refuses unless ``workspaces``,
  ``users``, ``streams``, ``events``, and ``files`` are ALL empty.
  Merge-import is out of scope (§9: "import into an empty server").
* **Verbatim log.** :func:`import_event` preserves ``server_sequence``,
  ``server_received_at``, ``event_hash``, ``payload_redacted`` and the
  ``body`` JSONB exactly as exported — it never routes through
  :func:`~msgd.events.insert.insert_event`, whose row-locked
  ``head_seq + 1`` assignment and ``now()`` stamp would re-sequence and
  re-timestamp the log. A re-export of the imported instance is
  byte-identical to the source bundle modulo ``exported_at``/``bundle_digest``.
* **Fail-closed.** Every event's ``hash_event(body)`` is recomputed and
  compared to the stored ``event_hash`` before insert; gapless-from-1
  ascending ``server_sequence`` (D2), ``body.stream_id``/``workspace_id``
  binding, per-stream event counts, and ``head_seq`` (events vs. manifest)
  are all re-checked. ANY mismatch raises :class:`RestoreError` and the
  whole transaction rolls back — nothing is committed. A truthy
  ``payload_redacted`` is likewise a hard failure (ENG-60: M-series has no
  redaction authority, so the self-asserted flag is itself evidence of
  tampering). Blob restore uses the store's *verified* put, so a tampered
  blob file is rejected rather than stored under a digest it does not match.
* **Replay order.** The workspace-meta stream replays FIRST, then every
  other stream in sorted-id order, each in ascending ``server_sequence``.
  This is sufficient for the reducer bootstrap dependencies: public-channel
  genesis events are homed in workspace-meta (§2.2) *before* any meta-homed
  lifecycle event that references them, and private-channel / DM genesis
  events are self-homed at their own sequence 1, so per-event
  reducer-before-insert (D4, the ``emit_event`` ordering) always finds its
  ``streams`` row.
* **Idempotency (§12 invariant 1).** A re-run of a COMPLETED import fails
  cleanly on the emptiness guard; a crashed import commits nothing (the one
  commit is at the very end), so a retry starts from a clean database.
  Restored blobs are content-addressed no-ops on retry.
* **Bundle verification is the CLI's gate.** ``msgctl import`` runs the
  M4-2 ``verify_bundle`` walk before calling this function (``--skip-verify``
  bypasses it). The gate cannot live here: the server package must not
  import the CLI (§1.1 layering — the same rule that placed ``now_rfc3339``
  in ``core/``). The per-event re-verification above keeps this function
  fail-closed even when the CLI gate is skipped.

Owner re-credentialing: bundles carry NO password hashes (§9), so every
imported user receives :data:`UNUSABLE_PASSWORD_HASH` — a syntactically valid
argon2id string whose digest is 32 zero bytes, which no password can verify
against (that would be a preimage of ``0^256``) and which argon2 rejects with
a clean mismatch (never an invalid-hash error the login path would 500 on).
``owner_password_hash`` (an argon2 hash the CLI computes from the operator's
``--set-owner-password`` input) is assigned to the single ``role == "owner"``
row instead, so the owner can log in immediately; everyone else needs an
admin reset.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Final

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from msgd.blobs.store import BlobStore, BlobStoreError
from msgd.core.hashing import hash_event
from msgd.core.jcs import JCSError
from msgd.db.models import Event, File, Stream, User, Workspace
from msgd.events.reducers import apply_reducer
from msgd.projections.apply import apply_projection
from msgd.projections.dump import (
    dump_messages_proj,
    dump_reactions_proj,
    dump_thread_participants_proj,
)
from msgd.projections.rebuild import rebuild_projections

__all__ = [
    "UNUSABLE_PASSWORD_HASH",
    "ImportResult",
    "RestoreError",
    "import_event",
    "import_workspace",
]

#: The sentinel ``password_hash`` every imported user receives (§9: bundles
#: carry no password hashes). It is a **syntactically valid** argon2id encoded
#: string — 16-zero-byte salt, 32-zero-byte digest, production cost params —
#: so ``argon2.PasswordHasher.verify`` processes it normally and raises a clean
#: ``VerifyMismatchError`` for every input (login → uniform 401), never an
#: ``InvalidHashError`` (which the login path does not catch and would 500 on).
#: No password can ever verify against it: a match would be a preimage of the
#: all-zero digest under argon2id, which is computationally infeasible — and by
#: the same token it is NOT the hash of any *known* password. Deliberately a
#: shared constant (not per-user random): the accounts are equally unusable
#: either way, and a recognizable constant lets an operator SEE that a row is
#: import-locked.
UNUSABLE_PASSWORD_HASH: Final = (
    "$argon2id$v=19$m=65536,t=3,p=4"
    "$AAAAAAAAAAAAAAAAAAAAAA"
    "$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

#: A content-addressed blob key: bare 64-char lowercase hex (the BlobStore form).
_BLOB_HEX_RE: Final = re.compile(r"^[0-9a-f]{64}$")

#: Chunk size for streaming bundle blobs into the store.
_CHUNK_SIZE: Final = 1 << 20


class RestoreError(Exception):
    """An import failed for an operator-explainable reason (fail-closed).

    Messages are safe to print verbatim: they name paths, streams, sequences,
    counts, and content digests — never a DSN or credential. Raised anywhere
    inside the transaction, nothing has been committed.
    """


@dataclass(frozen=True)
class ImportResult:
    """Summary of a completed import (the CLI prints these fields).

    ``dump_digests`` carries the sha256 hex of each post-rebuild projection
    dump (``messages_proj`` / ``reactions_proj`` / ``thread_participants_proj``)
    — the §12 invariant-6 equivalence surface, so a round-trip can be checked
    against the source instance without shipping the dumps themselves.
    """

    workspace_id: str
    streams: int
    events: int
    users: int
    files: int
    blobs: int
    blob_bytes: int
    head_seqs: dict[str, int]
    projections_applied: int
    projections_skipped: int
    dump_digests: dict[str, str]


async def import_event(db: AsyncSession, *, stream_id: str, envelope: dict[str, Any]) -> int:
    """Insert one exported envelope into ``events`` **verbatim** (the M4-3 primitive).

    The restore-side sibling of :func:`~msgd.events.insert.insert_event`, with
    exactly one behavioral difference: nothing server-side is (re)minted.
    ``server_sequence`` and ``server_received_at`` come from the envelope's
    ``server`` metadata instead of a ``head_seq + 1`` bump and ``now()``, and
    ``event_hash`` is the stored string — **after** being re-proven against the
    raw body (``hash_event(body) == event_hash``, the D1 raw-hash discipline; a
    mismatch is exactly log tampering and aborts the whole import). Like
    ``insert_event`` it applies the incremental projection in the same
    transaction (§4.2 accept ordering), so an event is never stored without its
    projection even if the caller skips the trailing rebuild.

    Runs inside the caller's transaction and does not commit. Returns the
    preserved ``server_sequence``.

    Raises:
        RestoreError: envelope malformed, ``event_hash`` does not match the
            body, or ``payload_redacted`` is set (no redaction authority
            exists — ENG-60).
    """
    body = envelope.get("body")
    server = envelope.get("server")
    stored_hash = envelope.get("event_hash")
    if (
        not isinstance(body, dict)
        or not isinstance(server, dict)
        or not isinstance(stored_hash, str)
    ):
        raise RestoreError(f"stream {stream_id}: envelope missing body/server/event_hash")

    # Fail-closed hash re-proof over the RAW stored body (never a model dump).
    try:
        computed = hash_event(body)
    except JCSError as exc:
        raise RestoreError(f"stream {stream_id}: body not canonicalizable: {exc}") from exc
    if computed != stored_hash:
        raise RestoreError(
            f"stream {stream_id} event {body.get('event_id')!r}: "
            f"recomputed {computed} != stored event_hash {stored_hash!r} — refusing to import"
        )

    server_sequence = server.get("server_sequence")
    received_raw = server.get("server_received_at")
    if not isinstance(server_sequence, int) or isinstance(server_sequence, bool):
        raise RestoreError(f"stream {stream_id}: server_sequence missing or not an int")
    if not isinstance(received_raw, str):
        raise RestoreError(f"stream {stream_id} seq {server_sequence}: bad server_received_at")
    if server.get("payload_redacted"):
        # ENG-60 ruling carried forward: no redaction authority exists, so a
        # truthy self-asserted flag is evidence of tampering, not a state to
        # preserve. (Every honestly-exported event carries False.)
        raise RestoreError(
            f"stream {stream_id} seq {server_sequence}: payload_redacted is set, "
            "but no redaction authority exists — refusing to import"
        )

    try:
        db.add(
            Event(
                workspace_id=body["workspace_id"],
                event_id=body["event_id"],
                stream_id=stream_id,
                server_sequence=server_sequence,
                type=body["type"],
                type_version=body["type_version"],
                author_user_id=body["author_user_id"],
                author_device_id=body["author_device_id"],
                client_created_at=datetime.fromisoformat(body["client_created_at"]),
                server_received_at=datetime.fromisoformat(received_raw),
                event_hash=stored_hash,
                payload_redacted=False,
                body=body,
            )
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise RestoreError(
            f"stream {stream_id} seq {server_sequence}: envelope body missing or "
            f"malformed field: {exc!r}"
        ) from exc

    # Same-transaction incremental projection (§4.2 accept ordering), exactly
    # like insert_event. import_workspace's trailing rebuild_projections then
    # truncates and replays — deliberately redundant: the primitive stays a
    # faithful sibling (an event is never stored without its projection), and
    # the rebuild leaves the instance definitionally in "rebuild" state.
    await apply_projection(db, body=body, server_sequence=server_sequence)
    return server_sequence


def _sidecar(bundle_dir: Path, name: str) -> list[dict[str, Any]]:
    """Parse a JSON-array-of-objects sidecar (users.json / files.json)."""
    path = bundle_dir / name
    try:
        parsed = json.loads(path.read_bytes())
    except FileNotFoundError as exc:
        raise RestoreError(f"bundle sidecar missing: {name}") from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise RestoreError(f"bundle sidecar {name} is not valid JSON") from exc
    if not isinstance(parsed, list) or not all(isinstance(e, dict) for e in parsed):
        raise RestoreError(f"bundle sidecar {name} is not a JSON array of objects")
    return parsed


def _load_manifest(bundle_dir: Path) -> dict[str, Any]:
    path = bundle_dir / "manifest.json"
    try:
        parsed = json.loads(path.read_bytes())
    except FileNotFoundError as exc:
        raise RestoreError(f"not a §9 export bundle (no manifest.json): {bundle_dir}") from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise RestoreError("bundle manifest.json is not valid JSON") from exc
    if not isinstance(parsed, dict):
        raise RestoreError("bundle manifest.json is not a JSON object")
    return parsed


def _parse_ts(value: Any, *, field: str) -> datetime:
    if not isinstance(value, str):
        raise RestoreError(f"manifest {field} missing or not a string")
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise RestoreError(f"manifest {field} is not a parseable timestamp: {value!r}") from exc


def _opt_ts(value: Any, *, field: str) -> datetime | None:
    return None if value is None else _parse_ts(value, field=field)


async def _assert_instance_empty(session: AsyncSession) -> None:
    """The fresh-instance guard: refuse unless every restored table is empty."""
    for model, label in (
        (Workspace, "workspaces"),
        (User, "users"),
        (Stream, "streams"),
        (Event, "events"),
        (File, "files"),
    ):
        row = (await session.execute(select(model).limit(1))).first()
        if row is not None:
            raise RestoreError(
                f"target instance is not empty ({label} has rows) — import restores "
                "into a FRESH instance only (merge-import is out of scope); "
                "point MSG_DATABASE_URL at an empty database"
            )


async def _file_stream(path: Path) -> AsyncIterator[bytes]:
    """Chunked read of a bundle blob (mirrors export's plain-IO admin-path style)."""
    with open(path, "rb") as fh:
        while chunk := fh.read(_CHUNK_SIZE):
            yield chunk


async def _restore_blobs(
    blob_store: BlobStore, bundle_dir: Path, manifest: dict[str, Any]
) -> tuple[int, int]:
    """Restore every ``manifest.blobs.index`` blob via the store's VERIFIED put.

    Content-addressed and idempotent: a re-run (after a crashed import) is a
    per-blob no-op. ``put_verified`` re-hashes the streamed bytes against the
    path digest, so a tampered bundle blob is rejected — never stored under a
    name its bytes do not hash to. Digests declared in ``manifest.missing_blobs``
    were absent at export time and are simply not restored (the imported
    instance mirrors the source's brokenness rather than inventing bytes).
    """
    blobs_raw = manifest.get("blobs")
    index = blobs_raw.get("index") if isinstance(blobs_raw, dict) else None
    if not isinstance(index, dict):
        raise RestoreError("manifest blobs.index missing or not an object")
    count = 0
    total_bytes = 0
    for sha in sorted(index):
        if not isinstance(sha, str) or not _BLOB_HEX_RE.fullmatch(sha):
            raise RestoreError(f"manifest blobs.index key is not a sha256 hex digest: {sha!r}")
        path = bundle_dir / "blobs" / sha[:2] / sha
        if not path.is_file():
            raise RestoreError(f"blob listed in the manifest is absent from the bundle: {sha}")
        try:
            await blob_store.put_verified(_file_stream(path), sha)
        except BlobStoreError as exc:
            raise RestoreError(f"blob {sha} failed verified restore: {exc}") from exc
        count += 1
        total_bytes += path.stat().st_size
    return count, total_bytes


async def _replay_stream(
    session: AsyncSession, bundle_dir: Path, stream_id: str, *, workspace_id: str
) -> int:
    """Replay one stream's month files in order; return the event count.

    The count doubles as the last ``server_sequence``: the per-line check below
    re-proves the stream is gapless-ascending from 1 (D2), so after ``n``
    events the last sequence is exactly ``n``.

    Per event: gapless-sequence + binding checks → ``apply_reducer`` (the SAME
    bootstrap path as live ingest, reducer-before-insert per D4/``emit_event``)
    → :func:`import_event` (verbatim row + hash re-proof).
    """
    stream_dir = bundle_dir / "streams" / stream_id
    if not stream_dir.is_dir():
        raise RestoreError(f"manifest stream {stream_id} has no streams/ directory in the bundle")
    expected = 1
    count = 0
    for month_path in sorted(stream_dir.glob("*.ndjson")):
        with open(month_path, "rb") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    envelope = json.loads(line)
                except (json.JSONDecodeError, ValueError) as exc:
                    raise RestoreError(
                        f"{month_path.name} in stream {stream_id}: invalid JSON line"
                    ) from exc
                if not isinstance(envelope, dict):
                    raise RestoreError(
                        f"{month_path.name} in stream {stream_id}: line is not a JSON object"
                    )
                body = envelope.get("body")
                server = envelope.get("server")
                seq = server.get("server_sequence") if isinstance(server, dict) else None
                # D2: gapless, ascending from 1 — re-proven, not trusted.
                if seq != expected:
                    raise RestoreError(
                        f"stream {stream_id}: expected server_sequence {expected}, "
                        f"found {seq!r} ({month_path.name}) — log is not gapless-ascending"
                    )
                if not isinstance(body, dict) or body.get("stream_id") != stream_id:
                    raise RestoreError(
                        f"stream {stream_id} seq {expected}: body.stream_id does not "
                        "match the stream directory"
                    )
                if body.get("workspace_id") != workspace_id:
                    raise RestoreError(
                        f"stream {stream_id} seq {expected}: body.workspace_id "
                        f"{body.get('workspace_id')!r} does not match the manifest "
                        f"workspace {workspace_id!r}"
                    )
                # Reducer BEFORE insert (D4): bootstraps streams/stream_members
                # exactly as live ingest, so the row exists before the FK insert.
                await apply_reducer(session, body)
                await import_event(session, stream_id=stream_id, envelope=envelope)
                expected += 1
                count += 1
        # Keep memory bounded on big streams: flush + drop identity-map state.
        await session.flush()
        session.expunge_all()
    return count


async def import_workspace(
    session: AsyncSession,
    blob_store: BlobStore,
    bundle_dir: Path,
    *,
    owner_password_hash: str | None = None,
    owner_email: str | None = None,
) -> ImportResult:
    """Restore a §9 bundle into a fresh instance; returns the printed summary.

    One database transaction, committed exactly once (by the trailing
    :func:`rebuild_projections`): any failure — hash mismatch, sequence gap,
    manifest disagreement, reducer/FK error — rolls back EVERYTHING, leaving
    the instance as empty as the guard found it. Blob restore happens first
    and outside the transaction: content-addressed, verified, and idempotent,
    so a crashed import leaves only re-usable blobs behind.

    ``owner_password_hash`` (pre-hashed by the caller — argon2 via
    ``msgd.auth.passwords``) re-credentials the single ``role == "owner"``
    user; ``owner_email`` selects among owners should a bundle ever carry more
    than one. Every other user gets :data:`UNUSABLE_PASSWORD_HASH`.

    Raises:
        RestoreError: any operator-explainable refusal (fail-closed).
    """
    bundle_dir = Path(bundle_dir)
    manifest = _load_manifest(bundle_dir)

    ws_raw = manifest.get("workspace")
    if not isinstance(ws_raw, dict) or not isinstance(ws_raw.get("workspace_id"), str):
        raise RestoreError("manifest workspace.workspace_id missing or not a string")
    workspace_id: str = ws_raw["workspace_id"]
    streams_raw = manifest.get("streams")
    if not isinstance(streams_raw, dict) or not all(
        isinstance(sid, str) and isinstance(entry, dict) for sid, entry in streams_raw.items()
    ):
        raise RestoreError("manifest streams missing or not an object of objects")
    manifest_streams: dict[str, dict[str, Any]] = streams_raw

    users = _sidecar(bundle_dir, "users.json")
    files = _sidecar(bundle_dir, "files.json")

    # --- 1. fresh-instance guard (before any write, including blobs) ---------
    await _assert_instance_empty(session)

    # --- 2. blobs: verified, content-addressed, idempotent -------------------
    blob_count, blob_bytes = await _restore_blobs(blob_store, bundle_dir, manifest)

    # --- 3. ONE transaction: workspace -> users -> replay -> files -> rebuild
    ws_name = ws_raw.get("name")
    ws_quota = ws_raw.get("file_quota_bytes")
    if not isinstance(ws_name, str):
        raise RestoreError("manifest workspace.name missing or not a string")
    if not isinstance(ws_quota, int) or isinstance(ws_quota, bool):
        raise RestoreError("manifest workspace.file_quota_bytes missing or not an integer")
    session.add(
        Workspace(
            workspace_id=workspace_id,
            name=ws_name,
            created_at=_parse_ts(ws_raw.get("created_at"), field="workspace.created_at"),
            file_quota_bytes=ws_quota,
        )
    )
    await session.flush()

    owner_rows = [u for u in users if u.get("role") == "owner"]
    if owner_email is not None:
        owner_rows = [u for u in owner_rows if u.get("email") == owner_email]
    if owner_password_hash is not None and len(owner_rows) != 1:
        raise RestoreError(
            f"cannot re-credential the owner: {len(owner_rows)} owner row(s) match"
            + (f" email {owner_email!r}" if owner_email is not None else "")
            + " — pass --owner-email to select one"
        )
    owner_user_id = owner_rows[0].get("user_id") if owner_rows else None
    if owner_password_hash is not None and not isinstance(owner_user_id, str):
        raise RestoreError("cannot re-credential the owner: its users.json row has no user_id")

    for u in users:
        recredential = owner_password_hash is not None and u.get("user_id") == owner_user_id
        try:
            session.add(
                User(
                    user_id=u["user_id"],
                    workspace_id=workspace_id,
                    email=u["email"],
                    password_hash=(
                        owner_password_hash
                        if recredential and owner_password_hash is not None
                        else UNUSABLE_PASSWORD_HASH
                    ),
                    display_name=u["display_name"],
                    role=u["role"],
                    is_bot=bool(u.get("is_bot", False)),
                    deactivated_at=_opt_ts(
                        u.get("deactivated_at"), field="users.json deactivated_at"
                    ),
                )
            )
        except KeyError as exc:
            raise RestoreError(f"users.json row missing field: {exc}") from exc
    await session.flush()

    # Replay order: workspace-meta FIRST (bootstraps the workspace + every
    # meta-homed public-channel genesis), then the rest sorted by stream id.
    meta_ids = sorted(
        sid for sid, entry in manifest_streams.items() if entry.get("kind") == "workspace-meta"
    )
    other_ids = sorted(sid for sid in manifest_streams if sid not in set(meta_ids))
    replay_order = meta_ids + other_ids

    events_total = 0
    head_seqs: dict[str, int] = {}
    for sid in replay_order:
        count = await _replay_stream(session, bundle_dir, sid, workspace_id=workspace_id)
        last_seq = count  # gapless from 1 (re-proven per line) => last seq == count
        entry = manifest_streams[sid]
        if entry.get("event_count") != count:
            raise RestoreError(
                f"stream {sid}: replayed {count} event(s) but the manifest declares "
                f"event_count {entry.get('event_count')!r}"
            )
        if entry.get("head_seq") != last_seq:
            raise RestoreError(
                f"stream {sid}: last replayed server_sequence is {last_seq} but the "
                f"manifest declares head_seq {entry.get('head_seq')!r} — they must match"
            )
        events_total += count
        head_seqs[sid] = last_seq
    if manifest.get("event_count_total") != events_total:
        raise RestoreError(
            f"replayed {events_total} event(s) total but the manifest declares "
            f"event_count_total {manifest.get('event_count_total')!r}"
        )

    # Final per-stream pass (AFTER all streams replayed — a rename/archive homed
    # in a later stream may still mutate an earlier one): pin head_seq to the
    # replayed log, restore archived_at (the reducer can only stamp now(); the
    # sealed manifest carries the source's operational value), and cross-check
    # that the reducer-derived row agrees with the manifest.
    for sid in replay_order:
        entry = manifest_streams[sid]
        result = await session.execute(
            update(Stream)
            .where(Stream.stream_id == sid)
            .values(
                head_seq=head_seqs[sid],
                archived_at=_opt_ts(entry.get("archived_at"), field=f"streams[{sid}].archived_at"),
            )
            .returning(Stream.kind, Stream.name, Stream.visibility)
        )
        row = result.first()
        if row is None:
            raise RestoreError(
                f"stream {sid} is in the manifest but no event bootstrapped it — "
                "a §9 bundle's streams are all reducer-created; refusing to import"
            )
        derived = {"kind": row[0], "name": row[1], "visibility": row[2]}
        declared = {k: entry.get(k) for k in ("kind", "name", "visibility")}
        if derived != declared:
            raise RestoreError(
                f"stream {sid}: replayed state {derived} disagrees with the manifest "
                f"{declared} — bundle is internally inconsistent"
            )

    for f in files:
        try:
            session.add(
                File(
                    file_id=f["file_id"],
                    workspace_id=workspace_id,
                    sha256=f["sha256"],
                    name=f["name"],
                    mime_type=f["mime_type"],
                    size_bytes=f["size_bytes"],
                    uploaded_by=f["uploaded_by"],
                    stream_id=f.get("stream_id"),
                    present=True,  # files.json carries PRESENT rows only (§9)
                    thumbnail_sha256=f.get("thumbnail_sha256"),
                    created_at=_parse_ts(f.get("created_at"), field="files.json created_at"),
                )
            )
        except KeyError as exc:
            raise RestoreError(f"files.json row missing field: {exc}") from exc
    await session.flush()

    # --- 4. rebuild projections: the SAME path as the invariant-6 gate. Its
    # single session.commit() is THE commit of this whole import.
    rebuild = await rebuild_projections(session)

    dump_digests = {
        "messages_proj": hashlib.sha256(
            (await dump_messages_proj(session)).encode("utf-8")
        ).hexdigest(),
        "reactions_proj": hashlib.sha256(
            (await dump_reactions_proj(session)).encode("utf-8")
        ).hexdigest(),
        "thread_participants_proj": hashlib.sha256(
            (await dump_thread_participants_proj(session)).encode("utf-8")
        ).hexdigest(),
    }

    return ImportResult(
        workspace_id=workspace_id,
        streams=len(manifest_streams),
        events=events_total,
        users=len(users),
        files=len(files),
        blobs=blob_count,
        blob_bytes=blob_bytes,
        head_seqs=head_seqs,
        projections_applied=rebuild.applied,
        projections_skipped=rebuild.skipped,
        dump_digests=dump_digests,
    )
