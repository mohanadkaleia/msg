// worker/sqlite/node-driver.ts — the Node SqlDriver over better-sqlite3
// (ENG-165, M6-1). TEST/CLI-ONLY: better-sqlite3 is a native module and a
// devDependency; this file is imported ONLY from Node-side code (the vitest
// conformance suite). It is never reachable from the web app's entry graph, so
// `vite build` never bundles it (sqlite-db.ts loads it lazily via a dynamic
// import behind the string-path branch of `openSqliteDb`).
//
// better-sqlite3 is fully synchronous — the SqlDriver seam is async-COMPATIBLE
// (may return plain values), so this driver simply returns synchronously and
// SqliteDb's `await`s are no-ops. The Tauri driver (M6) is the async twin.

import Database from 'better-sqlite3'

import type { SqlDriver, SqlValue } from './driver'

export class NodeSqlDriver implements SqlDriver {
  private readonly db: Database.Database

  /** Open (or create) the SQLite file at `path` (`':memory:'` for ephemeral). */
  constructor(path: string) {
    this.db = new Database(path)
  }

  execute(sql: string, params: readonly SqlValue[] = []): void {
    const stmt = this.db.prepare(sql)
    // A row-returning statement (PRAGMA, `… RETURNING`) must be stepped with
    // .all() in better-sqlite3 (.run() throws on readers); rows are discarded.
    if (stmt.reader) {
      stmt.all(...params)
    } else {
      stmt.run(...params)
    }
  }

  select<T = Record<string, SqlValue>>(sql: string, params: readonly SqlValue[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  /**
   * FIFO queue serializing transactions on this connection — two concurrent
   * `transaction()` calls must never interleave (SQLite has ONE transaction per
   * connection; a nested BEGIN throws). Mirrors how Dexie queues `rw` txns.
   */
  private txTail: Promise<unknown> = Promise.resolve()

  transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    // Manual BEGIN/COMMIT rather than better-sqlite3's `.transaction()` wrapper:
    // the wrapper rejects async callbacks outright, while SqliteDb's callbacks
    // are async-shaped (they await driver calls). `fn` is AWAITED before the
    // COMMIT, so statements issued after its internal awaits (microtask
    // continuations) still land inside the BEGIN…COMMIT bracket; the queue
    // above keeps any concurrent transaction out of that window.
    const run = async (): Promise<T> => {
      this.db.exec('BEGIN')
      try {
        const result = await fn()
        this.db.exec('COMMIT')
        return result
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
    const next = this.txTail.then(run, run)
    this.txTail = next.catch(() => undefined)
    return next
  }

  close(): void {
    this.db.close()
  }
}
