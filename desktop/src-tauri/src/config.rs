//! Desktop app configuration (`config.json` in the OS app-config dir): the
//! onboarding-persisted server URL + workspace folder. NON-secret (the token
//! lives in the SecretStore / keychain); kept OUTSIDE the workspace folder so
//! the folder stays a pure msgctl workspace.
//!
//! The document is an opaque JSON object owned by the TS side
//! (`web/src/worker/tauri/config.ts` defines the shape); this layer validates
//! JSON-object-ness fail-closed and owns atomic durability.

use std::path::Path;

use tauri::Manager;

use crate::fsutil::write_atomic;

const CONFIG_FILE: &str = "config.json";

pub fn read_from(dir: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(dir.join(CONFIG_FILE)) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read desktop config: {e}")),
    }
}

pub fn write_to(dir: &Path, json: &str) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("config is not valid JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("config must be a JSON object".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    write_atomic(&dir.join(CONFIG_FILE), json.as_bytes())
}

/// The persisted desktop config JSON, `null` on first run.
#[tauri::command]
pub fn desktop_config_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))?;
    read_from(&dir)
}

/// Persist the desktop config JSON atomically.
#[tauri::command]
pub fn desktop_config_write(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app config dir: {e}"))?;
    write_to(&dir, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_write_roundtrip_and_first_run_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_from(dir.path()).unwrap(), None);
        let doc = "{\"serverUrl\":\"https://msg.example.com\",\"workspaceDir\":\"/tmp/ws\"}";
        write_to(dir.path(), doc).unwrap();
        assert_eq!(read_from(dir.path()).unwrap().as_deref(), Some(doc));
        // Overwrite wins atomically.
        write_to(dir.path(), "{\"serverUrl\":\"http://other\"}").unwrap();
        assert_eq!(
            read_from(dir.path()).unwrap().as_deref(),
            Some("{\"serverUrl\":\"http://other\"}")
        );
    }

    #[test]
    fn rejects_non_object_config_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        write_to(dir.path(), "{\"v\":1}").unwrap();
        assert!(write_to(dir.path(), "not json").is_err());
        assert!(write_to(dir.path(), "[1]").is_err());
        assert_eq!(read_from(dir.path()).unwrap().as_deref(), Some("{\"v\":1}"));
    }
}
