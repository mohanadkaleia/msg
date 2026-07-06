"""``msgctl`` command-line entry point (Ruling 5).

Two subcommands materialize and drive an M0 workspace:

- ``msgctl init <dir> [--name NAME]`` — create a workspace folder.
- ``msgctl send <dir> --stream NAME --text TEXT [...]`` — build a
  ``message.created`` envelope via ``core/``, assign the next gapless per-stream
  ``server_sequence``, and append exactly one JSON line to the stream log.

On success the full accepted stored envelope is printed to stdout as one JSON
object. Exit codes: ``0`` success, ``1`` operational error, ``2`` argparse usage.
"""

from __future__ import annotations

import argparse
import json
import sys

import msgd.core  # noqa: F401  -- proves the msgd.core dependency edge at import time
from msgd.core.envelope import Envelope, EventTooLargeError, ServerMetadata, check_event_size
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body
from pydantic import ValidationError

from msgctl import __version__, verify
from msgctl.append import append_event
from msgctl.errors import MsgctlError
from msgctl.projection import PROJECTION_DB_NAME, open_db, project
from msgctl.rebuild import rebuild_projection
from msgctl.workspace import Workspace, init_workspace, now_rfc3339, resolve_or_create_stream


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="msgctl")
    parser.add_argument(
        "--version",
        action="version",
        version=f"msgctl {__version__}",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="create a new workspace folder")
    init_parser.add_argument("dir", help="workspace directory to create")
    init_parser.add_argument(
        "--name",
        default=None,
        help="workspace display name (default: directory basename)",
    )
    init_parser.set_defaults(handler=cmd_init)

    send_parser = subparsers.add_parser("send", help="append a message.created event to a stream")
    send_parser.add_argument("dir", help="workspace directory")
    send_parser.add_argument("--stream", required=True, help="stream name (auto-created)")
    send_parser.add_argument("--text", required=True, help="message text")
    send_parser.add_argument(
        "--format",
        choices=["markdown", "plain"],
        default="markdown",
        help="message format (default: markdown)",
    )
    send_parser.add_argument(
        "--event-id",
        default=None,
        help="explicit bare-ULID event_id for idempotent retry (default: minted)",
    )
    send_parser.add_argument(
        "--author-user-id",
        default=None,
        help="override the workspace local author user_id (for tests)",
    )
    send_parser.add_argument(
        "--author-device-id",
        default=None,
        help="override the workspace local author device_id (for tests)",
    )
    send_parser.set_defaults(handler=cmd_send)

    # ENG-58: append-only per the §6 cli.py collision protocol — a self-contained
    # subparser block at the end of build_parser, dispatched via set_defaults.
    project_parser = subparsers.add_parser(
        "project",
        help="incrementally materialize the SQLite message projection",
    )
    project_parser.add_argument("dir", help="workspace directory")
    project_parser.set_defaults(handler=cmd_project)

    # ENG-59: append-only per the §6 cli.py collision protocol — a self-contained
    # subparser block at the end of build_parser, dispatched via set_defaults.
    rebuild_parser = subparsers.add_parser(
        "rebuild",
        help="drop the projection and replay the whole log",
    )
    rebuild_parser.add_argument("dir", help="workspace directory")
    rebuild_parser.set_defaults(handler=cmd_rebuild)

    # ENG-60: `verify` — append-only block (ENG-58 adds `project` in parallel; keep both
    # additions surgical so the two tickets conflict on at most this one file, trivially).
    verify_parser = subparsers.add_parser(
        "verify", help="re-hash every event and check per-stream sequence contiguity"
    )
    verify_parser.add_argument("dir", help="workspace directory")
    verify_parser.add_argument(
        "--json", action="store_true", help="emit one machine-readable JSON object"
    )
    verify_parser.add_argument(
        "--verbose",
        action="store_true",
        help="show per-stream OK lines and unknown-type notes",
    )
    verify_parser.set_defaults(handler=cmd_verify)

    # ENG-69: `rebuild-projections` — append-only per the §6 cli.py collision
    # protocol (a self-contained block at the end of build_parser, dispatched via
    # set_defaults). This is the SERVER/Postgres projection rebuild — distinct
    # from the M0 SQLite `rebuild` above (different name, no collision).
    rebuild_projections_parser = subparsers.add_parser(
        "rebuild-projections",
        help="server-side: TRUNCATE messages_proj and replay the events log (MSG_DATABASE_URL)",
    )
    rebuild_projections_parser.set_defaults(handler=cmd_rebuild_projections)

    return parser


def cmd_init(args: argparse.Namespace) -> int:
    ws = init_workspace(args.dir, name=args.name)
    print(json.dumps(ws.to_manifest(), ensure_ascii=False))
    return 0


def cmd_send(args: argparse.Namespace) -> int:
    ws = Workspace.open(args.dir)
    stream_id = resolve_or_create_stream(ws, args.stream)

    author_user_id = args.author_user_id or ws.local_author.user_id
    author_device_id = args.author_device_id or ws.local_author.device_id

    def build_envelope(server_sequence: int, server_received_at: str) -> Envelope:
        body = build_message_created_body(
            workspace_id=ws.workspace_id,
            stream_id=stream_id,
            author_user_id=author_user_id,
            author_device_id=author_device_id,
            client_created_at=now_rfc3339(),
            text=args.text,
            format=args.format,
            event_id=args.event_id,
        )
        event_hash = hash_event(body.model_dump(mode="json"))
        envelope = Envelope(
            body=body,
            event_hash=event_hash,
            signature=None,
            server=ServerMetadata(
                server_sequence=server_sequence,
                server_received_at=server_received_at,
                payload_redacted=False,
            ),
        )
        # Enforce the §2.1 64 KB hard cap the real sequencer applies at upload —
        # the M0 stand-in must never ack an event the M1 server would reject.
        # Raising here unwinds out of the locked section before any write, so a
        # rejection consumes no sequence and appends nothing.
        check_event_size(envelope)
        return envelope

    try:
        result = append_event(ws, stream_id, build_envelope=build_envelope)
    except EventTooLargeError as exc:
        raise MsgctlError(str(exc)) from exc
    except ValidationError as exc:
        raise MsgctlError(f"invalid event field: {exc}") from exc
    print(result.line)
    if not result.appended:
        event_id = json.loads(result.line)["body"]["event_id"]
        print(f"idempotent: event_id {event_id} already present", file=sys.stderr)
    return 0


def cmd_project(args: argparse.Namespace) -> int:
    ws = Workspace.open(args.dir)
    conn = open_db(ws.root / PROJECTION_DB_NAME)
    try:
        result = project(ws, conn)
    finally:
        conn.close()
    print(
        json.dumps(
            {
                "applied": result.applied,
                "skipped": result.skipped,
                "streams": result.stream_heads,
            },
            ensure_ascii=False,
        )
    )
    return 0


def cmd_rebuild(args: argparse.Namespace) -> int:
    ws = Workspace.open(args.dir)
    result = rebuild_projection(ws)
    print(
        json.dumps(
            {
                "rebuilt": True,
                "applied": result.applied,
                "skipped": result.skipped,
                "streams": result.stream_heads,
            },
            ensure_ascii=False,
        )
    )
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    # Thin adapter (Ruling 10): verify_workspace does the whole read-only walk and returns
    # a report. A workspace with findings is a *successful run that found problems*, so the
    # findings-based exit code (0/1) is returned directly — only usage/IO raises (UsageError
    # -> exit 2 via main's `except MsgctlError`).
    report = verify.verify_workspace(args.dir, verbose=args.verbose)
    if args.json:
        print(verify.format_json(report))
    else:
        print(verify.format_human(report, verbose=args.verbose))
    return report.exit_code


def cmd_rebuild_projections(args: argparse.Namespace) -> int:
    """Thin adapter for the server-side ``messages_proj`` rebuild (ENG-69 Ruling 5).

    All DB-touching logic lives in ``msgd.projections.rebuild``; this only wires
    the ``MSG_DATABASE_URL`` env var to an async engine and prints a summary.
    The async-DB imports (SQLAlchemy async engine + the projection module) are
    **lazy** — inside the handler, not at module top — so the M0 commands
    (``init``/``send``/``project``/``rebuild``/``verify``) keep their light,
    async-DB-free import cost.

    SECURITY (review round 1): every DB failure mode — URL parse, connect, and
    replay — is funnelled into a :class:`MsgctlError` whose message names only the
    exception *class*, never the exception text. SQLAlchemy's URL-parse and
    connection errors embed the full DSN (``Could not parse SQLAlchemy URL from
    string '<dsn-with-credentials>'``); ``main`` prints an uncaught non-MsgctlError
    as a raw traceback, which would leak ``MSG_DATABASE_URL`` (password included)
    to stderr / CI logs. Catching here keeps the operator-facing failure clean
    and credential-free.
    """
    import asyncio
    import os

    from msgd.db.engine import create_engine, create_sessionmaker
    from msgd.projections.rebuild import rebuild_projections

    database_url = os.environ.get("MSG_DATABASE_URL")
    if not database_url:
        raise MsgctlError("MSG_DATABASE_URL is not set")

    async def _run() -> tuple[int, int]:
        engine = create_engine(database_url)
        try:
            maker = create_sessionmaker(engine)
            async with maker() as session:
                result = await rebuild_projections(session)
            return result.applied, result.skipped
        finally:
            await engine.dispose()

    try:
        applied, skipped = asyncio.run(_run())
    except Exception as exc:
        # Sanitized: name the error class only — never ``str(exc)``, which can
        # embed the DSN (and its credentials). No re-raise ``from exc`` either,
        # so the DSN-bearing traceback is not chained onto the MsgctlError.
        raise MsgctlError(
            f"rebuild-projections failed: {type(exc).__name__} "
            "(check MSG_DATABASE_URL and database connectivity)"
        ) from None

    print(
        json.dumps(
            {"rebuilt": True, "applied": applied, "skipped": skipped},
            ensure_ascii=False,
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        exit_code: int = args.handler(args)
        return exit_code
    except MsgctlError as err:
        print(f"msgctl: {err}", file=sys.stderr)
        return err.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
