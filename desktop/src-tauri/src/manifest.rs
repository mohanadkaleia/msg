//! The `workspace.json` manifest commands behind the `ManifestStore` seam
//! (M6-3/M6-5): atomic + durable writes (temp → fsync → rename → dir fsync,
//! the msgctl `write_manifest` discipline) so a crash mid-registration leaves
//! the prior manifest intact — never a torn one.
//!
//! The manifest content is authored by the TS `WorkspaceMirror` (the key names
//! are load-bearing for `msgctl verify`); this layer only checks it is valid
//! JSON (fail-closed against writing garbage) and owns durability.

use std::path::Path;

use crate::fsutil::{mkdir_durable, write_atomic};

/// Read `<root>/workspace.json`, `None` when absent.
#[tauri::command]
pub fn manifest_read(root: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(Path::new(&root).join("workspace.json")) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read manifest: {e}")),
    }
}

/// Atomically replace `<root>/workspace.json` with `json` (a pre-serialized
/// manifest document — validated to parse as a JSON object before any byte
/// lands on disk).
#[tauri::command]
pub fn manifest_write(root: String, json: String) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("manifest is not valid JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("manifest must be a JSON object".to_string());
    }
    let root_path = Path::new(&root);
    mkdir_durable(root_path, root_path)?;
    write_atomic(&root_path.join("workspace.json"), json.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        assert_eq!(manifest_read(root.clone()).unwrap(), None);
        let doc = "{\n  \"format_version\": 1,\n  \"workspace_id\": \"w_x\"\n}\n";
        manifest_write(root.clone(), doc.to_string()).unwrap();
        assert_eq!(manifest_read(root.clone()).unwrap().as_deref(), Some(doc));
    }

    #[test]
    fn overwrite_is_atomic_and_leaves_no_temp() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        manifest_write(root.clone(), "{\"v\":1}".to_string()).unwrap();
        manifest_write(root.clone(), "{\"v\":2}".to_string()).unwrap();
        assert_eq!(
            manifest_read(root.clone()).unwrap().as_deref(),
            Some("{\"v\":2}")
        );
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }

    #[test]
    fn invalid_json_is_rejected_and_prior_manifest_survives() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        manifest_write(root.clone(), "{\"v\":1}".to_string()).unwrap();
        assert!(manifest_write(root.clone(), "{not json".to_string()).is_err());
        assert!(manifest_write(root.clone(), "[1,2]".to_string()).is_err());
        assert_eq!(
            manifest_read(root).unwrap().as_deref(),
            Some("{\"v\":1}"),
            "a rejected write must leave the prior manifest intact"
        );
    }
}
