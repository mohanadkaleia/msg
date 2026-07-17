// worker/tauri/sql-driver.ts — the Tauri SqlDriver (ENG-170, M6-5): the async
// twin of sqlite/node-driver.ts, speaking to the Rust `sql_*` commands
// (desktop/src-tauri/src/sqlite.rs) over IPC. The Rust side holds one pooled
// rusqlite connection per db path — the per-workspace `projections.sqlite3` —
// built with the BUNDLED modern SQLite, so FTS5 (M6-2) is guaranteed.

import type { SqlDriver, SqlValue } from '../sqlite/driver'

import { invoke as defaultInvoke, type Invoke } from './invoke'

/** JSON-encode params for IPC: a Uint8Array crosses as a plain byte array. */
function encodeParams(params: readonly SqlValue[]): unknown[] {
  return params.map((p) => (p instanceof Uint8Array ? Array.from(p) : p))
}

/** Decode a selected value: a BLOB arrives as a byte array → Uint8Array. */
function decodeValue(v: unknown): SqlValue {
  if (Array.isArray(v)) return new Uint8Array(v as number[])
  return v as SqlValue
}

function decodeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, SqlValue> = {}
  for (const [k, v] of Object.entries(row)) out[k] = decodeValue(v)
  return out as T
}

export class TauriSqlDriver implements SqlDriver {
  private constructor(
    private readonly path: string,
    private readonly invoke: Invoke,
  ) {}

  /** Open (or reuse) the host's pooled connection for the SQLite file at `path`. */
  static async open(path: string, invoke: Invoke = defaultInvoke): Promise<TauriSqlDriver> {
    await invoke('sql_open', { path })
    return new TauriSqlDriver(path, invoke)
  }

  async execute(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    await this.invoke('sql_execute', {
      path: this.path,
      sql,
      params: encodeParams(params),
    })
  }

  async select<T = Record<string, SqlValue>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    const rows = await this.invoke<Record<string, unknown>[]>('sql_select', {
      path: this.path,
      sql,
      params: encodeParams(params),
    })
    return rows.map((r) => decodeRow<T>(r))
  }

  /**
   * FIFO queue serializing transactions on this connection (the NodeSqlDriver
   * discipline — SQLite has ONE transaction per connection). The callback
   * shape cannot cross IPC, so the bracket is BEGIN…COMMIT via `sql_execute`
   * on the host's single pooled connection; `fn` is awaited before COMMIT so
   * its microtask continuations land inside the bracket, and the queue keeps
   * any concurrent transaction out of that window.
   */
  private txTail: Promise<unknown> = Promise.resolve()

  transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.execute('BEGIN')
      try {
        const result = await fn()
        await this.execute('COMMIT')
        return result
      } catch (err) {
        await this.execute('ROLLBACK')
        throw err
      }
    }
    const next = this.txTail.then(run, run)
    this.txTail = next.catch(() => undefined)
    return next
  }

  async close(): Promise<void> {
    await this.invoke('sql_close', { path: this.path })
  }
}
