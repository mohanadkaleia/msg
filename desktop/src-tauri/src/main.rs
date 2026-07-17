//! msg desktop shell (ENG-170, M6-5) — the Tauri v2 host.
//!
//! The window loads the SAME built Vue SPA the web serves (web/dist via
//! `frontendDist`; the Vite dev server via `devUrl` under `tauri dev`) — zero
//! component changes. What this host adds is the native seam implementations
//! the TS drivers in `web/src/worker/tauri/` invoke:
//!
//!   - `sql_*`       → the SqlDriver seam over bundled-SQLite (FTS5 included)
//!   - `ndjson_*`    → the EventLog seam (fsync'd NDJSON appends)
//!   - `manifest_*`  → the ManifestStore seam (atomic workspace.json)
//!   - `blob_*`      → the BlobCache seam (content-addressed, verified)
//!   - `secret_*`    → the SecretStore seam (OS keychain; 0600-file fallback)
//!   - `desktop_config_*` → onboarding config (server URL + workspace folder)
//!
//! Plugins: `http` (webview fetch replacement — /v1 calls bypass tauri://
//! CORS), `dialog` (onboarding folder picker), `websocket` (the documented
//! FALLBACK WS transport should the webview refuse a raw WebSocket from the
//! tauri:// origin — see desktop/README.md).

// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod blobs;
mod config;
mod fsutil;
mod manifest;
mod ndjson;
mod secret;
mod sqlite;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_websocket::init())
        .manage(sqlite::DbPool::default())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            app.manage(secret::SecretVault::new(app_data));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sqlite::sql_open,
            sqlite::sql_execute,
            sqlite::sql_select,
            sqlite::sql_transaction,
            sqlite::sql_close,
            ndjson::ndjson_append,
            ndjson::ndjson_list_months,
            ndjson::ndjson_read_all,
            ndjson::ndjson_list_streams,
            manifest::manifest_read,
            manifest::manifest_write,
            blobs::blob_put,
            blobs::blob_get,
            blobs::blob_has,
            secret::secret_get,
            secret::secret_set,
            secret::secret_delete,
            config::desktop_config_read,
            config::desktop_config_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the msg desktop shell");
}
