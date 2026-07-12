"""msg_sdk — a small Python bot SDK for the msg plugin API.

Post a message in one call — the SDK builds the ``message.created`` envelope,
mints the ids, and computes the frozen ``event_hash`` the server re-verifies::

    from msg_sdk import MsgClient

    msg = MsgClient("https://msg.example.com", bot_token)
    msg.post_message("s_...channel...", "hello from a bot")

    for event in msg.events():                 # live, needs the [ws] extra
        if event.type == "message.created":
            print(event.payload["text"])

Public-API-only: it talks to the surfaces in ``docs/plugins.md`` and imports
nothing from ``msgd``. See ``plugins/README.md`` and
``plugins/examples/echo_bot.py``.
"""

from __future__ import annotations

from msg_sdk.client import MsgClient
from msg_sdk.errors import (
    MsgConfigError,
    MsgError,
    MsgHTTPError,
    MsgRejectedError,
)
from msg_sdk.hashing import hash_event
from msg_sdk.jcs import JCSError, canonicalize
from msg_sdk.models import Event, Identity, Message

__version__ = "0.1.0"

__all__ = [
    "MsgClient",
    "Identity",
    "Message",
    "Event",
    "MsgError",
    "MsgHTTPError",
    "MsgRejectedError",
    "MsgConfigError",
    "hash_event",
    "canonicalize",
    "JCSError",
    "__version__",
]
