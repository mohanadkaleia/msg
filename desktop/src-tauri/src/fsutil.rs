//! Shared durability + path-safety helpers — the Rust twin of the discipline
//! in `cli/msgctl/{sync,workspace,append}.py` and `web/src/worker/mirror/node-fs.ts`:
//! fsync'd appends, parent-directory fsync on dirent creation, and fail-closed
//! validation of every externally-supplied path component.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

/// The month-partition shape `YYYY-MM` (msgctl `_MONTH_RE`) — validated BEFORE
/// it becomes a path component.
pub fn is_safe_month(month: &str) -> bool {
    let b = month.as_bytes();
    b.len() == 7
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..].iter().all(u8::is_ascii_digit)
}

/// A conservative safe-path-component shape (typed ULIDs satisfy it) — the
/// twin of node-fs `SAFE_COMPONENT_RE`. Rejects `..`, separators, empties and
/// anything else that could traverse out of the workspace root (msgctl
/// `_safe_stream_id`'s trust-boundary role).
pub fn is_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Fail-closed guard: error (shape-only message, never echoing the raw value —
/// it could itself be a traversal payload) unless the component is safe.
pub fn guard_component(value: &str, what: &str) -> Result<(), String> {
    if is_safe_component(value) {
        Ok(())
    } else {
        Err(format!(
            "refusing an unsafe {what} path component (len={})",
            value.len()
        ))
    }
}

/// fsync a directory so a just-created/renamed dirent survives power loss —
/// the msgctl `_fsync_dir` twin (file-data fsync alone does not make a NEW
/// file's directory entry durable).
pub fn fsync_dir(path: &Path) -> Result<(), String> {
    // Windows cannot open directories for fsync; directory-entry durability is
    // best-effort there (matching msgctl, which is POSIX-oriented).
    #[cfg(unix)]
    {
        let dir = File::open(path).map_err(|e| format!("open dir for fsync: {e}"))?;
        dir.sync_all().map_err(|e| format!("fsync dir: {e}"))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Create `dir` (and parents) if absent; on creation, fsync the parent chain
/// up to and including `fsync_up_to` so the new dirents are durable.
pub fn mkdir_durable(dir: &Path, fsync_up_to: &Path) -> Result<bool, String> {
    if dir.is_dir() {
        return Ok(false);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    // fsync every directory from the created leaf up to the given ancestor.
    let mut cur = dir.to_path_buf();
    loop {
        fsync_dir(&cur)?;
        if cur == fsync_up_to {
            break;
        }
        match cur.parent() {
            Some(p) if cur.starts_with(fsync_up_to) && p.starts_with(fsync_up_to) => {
                cur = p.to_path_buf();
            }
            _ => break,
        }
    }
    Ok(true)
}

/// Atomic + durable file write: temp file in the SAME directory → write →
/// fsync → rename over the target → dir fsync (msgctl `write_manifest` / blob
/// store discipline). A crash mid-write leaves the prior content intact.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = target
        .parent()
        .ok_or_else(|| "write_atomic: target has no parent directory".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "write_atomic: target has no file name".to_string())?;
    let tmp = dir.join(format!(".{}.tmp.{}", file_name, std::process::id()));
    let result = (|| -> Result<(), String> {
        let mut f = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)
            .map_err(|e| format!("open temp: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("write temp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync temp: {e}"))?;
        std::fs::rename(&tmp, target).map_err(|e| format!("rename: {e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return result;
    }
    fsync_dir(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_shape_is_enforced() {
        assert!(is_safe_month("2024-01"));
        assert!(is_safe_month("2024-13")); // shape-only, like msgctl's regex
        for bad in ["2024-1", "202401", "../etc", "2024-01x", "", "24-01-x"] {
            assert!(!is_safe_month(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn component_guard_rejects_traversal() {
        assert!(is_safe_component("s_01HZXY"));
        assert!(is_safe_component("a-b_C9"));
        for bad in ["..", "../x", "a/b", "a\\b", "", ".", "a b", "a\n", "a\0b"] {
            assert!(!is_safe_component(bad), "{bad:?} must be rejected");
            assert!(guard_component(bad, "stream_id").is_err());
        }
        // The error message never echoes the raw value.
        let err = guard_component("../../etc/passwd", "stream_id").unwrap_err();
        assert!(!err.contains("etc"));
    }

    #[test]
    fn write_atomic_replaces_and_cleans_temp() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("workspace.json");
        write_atomic(&target, b"{\"v\":1}\n").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"v\":1}\n");
        write_atomic(&target, b"{\"v\":2}\n").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"{\"v\":2}\n");
        // No stray temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }
}
