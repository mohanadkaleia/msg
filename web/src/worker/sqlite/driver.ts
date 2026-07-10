// worker/sqlite/driver.ts — the SqlDriver seam (ENG-165, M6-1).
//
// SqliteDb (sqlite-db.ts) speaks ONLY this tiny interface, so the same MsgDb
// implementation runs over any SQLite host: the Node `better-sqlite3` driver
// (node-driver.ts — synchronous, CI/test) today, and the async Tauri
// `plugin-sql` driver in M6. Every method is therefore ASYNC-COMPATIBLE: it
// may return either a value or a Promise, and SqliteDb always `await`s.
//
// Pure types — no platform globals, no runtime dependencies.

/** The SQLite value domain a bound parameter / selected column may take. */
export type SqlValue = number | string | Uint8Array | null

/**
 * A minimal SQL connection. Contract details SqliteDb relies on:
 *
 *  - `execute` runs ONE statement (DDL/DML/PRAGMA) with optional positional
 *    (`?`) params. Result rows, if any, are discarded.
 *  - `select` runs ONE statement and returns its rows as plain objects keyed
 *    by column name. It is also the escape hatch for row-returning writes
 *    (`UPDATE … RETURNING`), which SqliteDb uses for its atomic monotonic
 *    compare-and-set statements.
 *  - `transaction` runs `fn` inside a single BEGIN…COMMIT (ROLLBACK on throw).
 *    SqliteDb never nests transactions.
 *  - Drivers may be synchronous (better-sqlite3) or asynchronous (Tauri);
 *    callers must treat every return value as awaitable.
 */
export interface SqlDriver {
  execute(sql: string, params?: readonly SqlValue[]): void | Promise<void>
  select<T = Record<string, SqlValue>>(
    sql: string,
    params?: readonly SqlValue[],
  ): T[] | Promise<T[]>
  transaction<T>(fn: () => T | Promise<T>): T | Promise<T>
  close(): void | Promise<void>
}
