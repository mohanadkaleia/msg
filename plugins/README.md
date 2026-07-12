# Building on msg

This is the friendly, get-started guide to extending msg. For the exact wire
contract — every endpoint, status code, scope, and the hashing spec — see the
API reference in [`docs/plugins.md`](../docs/plugins.md).

A plugin is just an **external program that talks to msg over HTTP**. There is
nothing to install into the server and nothing to import from `msgd`. If your
program can make HTTP requests, it can be a msg plugin. There are two ways in:

| | **Incoming webhook** | **Bot (with the SDK)** |
| --- | --- | --- |
| Direction | one-way *in* (post only) | two-way (read + write + live) |
| Auth | a secret URL (the URL *is* the credential) | a scoped bot token |
| Good for | notifiers: CI, alerts, GitHub, cron | assistants, commands, integrations |
| Effort | one `curl` | a few lines of Python with `msg_sdk` |

Both are provisioned from the web UI under **Admin → Apps** (the **Bots** and
**Incoming webhooks** tabs). You need to be a workspace **owner or admin**.

---

## 1. Incoming webhooks — dead simple, one-way

An incoming webhook turns `POST {"text": …}` into a message in one channel.

1. **Admin → Apps → Incoming webhooks → Create.** Pick the channel. You get a
   **capability URL exactly once** — copy it now; the server only stores its
   hash and will never show it again. Treat it like a password.
2. Post to it. No auth header — the URL is the credential:

```sh
curl -sS -X POST "https://msg.example.com/v1/hooks/<hook_token>" \
  -H "Content-Type: application/json" \
  -d '{"text": "Deploy finished :rocket:"}'
# -> {"ok": true}
```

That is the whole integration. The message text is posted as `plain` format by
the hook's bot user. Webhooks have no idempotency key, so if your upstream
retries deliveries, dedupe on your side before posting (see the reference
notifier below).

**Reference:** [`github_notifier/`](github_notifier/) is a complete, tested,
stdlib-only webhook plugin — it verifies GitHub `pull_request` signatures,
formats a one-line summary, dedupes by delivery id, and POSTs to its hook URL.
Copy its shape for any webhook notifier.

---

## 2. Bots — two-way, with the Python SDK

A **bot** is a workspace user that reads and writes only in the channels it has
been granted. It authenticates with a **bot token** and can post messages, pull
history, and stream live events. The [`msg_sdk`](msg_sdk/) package makes this a
one-liner: it builds the event envelope, mints the ids, and computes the
`event_hash` the server verifies — so you never touch hashing.

### Create the bot (web UI, once)

1. **Admin → Apps → Bots → Create bot.** Give it a name, grant it the channels
   it should act in, and select scopes:
   - `events:write` — post messages,
   - `events:read` — read history and stream live events.
2. **Mint a token** for the bot. The **raw token is shown once** — copy it.

### Install

```sh
pip install "msg-sdk[ws]"    # the [ws] extra adds live event streaming
```

The base `pip install msg-sdk` is stdlib-only (posting + reading over HTTP); the
`[ws]` extra pulls in `websockets` for the live `events()` stream.

### Quickstart

```python
from msg_sdk import MsgClient

msg = MsgClient("https://msg.example.com", "<bot-token>")

# Who am I? (user_id / device_id / workspace_id — discovered via GET /v1/whoami)
me = msg.identity

# Post a message — the SDK builds the envelope and hash for you.
msg.post_message("s_…channel…", "hello from a bot")

# Read recent history.
for m in msg.list_messages("s_…channel…", limit=20):
    print(m.author_user_id, m.text)

# React to messages live (needs events:read and the [ws] extra).
for event in msg.events():
    if event.type == "message.created":
        print(event.payload["text"])
```

The client raises a typed `MsgError` on failure: `MsgHTTPError` (with the
server's problem detail) for a non-2xx response, and `MsgRejectedError` (with the
server's `code`/`detail`, e.g. `permission_denied`) when the batch endpoint
accepts the request but rejects the event.

### Worked example: an echo bot

[`examples/echo_bot.py`](examples/echo_bot.py) is a complete bot in ~15 lines: it
listens in its granted channels and echoes every message back (skipping its own,
so it never loops). The whole thing:

```python
import os

from msg_sdk import MsgClient


def main() -> None:
    msg = MsgClient(os.environ["MSG_BASE_URL"], os.environ["MSG_BOT_TOKEN"])
    me = msg.identity
    print(f"echo bot online as {me.user_id} in workspace {me.workspace_id}")

    for event in msg.events():
        if event.type != "message.created":
            continue
        if event.body["author_user_id"] == me.user_id:
            continue  # never echo our own replies (that would loop forever)
        msg.post_message(event.stream_id, f"echo: {event.payload.get('text', '')}")


if __name__ == "__main__":
    main()
```

Run it once you've created the bot + token above:

```sh
pip install "msg-sdk[ws]"
MSG_BASE_URL=https://msg.example.com \
MSG_BOT_TOKEN=<the token you minted> \
python plugins/examples/echo_bot.py
```

Post a message in one of the bot's channels and it replies `echo: <your text>`.

---

## SDK API at a glance

`MsgClient(base_url, token)`:

- `identity` / `whoami()` — the caller's own `{user_id, device_id, workspace_id,
  is_bot, role}` (via `GET /v1/whoami`), auto-discovered on first use.
- `post_message(channel_id, text, *, format="markdown", thread_root_id=…,
  file_ids=…, mentions=…) -> Message` — build + hash + upload a `message.created`.
- `list_messages(channel_id, *, limit=…, after=…, before=…) -> list[Message]` —
  read history (`GET /v1/events`), filtered to messages.
- `events(channels=None) -> Iterator[Event]` (alias `listen`) — live events over
  the WebSocket; answers the heartbeat, yields one `Event` per frame.
- `post_event(body) -> accepted` — low-level: hash + upload any event body.
- `MsgClient.post_webhook(hook_url, text)` — the trivial incoming-webhook POST.

Correctness is not on trust: the SDK's hash is pinned to the server's frozen
cross-language vectors and proven against a real server in a live end-to-end
test (see `msg_sdk/tests/`).
