"""serin_sdk — a small Python bot SDK for the Serin plugin API.

Post a message in one call — the SDK builds the ``message.created`` envelope,
mints the ids, and computes the frozen ``event_hash`` the server re-verifies::

    from serin_sdk import SerinClient

    msg = SerinClient("https://msg.example.com", bot_token)
    msg.post_message("s_...channel...", "hello from a bot")

    for event in msg.events():                 # live, needs the [ws] extra
        if event.type == "message.created":
            print(event.payload["text"])

Public-API-only: it talks to the surfaces in ``docs/plugins.md`` and imports
nothing from ``msgd``. See ``plugins/README.md`` and
``plugins/examples/echo_bot.py``.
"""

from __future__ import annotations

from serin_sdk.client import SerinClient
from serin_sdk.errors import (
    SerinConfigError,
    SerinError,
    SerinHTTPError,
    SerinRejectedError,
)
from serin_sdk.hashing import hash_event
from serin_sdk.jcs import JCSError, canonicalize
from serin_sdk.models import Event, Identity, Message

__version__ = "0.1.0"

__all__ = [
    "SerinClient",
    "Identity",
    "Message",
    "Event",
    "SerinError",
    "SerinHTTPError",
    "SerinRejectedError",
    "SerinConfigError",
    "hash_event",
    "canonicalize",
    "JCSError",
    "__version__",
]
