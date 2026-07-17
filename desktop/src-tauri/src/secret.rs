//! The OS-keychain commands behind the `SecretStore` seam (M6-4/M6-5): where
//! the session token rests AT REST on the desktop — NEVER inside the portable
//! workspace folder (which is handed to `msgctl verify`, zipped, synced).
//!
//! Primary backend: the OS keychain via the `keyring` crate (macOS Keychain;
//! native stores on Windows/Linux). Fallback (documented, fail-open to a
//! DIFFERENT local-only location — never the workspace): a 0600 JSON file in
//! the app-data dir, used when the keychain is unavailable (headless CI,
//! locked-down sessions). The fallback file lives OUTSIDE any workspace
//! folder by construction.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::fsutil::write_atomic;

/// The keychain service name (one namespace for all msg-desktop secrets).
const SERVICE: &str = "app.msg.desktop";

pub struct SecretVault {
    /// `<app-data>/secrets.json` — the 0600 fallback file.
    fallback_path: PathBuf,
    /// Disabled in unit tests so `cargo test` never touches a real keychain.
    use_keyring: bool,
}

/// Whether a keyring failure means "the keychain itself is unusable here"
/// (→ fall back to the file) rather than a caller/entry-level error.
fn keychain_unavailable(err: &keyring::Error) -> bool {
    matches!(
        err,
        keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)
    )
}

impl SecretVault {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            fallback_path: app_data_dir.join("secrets.json"),
            use_keyring: true,
        }
    }

    #[cfg(test)]
    fn file_only(dir: &std::path::Path) -> Self {
        Self {
            fallback_path: dir.join("secrets.json"),
            use_keyring: false,
        }
    }

    // -- file fallback ------------------------------------------------------

    fn load_file(&self) -> Result<BTreeMap<String, String>, String> {
        match std::fs::read_to_string(&self.fallback_path) {
            Ok(text) => {
                serde_json::from_str(&text).map_err(|e| format!("secrets file corrupt: {e}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("read secrets file: {e}")),
        }
    }

    fn save_file(&self, map: &BTreeMap<String, String>) -> Result<(), String> {
        let dir = self
            .fallback_path
            .parent()
            .ok_or_else(|| "secrets path has no parent".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir app data: {e}"))?;
        let payload = serde_json::to_string(map).map_err(|e| e.to_string())?;
        write_atomic(&self.fallback_path, payload.as_bytes())?;
        // Owner-only: the fallback holds a bearer token in plaintext, so the
        // file mode is the whole protection (unix; Windows relies on the
        // per-user profile ACL).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.fallback_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("chmod secrets file: {e}"))?;
        }
        Ok(())
    }

    fn file_get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.load_file()?.get(key).cloned())
    }

    fn file_set(&self, key: &str, value: &str) -> Result<(), String> {
        let mut map = self.load_file()?;
        map.insert(key.to_string(), value.to_string());
        self.save_file(&map)
    }

    fn file_delete(&self, key: &str) -> Result<(), String> {
        let mut map = self.load_file()?;
        if map.remove(key).is_some() {
            self.save_file(&map)?;
        }
        Ok(())
    }

    // -- the SecretStore surface (get/set/delete, null-shaped like the seam) --

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        if self.use_keyring {
            match keyring::Entry::new(SERVICE, key).and_then(|e| e.get_password()) {
                Ok(value) => return Ok(Some(value)),
                // Absent in the keychain — still consult the fallback file (a
                // value may have landed there while the keychain was down).
                Err(keyring::Error::NoEntry) => {}
                Err(e) if keychain_unavailable(&e) => {}
                Err(e) => return Err(format!("keychain get: {e}")),
            }
        }
        self.file_get(key)
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if self.use_keyring {
            match keyring::Entry::new(SERVICE, key).and_then(|e| e.set_password(value)) {
                Ok(()) => {
                    // The keychain now owns the secret; drop any stale
                    // fallback copy so exactly one at-rest home remains.
                    self.file_delete(key)?;
                    return Ok(());
                }
                Err(e) if keychain_unavailable(&e) => {}
                Err(e) => return Err(format!("keychain set: {e}")),
            }
        }
        self.file_set(key, value)
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        if self.use_keyring {
            match keyring::Entry::new(SERVICE, key).and_then(|e| e.delete_credential()) {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) if keychain_unavailable(&e) => {}
                Err(e) => return Err(format!("keychain delete: {e}")),
            }
        }
        // Always clear the fallback too (delete must be total).
        self.file_delete(key)
    }
}

/// `get` — `null` when absent (the seam is null-shaped, never undefined).
#[tauri::command]
pub fn secret_get(
    vault: tauri::State<'_, SecretVault>,
    key: String,
) -> Result<Option<String>, String> {
    vault.get(&key)
}

#[tauri::command]
pub fn secret_set(
    vault: tauri::State<'_, SecretVault>,
    key: String,
    value: String,
) -> Result<(), String> {
    vault.set(&key, &value)
}

#[tauri::command]
pub fn secret_delete(vault: tauri::State<'_, SecretVault>, key: String) -> Result<(), String> {
    vault.delete(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_fallback_set_get_delete_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let vault = SecretVault::file_only(dir.path());
        assert_eq!(vault.get("token").unwrap(), None);
        vault.set("token", "tok_secret_1").unwrap();
        assert_eq!(vault.get("token").unwrap().as_deref(), Some("tok_secret_1"));
        // Overwrite wins.
        vault.set("token", "tok_secret_2").unwrap();
        assert_eq!(vault.get("token").unwrap().as_deref(), Some("tok_secret_2"));
        // Delete is total and idempotent.
        vault.delete("token").unwrap();
        assert_eq!(vault.get("token").unwrap(), None);
        vault.delete("token").unwrap();
    }

    #[test]
    fn multiple_keys_are_independent() {
        let dir = tempfile::tempdir().unwrap();
        let vault = SecretVault::file_only(dir.path());
        vault.set("a", "1").unwrap();
        vault.set("b", "2").unwrap();
        vault.delete("a").unwrap();
        assert_eq!(vault.get("a").unwrap(), None);
        assert_eq!(vault.get("b").unwrap().as_deref(), Some("2"));
    }

    #[cfg(unix)]
    #[test]
    fn fallback_file_is_owner_only_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let vault = SecretVault::file_only(dir.path());
        vault.set("token", "tok_secret").unwrap();
        let mode = std::fs::metadata(dir.path().join("secrets.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn corrupt_fallback_file_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("secrets.json"), b"{not json").unwrap();
        let vault = SecretVault::file_only(dir.path());
        assert!(vault.get("token").is_err());
        assert!(
            vault.set("token", "x").is_err(),
            "never clobber a corrupt store"
        );
    }

    /// Real OS-keychain round-trip. IGNORED by default (`cargo test --
    /// --ignored` to run): CI runners and sandboxes may have no usable
    /// keychain, and the file fallback above is the CI-tested path.
    #[test]
    #[ignore = "touches the real OS keychain; run manually with --ignored"]
    fn real_keychain_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let vault = SecretVault::new(dir.path().to_path_buf());
        vault.set("msg_test_secret", "tok_keychain_test").unwrap();
        assert_eq!(
            vault.get("msg_test_secret").unwrap().as_deref(),
            Some("tok_keychain_test")
        );
        vault.delete("msg_test_secret").unwrap();
        assert_eq!(vault.get("msg_test_secret").unwrap(), None);
    }
}
