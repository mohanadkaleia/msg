//! The SQLite host commands behind the `SqlDriver` seam (M6-1/M6-5), over
//! rusqlite with the BUNDLED modern SQLite — FTS5 is therefore guaranteed,
//! which is what `SqliteDb`'s `messages_fts` virtual table (M6-2) relies on.
//!
//! Connections are pooled per canonical db path (one per workspace
//! `projections.sqlite3`); each is wrapped in a `Mutex`, so command calls on
//! the same file serialize. Transactions arrive either as one batched
//! `sql_transaction` (all-or-nothing) or as the TS driver's BEGIN…COMMIT
//! bracket over `sql_execute` (the TS side owns the FIFO discipline, exactly
//! like the Node driver).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::types::{Value as SqlNative, ValueRef};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Map, Number, Value};
use tauri::State;

/// One bound parameter — the wire twin of the TS `SqlValue`
/// (`number | string | Uint8Array | null`; a `Uint8Array` crosses as a JSON
/// byte array). Untagged: tried in order, ints before floats.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum SqlParam {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl From<&SqlParam> for SqlNative {
    fn from(p: &SqlParam) -> Self {
        match p {
            SqlParam::Null => SqlNative::Null,
            SqlParam::Int(i) => SqlNative::Integer(*i),
            SqlParam::Real(f) => SqlNative::Real(*f),
            SqlParam::Text(s) => SqlNative::Text(s.clone()),
            SqlParam::Blob(b) => SqlNative::Blob(b.clone()),
        }
    }
}

/// One statement of a batched transaction.
#[derive(Deserialize)]
pub struct SqlStatement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<SqlParam>,
}

/// The per-path connection pool, managed as Tauri state.
#[derive(Default)]
pub struct DbPool(Mutex<HashMap<PathBuf, Arc<Mutex<Connection>>>>);

impl DbPool {
    /// Open (or reuse) the connection for `path`, creating parent dirs so a
    /// fresh workspace folder can receive its `projections.sqlite3`.
    fn connection(&self, path: &str) -> Result<Arc<Mutex<Connection>>, String> {
        let key = PathBuf::from(path);
        let mut pool = self.0.lock().map_err(|_| "db pool poisoned".to_string())?;
        if let Some(conn) = pool.get(&key) {
            return Ok(Arc::clone(conn));
        }
        if let Some(parent) = key.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir db parent: {e}"))?;
            }
        }
        let conn = Connection::open(&key).map_err(|e| format!("open sqlite db: {e}"))?;
        let conn = Arc::new(Mutex::new(conn));
        pool.insert(key, Arc::clone(&conn));
        Ok(conn)
    }

    fn remove(&self, path: &str) -> Option<Arc<Mutex<Connection>>> {
        self.0.lock().ok()?.remove(&PathBuf::from(path))
    }
}

fn value_to_json(v: ValueRef<'_>) -> Result<Value, String> {
    Ok(match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => Value::Number(
            Number::from_f64(f).ok_or_else(|| "non-finite REAL in result row".to_string())?,
        ),
        ValueRef::Text(t) => {
            json!(String::from_utf8(t.to_vec()).map_err(|e| format!("non-utf8 TEXT: {e}"))?)
        }
        ValueRef::Blob(b) => json!(b),
    })
}

pub fn execute_on(conn: &Connection, sql: &str, params: &[SqlParam]) -> Result<(), String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare: {e}"))?;
    let natives: Vec<SqlNative> = params.iter().map(SqlNative::from).collect();
    if stmt.column_count() > 0 {
        // A row-returning statement (PRAGMA, `… RETURNING`) must be stepped;
        // rows are discarded (the NodeSqlDriver `.reader` twin).
        let mut rows = stmt
            .query(rusqlite::params_from_iter(natives))
            .map_err(|e| format!("query: {e}"))?;
        while rows.next().map_err(|e| format!("step: {e}"))?.is_some() {}
    } else {
        stmt.execute(rusqlite::params_from_iter(natives))
            .map_err(|e| format!("execute: {e}"))?;
    }
    Ok(())
}

pub fn select_on(
    conn: &Connection,
    sql: &str,
    params: &[SqlParam],
) -> Result<Vec<Map<String, Value>>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare: {e}"))?;
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let natives: Vec<SqlNative> = params.iter().map(SqlNative::from).collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(natives))
        .map_err(|e| format!("query: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("step: {e}"))? {
        let mut obj = Map::with_capacity(columns.len());
        for (i, name) in columns.iter().enumerate() {
            let v = row.get_ref(i).map_err(|e| format!("column {name}: {e}"))?;
            obj.insert(name.clone(), value_to_json(v)?);
        }
        out.push(obj);
    }
    Ok(out)
}

pub fn transaction_on(conn: &mut Connection, statements: &[SqlStatement]) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("begin transaction: {e}"))?;
    for st in statements {
        execute_on(&tx, &st.sql, &st.params)?; // Drop rolls back on error
    }
    tx.commit().map_err(|e| format!("commit: {e}"))
}

/// Open (or reuse) the pooled connection for `path`.
#[tauri::command]
pub fn sql_open(pool: State<'_, DbPool>, path: String) -> Result<(), String> {
    pool.connection(&path).map(|_| ())
}

/// Run ONE statement (DDL/DML/PRAGMA); result rows, if any, are discarded.
#[tauri::command]
pub fn sql_execute(
    pool: State<'_, DbPool>,
    path: String,
    sql: String,
    params: Vec<SqlParam>,
) -> Result<(), String> {
    let conn = pool.connection(&path)?;
    let conn = conn
        .lock()
        .map_err(|_| "db connection poisoned".to_string())?;
    execute_on(&conn, &sql, &params)
}

/// Run ONE statement and return its rows as objects keyed by column name.
#[tauri::command]
pub fn sql_select(
    pool: State<'_, DbPool>,
    path: String,
    sql: String,
    params: Vec<SqlParam>,
) -> Result<Vec<Map<String, Value>>, String> {
    let conn = pool.connection(&path)?;
    let conn = conn
        .lock()
        .map_err(|_| "db connection poisoned".to_string())?;
    select_on(&conn, &sql, &params)
}

/// Run `statements` inside a single BEGIN…COMMIT (ROLLBACK on any error).
#[tauri::command]
pub fn sql_transaction(
    pool: State<'_, DbPool>,
    path: String,
    statements: Vec<SqlStatement>,
) -> Result<(), String> {
    let conn = pool.connection(&path)?;
    let mut conn = conn
        .lock()
        .map_err(|_| "db connection poisoned".to_string())?;
    transaction_on(&mut conn, &statements)
}

/// Drop the pooled connection (rusqlite closes on drop).
#[tauri::command]
pub fn sql_close(pool: State<'_, DbPool>, path: String) -> Result<(), String> {
    pool.remove(&path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn execute_select_roundtrip_typed_values() {
        let conn = mem();
        execute_on(
            &conn,
            "CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n TEXT)",
            &[],
        )
        .unwrap();
        execute_on(
            &conn,
            "INSERT INTO t VALUES (?, ?, ?, ?, ?)",
            &[
                SqlParam::Int(42),
                SqlParam::Real(1.5),
                SqlParam::Text("hi".into()),
                SqlParam::Blob(vec![1, 2, 255]),
                SqlParam::Null,
            ],
        )
        .unwrap();
        let rows = select_on(&conn, "SELECT i, r, s, b, n FROM t", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["i"], json!(42));
        assert_eq!(rows[0]["r"], json!(1.5));
        assert_eq!(rows[0]["s"], json!("hi"));
        assert_eq!(rows[0]["b"], json!([1, 2, 255]));
        assert_eq!(rows[0]["n"], Value::Null);
    }

    #[test]
    fn execute_steps_row_returning_statements() {
        let conn = mem();
        // PRAGMA and `… RETURNING` are readers; execute must step, not throw.
        execute_on(&conn, "PRAGMA journal_mode=WAL", &[]).unwrap();
        execute_on(&conn, "CREATE TABLE t (x INTEGER PRIMARY KEY)", &[]).unwrap();
        execute_on(
            &conn,
            "INSERT INTO t (x) VALUES (?) RETURNING x",
            &[SqlParam::Int(7)],
        )
        .unwrap();
        let rows = select_on(&conn, "SELECT x FROM t", &[]).unwrap();
        assert_eq!(rows[0]["x"], json!(7));
    }

    #[test]
    fn transaction_commits_all_or_rolls_back() {
        let mut conn = mem();
        execute_on(&conn, "CREATE TABLE t (x INTEGER PRIMARY KEY)", &[]).unwrap();
        transaction_on(
            &mut conn,
            &[
                SqlStatement {
                    sql: "INSERT INTO t (x) VALUES (?)".into(),
                    params: vec![SqlParam::Int(1)],
                },
                SqlStatement {
                    sql: "INSERT INTO t (x) VALUES (?)".into(),
                    params: vec![SqlParam::Int(2)],
                },
            ],
        )
        .unwrap();
        // A failing batch (duplicate PK) rolls back its earlier statements.
        let err = transaction_on(
            &mut conn,
            &[
                SqlStatement {
                    sql: "INSERT INTO t (x) VALUES (?)".into(),
                    params: vec![SqlParam::Int(3)],
                },
                SqlStatement {
                    sql: "INSERT INTO t (x) VALUES (?)".into(),
                    params: vec![SqlParam::Int(1)],
                },
            ],
        );
        assert!(err.is_err());
        let rows = select_on(&conn, "SELECT x FROM t ORDER BY x", &[]).unwrap();
        assert_eq!(
            rows.iter().map(|r| r["x"].clone()).collect::<Vec<_>>(),
            vec![json!(1), json!(2)],
            "the rolled-back 3 must not persist"
        );
    }

    #[test]
    fn fts5_is_available_in_the_bundled_sqlite() {
        // The M6-2 guarantee: SqliteDb's external-content messages_fts table
        // must be creatable and queryable on this exact SQLite build.
        let conn = mem();
        execute_on(
            &conn,
            "CREATE TABLE messages (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL)",
            &[],
        )
        .unwrap();
        execute_on(
            &conn,
            "CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid')",
            &[],
        )
        .unwrap();
        execute_on(
            &conn,
            "INSERT INTO messages (rowid, text) VALUES (1, 'offline search target')",
            &[],
        )
        .unwrap();
        execute_on(
            &conn,
            "INSERT INTO messages_fts (rowid, text) VALUES (1, 'offline search target')",
            &[],
        )
        .unwrap();
        let rows = select_on(
            &conn,
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?",
            &[SqlParam::Text("offline".into())],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["rowid"], json!(1));
    }

    #[test]
    fn pool_reuses_one_connection_per_path_and_creates_parents() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir
            .path()
            .join("ws/projections.sqlite3")
            .to_string_lossy()
            .into_owned();
        let pool = DbPool::default();
        let a = pool.connection(&db_path).unwrap();
        let b = pool.connection(&db_path).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "same path → same pooled connection");
        {
            let conn = a.lock().unwrap();
            execute_on(&conn, "CREATE TABLE t (x)", &[]).unwrap();
        }
        assert!(dir.path().join("ws/projections.sqlite3").is_file());
        assert!(pool.remove(&db_path).is_some());
        assert!(pool.remove(&db_path).is_none());
    }
}
