//! The content-addressed blob-store commands behind the `BlobCache` seam
//! (M6-3/M6-5): `<root>/blobs/<ab>/<sha256hex>`, the server BlobStore /
//! node-fs `NodeBlobCache` twin.
//!
//!  - keys are BARE 64-char lowercase-hex sha256 — anything else is rejected
//!    fail-closed BEFORE becoming a path component;
//!  - `blob_put` re-hashes the bytes and refuses a mismatch (never store bytes
//!    that do not hash to their key — the folder must stay verify-green);
//!  - writes are atomic (temp + rename + dir fsync) and idempotent.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::fsutil::{mkdir_durable, write_atomic};

fn is_sha256_hex(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn blob_path(root: &str, sha256: &str) -> Result<PathBuf, String> {
    if !is_sha256_hex(sha256) {
        return Err("refusing a malformed blob key (want bare lowercase sha256 hex)".to_string());
    }
    Ok(Path::new(root)
        .join("blobs")
        .join(&sha256[..2])
        .join(sha256))
}

/// Store `bytes` under their sha256 key, atomically and idempotently.
#[tauri::command]
pub fn blob_put(root: String, sha256: String, bytes: Vec<u8>) -> Result<(), String> {
    let path = blob_path(&root, &sha256)?;
    if path.exists() {
        return Ok(()); // content-addressed — idempotent
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != sha256 {
        return Err("blob bytes do not hash to their key; refusing to store".to_string());
    }
    let dir = path.parent().expect("blob path always has a parent");
    let root_path = Path::new(&root);
    mkdir_durable(dir, root_path)?;
    write_atomic(&path, &bytes)
}

/// The blob's bytes, or `None` when absent.
#[tauri::command]
pub fn blob_get(root: String, sha256: String) -> Result<Option<Vec<u8>>, String> {
    let path = blob_path(&root, &sha256)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read blob: {e}")),
    }
}

/// Whether the blob is present.
#[tauri::command]
pub fn blob_has(root: String, sha256: String) -> Result<bool, String> {
    Ok(blob_path(&root, &sha256)?.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha_of(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn put_get_has_roundtrip_with_ab_sharded_layout() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let bytes = vec![1u8, 2, 3, 4, 5];
        let sha = sha_of(&bytes);
        assert!(!blob_has(root.clone(), sha.clone()).unwrap());
        assert_eq!(blob_get(root.clone(), sha.clone()).unwrap(), None);
        blob_put(root.clone(), sha.clone(), bytes.clone()).unwrap();
        assert!(blob_has(root.clone(), sha.clone()).unwrap());
        assert_eq!(blob_get(root.clone(), sha.clone()).unwrap(), Some(bytes));
        // Layout: blobs/<ab>/<hex> (server BlobStore / §9 bundle layout).
        assert!(dir
            .path()
            .join("blobs")
            .join(&sha[..2])
            .join(&sha)
            .is_file());
    }

    #[test]
    fn put_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let bytes = b"hello".to_vec();
        let sha = sha_of(&bytes);
        blob_put(root.clone(), sha.clone(), bytes.clone()).unwrap();
        blob_put(root.clone(), sha.clone(), bytes.clone()).unwrap();
        assert_eq!(blob_get(root, sha).unwrap(), Some(bytes));
    }

    #[test]
    fn put_rejects_bytes_that_do_not_hash_to_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let wrong_key = sha_of(b"other bytes");
        let err = blob_put(root.clone(), wrong_key.clone(), b"hello".to_vec()).unwrap_err();
        assert!(err.contains("do not hash"));
        assert!(!blob_has(root, wrong_key).unwrap(), "nothing may be stored");
    }

    #[test]
    fn rejects_malformed_keys_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let bad_keys = [
            "abc",                             // too short
            &"A".repeat(64),                   // uppercase hex
            &"g".repeat(64),                   // non-hex
            &format!("../{}", "a".repeat(61)), // traversal
            "",                                // empty
            &format!("{}\n", "a".repeat(63)),  // control char
        ];
        for bad in bad_keys {
            assert!(
                blob_put(root.clone(), bad.to_string(), vec![1]).is_err(),
                "{bad:?}"
            );
            assert!(blob_get(root.clone(), bad.to_string()).is_err());
            assert!(blob_has(root.clone(), bad.to_string()).is_err());
        }
    }
}
