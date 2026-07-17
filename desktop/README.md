# msg desktop (Tauri v2) — ENG-170, M6-5

The native desktop shell. The window loads the **same built Vue SPA** the web
serves (`web/dist` — zero component changes); what this layer adds is the Rust
host behind the M6 seams:

| Seam (TS interface)              | TS driver (`web/src/worker/tauri/`) | Rust commands (`src-tauri/src/`)      |
| -------------------------------- | ----------------------------------- | ------------------------------------- |
| `SqlDriver` (M6-1)               | `sql-driver.ts`                     | `sqlite.rs` — `sql_*` (rusqlite, bundled SQLite, FTS5 proven by test) |
| `EventLog` (M6-3)                | `fs.ts` `TauriEventLog`             | `ndjson.rs` — `ndjson_*` (O_APPEND + fsync, dir-fsync on create, torn-tail repair, fail-closed `stream_id`/month guards) |
| `ManifestStore` (M6-3)           | `fs.ts` `TauriManifestStore`        | `manifest.rs` — atomic temp → fsync → rename → dir-fsync |
| `BlobCache` (M6-3)               | `fs.ts` `TauriBlobCache`            | `blobs.rs` — `blobs/<ab>/<hex>`, content re-verified, atomic, idempotent |
| `SecretStore` (M6-4)             | `secret-store.ts`                   | `secret.rs` — OS keychain (`keyring`), 0600 app-data file fallback |
| desktop config (server URL + workspace folder) | `config.ts`           | `config.rs` — `config.json` in the OS app-config dir |

Boot: `web/src/worker/client.ts` detects `window.__TAURI_INTERNALS__` → solo
transport + the desktop trim from `web/src/worker/tauri/boot.ts` (SqliteDb on
`<workspace>/projections.sqlite3`, `fullMirror: true`, on-disk
`WorkspaceMirror`, keychain SecretStore, plugin-http `fetch`, explicit
`baseUrl`/`wsUrl` from the configured server). First run (no config) routes to
the `/onboarding` view, which persists the config and reloads.

Everything under `web/src/worker/tauri/` is reachable only through a dynamic
import behind the runtime check, so the web entry bundle never pulls Tauri
(and `better-sqlite3` stays out of every emitted chunk).

## Developing

Prereqs: Rust stable (`rustup`), Node 22 + pnpm 9 (web/), and the
[Tauri v2 system deps](https://v2.tauri.app/start/prerequisites/) on Linux.

```sh
cargo install tauri-cli --locked   # once

cd desktop/src-tauri
cargo tauri dev      # runs `pnpm --dir ../web dev` + opens the shell on the dev URL
cargo tauri build    # builds web/dist and bundles the .app/.dmg (macOS)

cargo test           # the host-command suite
cargo fmt --check && cargo clippy --all-targets -- -D warnings
cargo test -- --ignored   # additionally exercises the REAL OS keychain
```

macOS is the shipping target for M6-5; Linux/Windows bundling is a follow-up
(the crate compiles + tests on ubuntu CI, and `keyring` uses `linux-native`/
`windows-native` backends, but neither platform is packaged or validated yet).

## WebSocket from the `tauri://` webview

The live event stream is a raw browser WebSocket carrying the bearer token as
the `Sec-WebSocket-Protocol: bearer, <token>` subprotocol (never the URL), and
msgd accepts with `subprotocol="bearer"` (`server/msgd/ws/router.py`).

- **Primary path (default): the webview's own `WebSocket`.** WS upgrades are
  not subject to CORS, and WKWebView permits `new WebSocket(url, ['bearer',
  token])` from a custom-scheme page. `wss://…` (TLS) endpoints are expected
  to work; `ws://localhost` is exempt from mixed-content rules.
- **Known risk:** a plain `ws://` endpoint on a NON-localhost host may be
  refused by the webview as mixed content from the app origin. This cannot be
  proven headlessly — it is on the manual validation checklist.
- **Fallback (implemented + selectable): the Rust-side socket** via
  `tauri-plugin-websocket` (`web/src/worker/tauri/ws.ts`, header
  `Sec-WebSocket-Protocol: bearer, <token>` on the tungstenite client). Opt in
  with `"wsTransport": "plugin"` in the desktop `config.json`; the default is
  `"raw"`.

## Where things live on disk (macOS)

- Workspace folder (user-chosen): `streams/…`, `blobs/…`, `workspace.json`,
  `projections.sqlite3` — a superset of a `msgctl verify`-green workspace.
  **Never** contains the session token.
- App config: `~/Library/Application Support/app.msg.desktop/config.json`
  (server URL + workspace path; non-secret).
- Session token: macOS Keychain, service `app.msg.desktop` (fallback:
  `secrets.json`, mode 0600, in the app-data dir — only when the keychain is
  unavailable).
