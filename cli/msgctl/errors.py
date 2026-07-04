"""Typed errors for ``msgctl`` that carry a process exit code.

``cli.py`` catches :class:`MsgctlError` at the top level, prints
``msgctl: <message>`` to stderr, and returns :attr:`MsgctlError.exit_code`.
Exit-code convention (Ruling 5):

- ``0`` success (never an error object),
- ``1`` operational error (this module),
- ``2`` argparse usage error (argparse raises ``SystemExit(2)`` itself).
"""

from __future__ import annotations

__all__ = [
    "MsgctlError",
    "WorkspaceError",
    "CorruptLogError",
    "StreamError",
]


class MsgctlError(Exception):
    """Base class for operational ``msgctl`` failures.

    Carries the process :attr:`exit_code` used by ``cli.main``.
    """

    #: Default operational-error exit code (Ruling 5).
    exit_code: int = 1


class WorkspaceError(MsgctlError):
    """The workspace is missing, not initialized, or already initialized."""


class CorruptLogError(MsgctlError):
    """The on-disk log or manifest violates an integrity invariant.

    Raised for a terminated-but-unparseable log line, a sequence-contiguity
    break, or a duplicate stream name in the manifest — corruption a well-behaved
    writer never produces, so it is surfaced loudly rather than silently skipped.
    """


class StreamError(MsgctlError):
    """A requested stream could not be resolved on a read-only operation."""
