//! The NDJSON event-log commands behind the `EventLog` seam (M6-3/M6-5) —
//! `<root>/streams/<stream_id>/<YYYY-MM>.ndjson`, append-only.
//!
//! Discipline (the msgctl `sync._write_page` / node-fs `NodeEventLog` twin):
//!  - `append`: O_APPEND + fsync; parent-directory fsync when the stream dir /
//!    month file was just created (a crash cannot vanish an acked line with
//!    its dirent). Every line must be exactly one newline-terminated record.
//!  - torn-tail repair before any read or append (msgctl `_scan_stream`): an
//!    interrupted append's partial trailing line is truncated away.
//!  - `stream_id` / `month` are validated FAIL-CLOSED before becoming path
//!    components (msgctl `_safe_stream_id` / `_safe_month`): a hostile value
//!    (`../…`, separators, non-`YYYY-MM`) aborts, shape-only error, no echo.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::fsutil::{fsync_dir, guard_component, is_safe_month, mkdir_durable};

fn stream_dir(root: &str, stream_id: &str) -> Result<PathBuf, String> {
    guard_component(stream_id, "stream_id")?;
    Ok(Path::new(root).join("streams").join(stream_id))
}

/// Truncate a torn (non-newline-terminated) tail off the stream's LAST month
/// file — only the most recently appended file can carry one.
fn repair_torn_tail(dir: &Path) -> Result<(), String> {
    let Some(last) = list_month_files(dir)?.pop() else {
        return Ok(());
    };
    let path = dir.join(format!("{last}.ndjson"));
    let mut f = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("open for tail repair: {e}"))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)
        .map_err(|e| format!("read for tail repair: {e}"))?;
    if bytes.is_empty() || bytes[bytes.len() - 1] == b'\n' {
        return Ok(());
    }
    // Keep everything through the final newline (0 when the whole file is torn).
    let keep = bytes
        .iter()
        .rposition(|&b| b == b'\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    f.set_len(keep as u64)
        .map_err(|e| format!("truncate torn tail: {e}"))?;
    f.sync_all()
        .map_err(|e| format!("fsync after repair: {e}"))?;
    Ok(())
}

fn list_month_files(dir: &Path) -> Result<Vec<String>, String> {
    let mut months = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(months), // absent stream dir → no months
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("read stream dir: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(month) = name.strip_suffix(".ndjson") {
            months.push(month.to_string());
        }
    }
    months.sort(); // lexical == chronological for YYYY-MM
    Ok(months)
}

/// Append complete newline-terminated NDJSON lines to
/// `<root>/streams/<stream_id>/<month>.ndjson`, durably.
#[tauri::command]
pub fn ndjson_append(
    root: String,
    stream_id: String,
    month: String,
    lines: Vec<String>,
) -> Result<(), String> {
    if lines.is_empty() {
        return Ok(());
    }
    let dir = stream_dir(&root, &stream_id)?;
    if !is_safe_month(&month) {
        return Err("refusing a malformed month partition (want YYYY-MM)".to_string());
    }
    for line in &lines {
        // Each entry must be exactly one newline-terminated NDJSON line.
        let one_trailing_newline = line.ends_with('\n') && line.find('\n') == Some(line.len() - 1);
        if !one_trailing_newline {
            return Err("append expects single newline-terminated NDJSON lines".to_string());
        }
    }
    mkdir_durable(&dir, Path::new(&root))?;
    repair_torn_tail(&dir)?;
    let path = dir.join(format!("{month}.ndjson"));
    let is_new = !path.exists();
    let mut f = OpenOptions::new()
        .append(true) // O_APPEND | O_CREAT
        .create(true)
        .open(&path)
        .map_err(|e| format!("open month file: {e}"))?;
    f.write_all(lines.concat().as_bytes())
        .map_err(|e| format!("append: {e}"))?;
    f.sync_all().map_err(|e| format!("fsync month file: {e}"))?;
    if is_new {
        fsync_dir(&dir)?;
    }
    Ok(())
}

/// The stream's month names (no `.ndjson` suffix), sorted.
#[tauri::command]
pub fn ndjson_list_months(root: String, stream_id: String) -> Result<Vec<String>, String> {
    let dir = stream_dir(&root, &stream_id)?;
    list_month_files(&dir)
}

/// Every line of every month file, months in lexical (== chronological) order,
/// WITHOUT trailing newlines; a torn trailing line is repaired first.
#[tauri::command]
pub fn ndjson_read_all(root: String, stream_id: String) -> Result<Vec<String>, String> {
    let dir = stream_dir(&root, &stream_id)?;
    repair_torn_tail(&dir)?;
    let mut lines = Vec::new();
    for month in list_month_files(&dir)? {
        let text = std::fs::read_to_string(dir.join(format!("{month}.ndjson")))
            .map_err(|e| format!("read month file: {e}"))?;
        lines.extend(text.split('\n').filter(|l| !l.is_empty()).map(String::from));
    }
    Ok(lines)
}

/// The stream dirs present on disk (rebuild-from-disk enumeration), sorted.
#[tauri::command]
pub fn ndjson_list_streams(root: String) -> Result<Vec<String>, String> {
    let streams_dir = Path::new(&root).join("streams");
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&streams_dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("read streams dir: {e}"))?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            out.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn r(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }

    #[test]
    fn append_then_read_roundtrips_in_month_order() {
        let dir = root();
        ndjson_append(
            r(&dir),
            "s_a".into(),
            "2024-02".into(),
            vec!["{\"seq\":3}\n".into()],
        )
        .unwrap();
        ndjson_append(
            r(&dir),
            "s_a".into(),
            "2024-01".into(),
            vec!["{\"seq\":1}\n".into(), "{\"seq\":2}\n".into()],
        )
        .unwrap();
        assert_eq!(
            ndjson_read_all(r(&dir), "s_a".into()).unwrap(),
            vec!["{\"seq\":1}", "{\"seq\":2}", "{\"seq\":3}"]
        );
        assert_eq!(
            ndjson_list_months(r(&dir), "s_a".into()).unwrap(),
            vec!["2024-01", "2024-02"]
        );
        // On-disk layout is exactly streams/<id>/<month>.ndjson.
        assert!(dir.path().join("streams/s_a/2024-01.ndjson").is_file());
    }

    #[test]
    fn list_streams_enumerates_dirs() {
        let dir = root();
        assert!(ndjson_list_streams(r(&dir)).unwrap().is_empty());
        ndjson_append(r(&dir), "s_b".into(), "2024-01".into(), vec!["{}\n".into()]).unwrap();
        ndjson_append(r(&dir), "s_a".into(), "2024-01".into(), vec!["{}\n".into()]).unwrap();
        assert_eq!(ndjson_list_streams(r(&dir)).unwrap(), vec!["s_a", "s_b"]);
    }

    #[test]
    fn rejects_path_traversal_stream_ids_fail_closed() {
        let dir = root();
        for bad in ["../evil", "a/b", "a\\b", "", "..", "a b"] {
            let err = ndjson_append(r(&dir), bad.into(), "2024-01".into(), vec!["{}\n".into()])
                .unwrap_err();
            assert!(err.contains("stream_id"), "{bad:?}: {err}");
            assert!(!err.contains("evil"), "raw value must never be echoed");
            assert!(ndjson_read_all(r(&dir), bad.into()).is_err());
            assert!(ndjson_list_months(r(&dir), bad.into()).is_err());
        }
        // Nothing escaped the root.
        assert!(!dir.path().parent().unwrap().join("evil").exists());
    }

    #[test]
    fn rejects_malformed_months_fail_closed() {
        let dir = root();
        for bad in ["2024-1", "202401", "../x", "2024-01.ndjson", ""] {
            let err =
                ndjson_append(r(&dir), "s_a".into(), bad.into(), vec!["{}\n".into()]).unwrap_err();
            assert!(err.contains("month"), "{bad:?}: {err}");
        }
    }

    #[test]
    fn rejects_lines_that_are_not_single_newline_terminated() {
        let dir = root();
        for bad in ["{}", "{}\n{}\n", "{}\nx", "\n\n"] {
            assert!(
                ndjson_append(r(&dir), "s_a".into(), "2024-01".into(), vec![bad.into()]).is_err()
            );
        }
        // Empty batch is a no-op, not an error.
        ndjson_append(r(&dir), "s_a".into(), "2024-01".into(), vec![]).unwrap();
        assert!(ndjson_read_all(r(&dir), "s_a".into()).unwrap().is_empty());
    }

    #[test]
    fn torn_tail_is_repaired_before_read_and_append() {
        let dir = root();
        ndjson_append(
            r(&dir),
            "s_a".into(),
            "2024-01".into(),
            vec!["{\"seq\":1}\n".into()],
        )
        .unwrap();
        // Simulate a crash mid-append: a partial line with no trailing newline.
        let path = dir.path().join("streams/s_a/2024-01.ndjson");
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{\"seq\":2,\"tor").unwrap();
        drop(f);
        // Read repairs/ignores the torn line…
        assert_eq!(
            ndjson_read_all(r(&dir), "s_a".into()).unwrap(),
            vec!["{\"seq\":1}"]
        );
        // …and a later append lands cleanly after the repaired tail.
        ndjson_append(
            r(&dir),
            "s_a".into(),
            "2024-01".into(),
            vec!["{\"seq\":2}\n".into()],
        )
        .unwrap();
        assert_eq!(
            ndjson_read_all(r(&dir), "s_a".into()).unwrap(),
            vec!["{\"seq\":1}", "{\"seq\":2}"]
        );
    }

    #[test]
    fn append_is_ordered_and_append_only() {
        let dir = root();
        for i in 1..=5 {
            ndjson_append(
                r(&dir),
                "s_a".into(),
                "2024-01".into(),
                vec![format!("{{\"seq\":{i}}}\n")],
            )
            .unwrap();
        }
        let got = ndjson_read_all(r(&dir), "s_a".into()).unwrap();
        assert_eq!(got.len(), 5);
        assert!(got.windows(2).all(|w| w[0] < w[1]));
    }
}
