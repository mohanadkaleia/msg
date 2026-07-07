"""Remote-mode command orchestration + authoring (ENG-70 §6/§7).

Owns the four new subcommands (``login``, ``push``, ``pull``, ``invite``) and the
remote branch of ``send``. Authoring targets the outbox, never the M0 log-append
path; ``login`` binds the workspace identity to the server's (the load-bearing
correctness hinge — without it every push is ``permission_denied`` by
``events/validate.py`` step ii).
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path
from typing import Any

from msgd.core.envelope import Body, Envelope, check_event_size
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_channel_created_body, build_message_created_body

from msgctl import outbox
from msgctl.append import flock_exclusive
from msgctl.client import MsgClient
from msgctl.credentials import (
    ensure_gitignore,
    is_remote,
    read_credentials,
    require_remote,
    write_credentials,
    write_remote_binding,
)
from msgctl.errors import UsageError
from msgctl.sync import pull, push
from msgctl.workspace import (
    LocalAuthor,
    Workspace,
    init_workspace,
    now_rfc3339,
    resolve_or_create_stream,
)

__all__ = [
    "cmd_login",
    "cmd_push",
    "cmd_pull",
    "cmd_invite",
    "cmd_send_remote",
]


# --- shared helpers ---------------------------------------------------------


def _resolve_password(args: argparse.Namespace) -> str:
    """Get the password without leaking it via argv (§8.4).

    Precedence: ``--password`` (tests; documented as the unsafe path) →
    ``MSGCTL_PASSWORD`` env → interactive ``getpass`` prompt. Never echoed.
    """
    if getattr(args, "password", None):
        return str(args.password)
    env = os.environ.get("MSGCTL_PASSWORD")
    if env:
        return env
    return getpass.getpass("Password: ")


def _has_log_events(ws: Workspace) -> bool:
    """True iff any stream dir holds at least one terminated log line.

    Guards ``login`` from binding a fresh server identity over a workspace that
    already carries locally-authored M0 events (which would orphan them under a
    different ``workspace_id``/author).
    """
    streams_dir = ws.streams_dir
    if not streams_dir.is_dir():
        return False
    for stream_dir in streams_dir.iterdir():
        if not stream_dir.is_dir():
            continue
        for path in stream_dir.glob("*.ndjson"):
            raw = path.read_bytes()
            if raw and b"\n" in raw:
                return True
    return False


def _find_meta_stream_id(sync: dict[str, Any]) -> str | None:
    """The ``workspace-meta`` stream id from a ``GET /v1/sync`` snapshot, if visible."""
    for s in sync.get("streams", []):
        if s.get("kind") == "workspace-meta":
            return str(s["stream_id"])
    return None


def _bind_identity(ws: Workspace, resp: dict[str, Any]) -> None:
    """Rewrite ``workspace.json`` identity to the server's (the §3 hinge).

    ``events/validate.py`` step ii rejects (``permission_denied``) any event whose
    ``body.workspace_id`` / ``author_user_id`` / ``author_device_id`` differ from
    the session, so remote authoring MUST build bodies with the server's identity.
    Runs under the workspace lock and re-reads the manifest fresh (same discipline
    as ``resolve_or_create_stream``).
    """
    with flock_exclusive(ws.lock_path):
        fresh = Workspace.open(ws.root)
        fresh.workspace_id = str(resp["workspace_id"])
        fresh.local_author = LocalAuthor(
            user_id=str(resp["user_id"]), device_id=str(resp["device_id"])
        )
        fresh.write_manifest()
        ws.workspace_id = fresh.workspace_id
        ws.local_author = fresh.local_author
        ws.streams = fresh.streams


def _open_or_init(args: argparse.Namespace) -> Workspace:
    """Open ``args.dir`` as a workspace, initializing a fresh one if absent."""
    root = Path(args.dir)
    if (root / "workspace.json").is_file():
        return Workspace.open(root)
    name = getattr(args, "workspace_name", None)
    return init_workspace(root, name=name)


# --- login ------------------------------------------------------------------


def cmd_login(args: argparse.Namespace) -> int:
    """``login`` — setup / accept-invite / password re-login, then bind + persist.

    Initializes a fresh remote workspace (or re-authenticates an already-bound
    one), rebinds identity to the server's, writes 0600 credentials + the remote
    binding, does one ``GET /v1/sync`` to cache ``meta_stream_id``, and updates
    ``.gitignore``. Prints only non-secret identity fields — never the token.
    """
    ws = _open_or_init(args)
    already_remote = is_remote(ws)
    if not already_remote and _has_log_events(ws):
        raise UsageError(
            "refusing to bind a server identity over a workspace that already has "
            "locally-authored M0 log events (they would be orphaned under a different "
            f"workspace_id): {ws.root}"
        )

    server_url = args.server_url
    if server_url is None and already_remote:
        server_url = str(require_remote(ws)["server_url"])
    if not server_url:
        raise UsageError("--server-url is required to log in to a new remote workspace")

    password = _resolve_password(args)

    with MsgClient(server_url) as client:
        if args.setup:
            _require_args(args, ("workspace_name", "email", "display_name"), "--setup")
            resp = client.setup(
                workspace_name=args.workspace_name,
                email=args.email,
                password=password,
                display_name=args.display_name,
            )
        elif args.invite_token:
            _require_args(args, ("email", "display_name"), "--invite-token")
            resp = client.accept_invite(
                token=args.invite_token,
                email=args.email,
                display_name=args.display_name,
                password=password,
            )
        else:
            _require_args(args, ("email",), "login")
            device_id = str(require_remote(ws)["device_id"]) if already_remote else None
            resp = client.login(
                email=args.email,
                password=password,
                device_label=args.device_label,
                device_id=device_id,
            )
        client.with_token(str(resp["token"]))
        _bind_identity(ws, resp)
        write_credentials(ws, token=str(resp["token"]), expires_at=str(resp["expires_at"]))
        sync = client.get_sync()
        meta_stream_id = _find_meta_stream_id(sync)
        # Reconcile local state with the server right after binding so the
        # workspace immediately learns the server's channels — notably the
        # setup-created public #general (ENG-109). Without this, a subsequent
        # `send --stream general` would not find `general` in the local name
        # index and would mint a SECOND `channel.created` (a duplicate channel).
        # After the pull, `resolve_or_create_stream` matches `general` by name and
        # REUSES the server's stream id — exactly one `general` ever exists.
        pull(ws, client)

    write_remote_binding(
        ws,
        {
            "server_url": server_url,
            "workspace_id": str(resp["workspace_id"]),
            "user_id": str(resp["user_id"]),
            "device_id": str(resp["device_id"]),
            "role": str(resp["role"]),
            "meta_stream_id": meta_stream_id,
        },
    )
    ensure_gitignore(ws)

    # Non-secret identity only — the raw token is NEVER printed.
    print(
        json.dumps(
            {
                "logged_in": True,
                "server_url": server_url,
                "workspace_id": str(resp["workspace_id"]),
                "user_id": str(resp["user_id"]),
                "device_id": str(resp["device_id"]),
                "role": str(resp["role"]),
                "meta_stream_id": meta_stream_id,
            },
            ensure_ascii=False,
        )
    )
    return 0


def _require_args(args: argparse.Namespace, names: tuple[str, ...], mode: str) -> None:
    missing = [f"--{n.replace('_', '-')}" for n in names if not getattr(args, n, None)]
    if missing:
        raise UsageError(f"{mode} requires {', '.join(missing)}")


# --- invite -----------------------------------------------------------------


def cmd_invite(args: argparse.Namespace) -> int:
    """``invite`` — mint a single-use join URL (owner/admin) and print it."""
    ws = Workspace.open(args.dir)
    binding = require_remote(ws)
    creds = read_credentials(ws)
    with MsgClient(str(binding["server_url"]), token=str(creds["token"])) as client:
        resp = client.create_invite(role=args.role, ttl_seconds=args.ttl_seconds)
    # The URL embeds the single-use invite token (a shareable join link — NOT the
    # bearer session token), so printing it is the intended way to hand it off.
    print(json.dumps({"url": resp["url"], "expires_at": resp["expires_at"]}, ensure_ascii=False))
    return 0


# --- push / pull ------------------------------------------------------------


def cmd_push(args: argparse.Namespace) -> int:
    """``push`` — drain the outbox to the server; nonzero exit on any rejection."""
    ws = Workspace.open(args.dir)
    binding = require_remote(ws)
    creds = read_credentials(ws)
    with MsgClient(str(binding["server_url"]), token=str(creds["token"])) as client:
        result = push(ws, client)
    print(
        json.dumps(
            {
                "pushed": result.accepted,
                "rejected": [
                    {"event_id": r.event_id, "code": r.code, "detail": r.detail}
                    for r in result.rejected
                ],
            },
            ensure_ascii=False,
        )
    )
    if not result.ok:
        print(f"push: {len(result.rejected)} event(s) rejected", file=sys.stderr)
        return 1
    return 0


def cmd_pull(args: argparse.Namespace) -> int:
    """``pull`` — mirror every readable stream verbatim into the synced log."""
    ws = Workspace.open(args.dir)
    binding = require_remote(ws)
    creds = read_credentials(ws)
    with MsgClient(str(binding["server_url"]), token=str(creds["token"])) as client:
        result = pull(ws, client)
    print(
        json.dumps(
            {
                "streams": result.streams,
                "events": result.events,
                "registered": result.registered,
            },
            ensure_ascii=False,
        )
    )
    return 0


# --- remote send (authoring -> outbox) --------------------------------------


def _enqueue_channel_created(
    ws: Workspace, meta_stream_id: str, channel_stream_id: str, name: str
) -> None:
    """Enqueue a public ``channel.created`` homed in ``workspace-meta`` (§3 auto-create).

    Homed at ``meta_stream_id`` with ``payload.channel_stream_id`` = the client-
    minted stream id, so the server reducer creates the channel with that exact id
    — after ``pull`` the synced dir is ``streams/<channel_stream_id>/``, identical
    across clients.
    """
    body = build_channel_created_body(
        workspace_id=ws.workspace_id,
        stream_id=meta_stream_id,
        author_user_id=ws.local_author.user_id,
        author_device_id=ws.local_author.device_id,
        client_created_at=now_rfc3339(),
        channel_stream_id=channel_stream_id,
        name=name,
        visibility="public",
    )
    event_hash = hash_event(body)
    check_event_size(Envelope(body=Body(**body), event_hash=event_hash))
    outbox.enqueue(ws, body, event_hash)


def cmd_send_remote(args: argparse.Namespace, ws: Workspace) -> int:
    """``send`` in a remote workspace: author into the outbox, not the log (§3).

    First send to a new stream name mints an ``s_`` id (registry mutation reused
    from ``resolve_or_create_stream``) and enqueues a public ``channel.created``
    (homed in ``workspace-meta``) ahead of the ``message.created``; FIFO + per-
    event commit in the batch means the channel is created before the message
    validates against it. A stream already known (e.g. resolved from a peer's
    ``pull``) enqueues only the ``message.created``.
    """
    binding = require_remote(ws)
    meta_stream_id = binding.get("meta_stream_id")

    existing = ws.name_index.get(args.stream)
    if existing is None:
        if not meta_stream_id:
            raise UsageError(
                "cannot auto-create a channel: no workspace-meta stream is visible "
                "to this identity (re-run `msgctl login`, or `pull` an existing channel first)"
            )
        stream_id = resolve_or_create_stream(ws, args.stream)
        _enqueue_channel_created(ws, str(meta_stream_id), stream_id, args.stream)
    else:
        stream_id = existing

    body_model = build_message_created_body(
        workspace_id=ws.workspace_id,
        stream_id=stream_id,
        author_user_id=ws.local_author.user_id,
        author_device_id=ws.local_author.device_id,
        client_created_at=now_rfc3339(),
        text=args.text,
        format=args.format,
        event_id=args.event_id,
    )
    body = body_model.model_dump(mode="json")
    event_hash = hash_event(body)
    check_event_size(Envelope(body=body_model, event_hash=event_hash))
    outbox.enqueue(ws, body, event_hash)

    print(
        json.dumps(
            {"queued": True, "stream_id": stream_id, "event_id": body["event_id"]},
            ensure_ascii=False,
        )
    )
    return 0
