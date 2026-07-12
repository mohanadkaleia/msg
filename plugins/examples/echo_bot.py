"""A minimal echo bot for msg, built on the msg_sdk.

It listens in every channel the bot has been granted and replies to each message
by echoing it back — skipping its own messages so it never talks to itself.

Run it (as a workspace owner/admin, do steps 1-2 in the web UI first):

  1. Admin -> Apps -> Bots -> "Create bot": grant it the channel(s) to watch and
     the scopes ``events:read`` + ``events:write``. Then mint a token (shown once).
  2. Install the SDK with the live-stream extra:
         pip install "msg-sdk[ws]"
  3. Run this file with the server URL and that token:
         MSG_BASE_URL=https://msg.example.com \
         MSG_BOT_TOKEN=<the token from step 1> \
         python echo_bot.py
"""

from __future__ import annotations

import os

from msg_sdk import MsgClient


def main() -> None:
    msg = MsgClient(os.environ["MSG_BASE_URL"], os.environ["MSG_BOT_TOKEN"])
    me = msg.identity  # GET /v1/whoami: who am I, and where can I write?
    print(f"echo bot online as {me.user_id} in workspace {me.workspace_id}")

    for event in msg.events():  # live WebSocket stream of the bot's channels
        if event.type != "message.created":
            continue  # ignore reactions, edits, membership changes, ...
        if event.body["author_user_id"] == me.user_id:
            continue  # never echo our own replies (that would loop forever)
        text = event.payload.get("text", "")
        msg.post_message(event.stream_id, f"echo: {text}")


if __name__ == "__main__":
    main()
