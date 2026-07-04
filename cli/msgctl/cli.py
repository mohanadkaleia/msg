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
from msgd.core.envelope import Envelope, ServerMetadata
from msgd.core.hashing import hash_event
from msgd.core.payloads import build_message_created_body

from msgctl import __version__
from msgctl.append import append_event
from msgctl.errors import MsgctlError
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
        return Envelope(
            body=body,
            event_hash=event_hash,
            signature=None,
            server=ServerMetadata(
                server_sequence=server_sequence,
                server_received_at=server_received_at,
                payload_redacted=False,
            ),
        )

    result = append_event(ws, stream_id, build_envelope=build_envelope)
    print(result.line)
    if not result.appended:
        event_id = json.loads(result.line)["body"]["event_id"]
        print(f"idempotent: event_id {event_id} already present", file=sys.stderr)
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
