# Serin plugin API

This is the complete public contract for Serin plugins (TDD §10, decision D12). A plugin is an
**external process** that talks to Serin over HTTP — there is no in-process plugin runtime, no SDK
you must link, and nothing to import from `msgd`. If your program can send HTTP requests, it can
be a Serin plugin.

A plugin may use exactly two surfaces:

1. **An incoming webhook** — a capability URL that turns `POST {"text": …}` into a message in one
   channel. Zero-auth (the URL is the credential), write-only, ideal for notifiers.
2. **A bot token** — a scoped bearer credential for the events/files API: upload events, pull
   event logs, sync stream heads, stream live events over WebSocket, upload files.

Everything else under `/v1/*` (login, sessions, invites, admin, prefs, read-state, search,
export) is a human/operator surface. **Nothing else is public to plugins**, and the management
endpoints in [§3](#3-management-surface-owneradmin--not-plugin-public) are for workspace
owners/admins, not for the plugin itself. Outgoing event subscriptions (server → plugin push) are
specified in TDD §10 but deferred — today a plugin that wants to *read* events polls
`GET /v1/events` or holds a WebSocket.

A worked, tested reference plugin lives at [`plugins/github_notifier/`](../plugins/github_notifier/)
— see [§4](#4-worked-example-the-github-notifier).

---

## 1. Incoming webhooks — `POST /v1/hooks/{hook_token}`

An admin mints a hook with `POST /v1/plugins/hooks` (§3) and receives a **capability URL** once:

```
https://msg.example.com/v1/hooks/<hook_token>
```

The URL *is* the credential — there is no `Authorization` header. Treat it like a password: it is
shown exactly once at creation (the server stores only its sha256), and anyone holding it can post
into the bound channel until the hook is revoked.

### Request

`POST` a JSON object. Two keys are read; **every other key is ignored**:

```json
{ "text": "PR #42 opened by alice: Add rate limiting — https://github.com/…/pull/42" }
```

or the de-facto-standard `blocks` form:

```json
{
  "text": "fallback text",
  "blocks": [
    { "type": "section", "text": { "text": "line one" } },
    { "type": "section", "text": { "text": "line two" } }
  ]
}
```

- **Supported `blocks` subset:** only `{"type": "section", "text": {"text": "<string>"}}`
  contributes. Section texts are joined with newlines. Every other block type — and every
  malformed entry — is silently ignored, never an error.
- **Precedence:** if `blocks` yields any text, it is used and `text` is ignored; otherwise `text`
  is used. One way or the other the delivery must yield **non-empty** text, else `400`.
- **Size limit:** the whole request body must be ≤ **16 KB** (`hook_max_body_bytes`, default
  `16384`); larger bodies are `413` before parsing.

### Effect

One `message.created` event in the hook's bound channel, authored by the hook's bot user. The
payload controls **only the text bytes** — everything else is fixed server-side:

- `format` is always `"plain"` — markdown/mrkdwn syntax arrives as inert characters,
- no mentions, no file attachments, no thread placement, no author or channel override.

The write runs the same validated pipeline as every client upload, so revoking the bot's channel
membership, disabling the hook, deactivating the bot, or archiving the channel cuts the hook off
on its next delivery.

### Responses

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{"ok": true}` | Delivered: exactly one message was created. |
| `400` | problem+json | Bad JSON, non-object body, or no non-empty text. |
| `404` | problem+json | **Uniform**: unknown token, disabled hook, deactivated bot, archived channel, or revoked membership — deliberately indistinguishable (D13). Treat as terminal; do not retry. |
| `413` | problem+json | Body over 16 KB. |
| `429` | problem+json, `Retry-After` header | Rate limited — per hook (default 60/min) and per client IP (default 120/min). Honor `Retry-After`. |

### No idempotency key — dedupe on your side

The hook endpoint has **no** idempotency mechanism: every accepted `POST` creates a new message,
so a blind retry of a delivery that actually succeeded produces a duplicate. If your upstream
retries deliveries (GitHub, Stripe, and most webhook senders redeliver at-least-once), dedupe by
the sender's delivery id (e.g. GitHub's `X-GitHub-Delivery`) *before* posting, and record an id as
done only after the hook answers `200 {"ok": true}`. The reference plugin implements exactly this
(`github_notifier/dedupe.py`).

---

## 2. Bot tokens — the authenticated surface

### Identity and access model

A **bot** is a workspace user with `is_bot=true` and role `guest`: it can read and write only in
channels it has been explicitly granted membership to (via §3 grants — under the hood these are
event-sourced `channel.member_added`/`channel.member_removed` events). A bot cannot log in;
its only credential is a **bot token**.

Bot-token **scopes** are *verbs* from a closed vocabulary — they never widen *where* the bot may
act, only *what* it may do there:

| Scope | Unlocks |
| --- | --- |
| `events:write` | `POST /v1/events/batch` |
| `events:read` | `GET /v1/events`, `GET /v1/sync`, `GET /v1/ws` |
| `files:write` | `POST /v1/files/initiate`, `PUT /v1/files/{file_id}/blob` |

A valid token missing the needed scope gets `403` (WS: pre-accept close `4403`). Token discipline:
the raw token is returned exactly once at mint (only its sha256 is stored); listings show hash
handles; a revoked token is `401` on its very next request.

### Authentication

HTTP: standard bearer header.

```
Authorization: Bearer <bot_token>
```

WebSocket: the token travels in the subprotocol list, **never** in the URL:

```
Sec-WebSocket-Protocol: bearer, <bot_token>
```

(i.e. `new WebSocket(url, ["bearer", token])`; the server echoes subprotocol `bearer`.)

### 2.1 `POST /v1/events/batch` — write events (`events:write`)

```json
{
  "events": [
    { "body": { …see below… }, "event_hash": "sha256:<64 hex chars>" }
  ]
}
```

Each `body` is a client-authored event envelope body:

```json
{
  "event_id": "m_01J8ME8XN0Y5A9GJ2V8Q0F3RZC",
  "workspace_id": "w_…",
  "stream_id": "s_…",
  "type": "message.created",
  "type_version": 1,
  "author_user_id": "u_…",
  "author_device_id": "d_…",
  "client_created_at": "2026-07-04T12:00:00.000Z",
  "payload": {
    "message_id": "m_01J8ME8XN0Y5A9GJ2V8Q0F3RZC",
    "text": "hello from a bot",
    "format": "plain",
    "thread_root_id": null,
    "file_ids": [],
    "mentions": []
  }
}
```

- **All nine top-level fields are required.** `author_user_id`/`author_device_id` must be the
  bot's own `bot_user_id` and `device_id` (both returned by the §3 bot create/list endpoints) —
  authorship is validated against the credential and cannot be spoofed.
- **Ids are client-minted typed ULIDs** (`m_`/`f_` + a 26-char Crockford-base32 ULID). Mint them
  yourself; offline minting is the design.
- **`event_hash` is frozen**: `"sha256:" + sha256hex(JCS(body))` — SHA-256 over the
  [RFC 8785 (JCS)](https://www.rfc-editor.org/rfc/rfc8785) canonicalization of `body` exactly as
  you upload it. Compute it over the *raw values you serialize* (e.g. `type_version` must be the
  integer `1`, not `"1"`). Cross-language test vectors every implementation must pass byte-for-byte
  are frozen in [`server/msgd/core/testdata/vectors.json`](../server/msgd/core/testdata/vectors.json);
  the envelope and per-type payload JSON Schemas are in [`docs/schemas/`](schemas/).
- **Caps:** request body ≤ 1 MB (`413`), ≤ 100 events per batch (`422`), each event ≤ 64 KB
  (rejected per-item, not whole-request).

Response — always `200` with a per-item partition for a well-formed request:

```json
{
  "accepted": [
    { "event_id": "m_…", "stream_id": "s_…", "server_sequence": 17,
      "server_received_at": "2026-07-04T12:00:00.123Z" }
  ],
  "rejected": [
    { "event_id": "m_…", "code": "permission_denied", "detail": "…" }
  ]
}
```

Uploads are **idempotent by `event_id`**: retrying an already-accepted event re-returns the
original acceptance (same `server_sequence`) — retry batches freely on network failure.

### 2.2 `GET /v1/events` — pull a stream's log (`events:read`)

```
GET /v1/events?stream_id=s_…&after=<seq>&limit=500
GET /v1/events?stream_id=s_…&before=<seq>&limit=500
```

- `stream_id` is required. An unknown stream and a stream the bot cannot read both return the
  identical `404` (existence is never disclosed).
- `after` (forward catch-up, exclusive; omitted ≡ `after=0`) and `before` (backward backfill,
  exclusive) are mutually exclusive (`422` if both). `limit` is clamped to `[1, 500]`.

Response:

```json
{
  "events": [
    {
      "body": { …exactly the uploaded body… },
      "event_hash": "sha256:…",
      "signature": null,
      "server": { "server_sequence": 17, "server_received_at": "…", "payload_redacted": false }
    }
  ],
  "has_more": false
}
```

Events come back in ascending `server_sequence`, which is **gapless per stream** — a gap in what
you have means missed data, not permissions. `body` is byte-faithful:
`hash_event(body) == event_hash` holds for every event you pull. Unknown event `type`s are
preserved verbatim — skip what you don't understand, never crash.

### 2.3 `GET /v1/sync` — readable streams + heads (`events:read`)

Returns every stream the bot may read (for a bot: its granted channels) with the current head:

```json
{
  "streams": [
    { "stream_id": "s_…", "kind": "channel", "name": "general", "visibility": "public",
      "head_seq": 42, "member": true, "archived": false }
  ]
}
```

Poll loop: `GET /v1/sync`, and for any stream where your local high-water mark `< head_seq`, pull
`GET /v1/events?stream_id=…&after=<your mark>` until caught up.

### 2.4 `GET /v1/ws` — live events (`events:read`)

Authenticate via the subprotocol (above). Frames are JSON text messages tagged by `"t"`:

- `{"t": "event", "event": { … }}` — one accepted event, byte-shaped exactly like a §2.2 pull
  item, fanned out live for every stream the bot may read (membership is re-checked per send —
  a revoked grant stops fanout on the next event).
- `{"t": "read_state" | "prefs" | "presence" | "typing", …}` — per-user/ephemeral signal frames;
  a typical plugin ignores them.
- Heartbeat: the server sends `{"t": "ping"}` every 30 s — answer `{"t": "pong"}` or the server
  closes `4408`.

Close codes: `4401` bad/revoked credential (pre-accept), `4403` valid token without `events:read`,
`4029` over the per-user connection cap, `4408` heartbeat timeout. WS is fanout-only — writes
always go through `POST /v1/events/batch`.

### 2.5 Files

Upload is a two-step, content-addressed handshake (both steps need `files:write`; the target
`stream_id` must be one the bot can write to):

1. `POST /v1/files/initiate` with
   `{"sha256": "<64-hex of the content>", "name": "…", "mime_type": "…", "size_bytes": N, "stream_id": "s_…"}`
   → `200 {"file_id": "f_…", "upload_needed": true|false}` (`false` = this workspace already has
   those bytes; skip step 2).
2. `PUT /v1/files/{file_id}/blob` with the raw bytes as the request body
   → `{"file_id": "f_…", "present": true}`. Size is capped (default 50 MiB) and the bytes must
   hash to the declared `sha256`.

Then reference the file: include `"file_ids": ["f_…"]` in a `message.created` payload uploaded via
§2.1. Downloads (`GET /v1/files/{file_id}`, `GET /v1/files/{file_id}/thumbnail`) are
membership-gated but need no scope.

---

## 3. Management surface (owner/admin — NOT plugin-public)

Provisioning happens over `/v1/plugins/*` with an **owner/admin session** (members, guests — and
therefore bots themselves — get `403`). A plugin never calls these; its operator does (via the web
UI or curl):

| Endpoint | Effect |
| --- | --- |
| `POST /v1/plugins/bots` `{"name", "scopes": [...], "stream_ids": [...]}` | Create a bot identity (no credential yet). Returns `bot_user_id` + `device_id` — your event bodies need both. |
| `GET /v1/plugins/bots` | List bots with grants + token hash-handles. |
| `POST /v1/plugins/bots/{bot_user_id}/tokens` `{"scopes"?}` | Mint a bot token — **the raw token appears in this response only, once**. Omitted `scopes` default to the bot's install scopes. |
| `DELETE /v1/plugins/bots/{bot_user_id}/tokens/{token_id}` | Revoke a token by its hash handle (instant). |
| `PUT /v1/plugins/bots/{bot_user_id}/streams/{stream_id}` | Grant the bot a channel (idempotent). |
| `DELETE /v1/plugins/bots/{bot_user_id}/streams/{stream_id}` | Revoke a channel grant (instant). |
| `POST /v1/plugins/hooks` `{"name", "stream_id", "bot_user_id"?}` | Create an incoming webhook — **the capability URL appears in this response only, once**. Omitted `bot_user_id` auto-provisions a bot named for the hook. |
| `GET /v1/plugins/hooks` | List hooks by hash handle (never the URL again). |
| `DELETE /v1/plugins/hooks/{hook_id}` | Revoke a hook — its URL immediately answers the uniform `404`. |

Only `kind="channel"` streams are grantable/hookable — DMs and workspace-meta are structurally
off-limits to bots and hooks.

---

## 4. Worked example: the GitHub notifier

[`plugins/github_notifier/`](../plugins/github_notifier/) is the reference consumer of surface
1 — a complete, tested plugin in a few hundred lines of stdlib-only Python that imports nothing
from `msgd` (its test suite enforces that structurally):

- receives GitHub `pull_request` webhook deliveries on a tiny HTTP server,
- verifies `X-Hub-Signature-256` (HMAC-SHA256 over the raw body, constant-time compare) and drops
  anything unsigned or tampered,
- formats `opened` / `closed` (merged vs closed) / `review_requested` into a one-line message,
- dedupes by `X-GitHub-Delivery` (a bounded LRU — see the §1 no-idempotency note),
- POSTs `{"text": …}` to its `MSG_HOOK_URL` and treats `200 {"ok": true}` as delivered.

Run it:

```sh
# 1. As a workspace admin, mint a hook (capability URL is shown ONCE):
curl -sS -X POST https://msg.example.com/v1/plugins/hooks \
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "GitHub PRs", "stream_id": "s_…general…"}'

# 2. Run the notifier with that URL + the secret you configure on the GitHub webhook:
GITHUB_WEBHOOK_SECRET='shared-secret' \
MSG_HOOK_URL='https://msg.example.com/v1/hooks/<hook_token>' \
uv run python -m github_notifier

# 3. Point a GitHub repo webhook (content type application/json, secret as above,
#    "Pull requests" events) at the notifier's address.
```
