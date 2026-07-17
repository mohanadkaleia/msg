// worker/tauri/fs.ts — the Tauri implementations of the M6-3 disk seams
// (ENG-170, M6-5): TauriEventLog, TauriBlobCache, TauriManifestStore — the
// desktop twins of mirror/node-fs.ts, delegating the actual fs + durability
// discipline (O_APPEND + fsync, dir-fsync on create, temp+rename manifests,
// content-verified blobs) to the Rust commands in desktop/src-tauri/src/.
//
// The same fail-closed path guards node-fs applies are re-checked here
// (defense-in-depth) AND enforced again on the Rust side — three layers with
// the WorkspaceMirror trust boundary.

import type { BlobCache, EventLog, ManifestStore, WorkspaceManifest } from '../mirror/seams'

import { invoke as defaultInvoke, type Invoke } from './invoke'

/** The month-partition shape — defensively re-checked before IPC. */
const MONTH_RE = /^\d{4}-\d{2}$/
/** A conservative safe-path-component shape (typed ULIDs satisfy it). */
const SAFE_COMPONENT_RE = /^[A-Za-z0-9_-]+$/
/** A content-addressed blob key: bare 64-char lowercase hex. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

function guardComponent(value: string, what: string): string {
  if (!SAFE_COMPONENT_RE.test(value)) {
    throw new Error(`tauri-fs: refusing an unsafe ${what} path component`)
  }
  return value
}

/**
 * The Tauri {@link EventLog}: `<root>/streams/<streamId>/<month>.ndjson` via
 * `ndjson_*` (append-only, fsync'd, torn-tail-repairing — see ndjson.rs).
 */
export class TauriEventLog implements EventLog {
  constructor(
    private readonly root: string,
    private readonly invoke: Invoke = defaultInvoke,
  ) {}

  async append(streamId: string, month: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return
    guardComponent(streamId, 'stream_id')
    if (!MONTH_RE.test(month)) throw new Error('tauri-fs: refusing a malformed month partition')
    for (const line of lines) {
      if (!line.endsWith('\n') || line.indexOf('\n') !== line.length - 1) {
        throw new Error('tauri-fs: append expects single newline-terminated NDJSON lines')
      }
    }
    await this.invoke('ndjson_append', {
      root: this.root,
      streamId,
      month,
      lines: [...lines],
    })
  }

  async listMonths(streamId: string): Promise<string[]> {
    guardComponent(streamId, 'stream_id')
    return this.invoke('ndjson_list_months', { root: this.root, streamId })
  }

  async readAll(streamId: string): Promise<string[]> {
    guardComponent(streamId, 'stream_id')
    return this.invoke('ndjson_read_all', { root: this.root, streamId })
  }

  listStreams(): Promise<string[]> {
    return this.invoke('ndjson_list_streams', { root: this.root })
  }
}

/**
 * The Tauri {@link BlobCache}: `<root>/blobs/<ab>/<sha256hex>` via `blob_*`
 * (atomic, idempotent, content re-verified host-side on put).
 */
export class TauriBlobCache implements BlobCache {
  constructor(
    private readonly root: string,
    private readonly invoke: Invoke = defaultInvoke,
  ) {}

  private guardKey(sha256: string): string {
    if (!SHA256_HEX_RE.test(sha256)) {
      throw new Error('tauri-fs: refusing a malformed blob key (want bare sha256 hex)')
    }
    return sha256
  }

  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    await this.invoke('blob_put', {
      root: this.root,
      sha256: this.guardKey(sha256),
      bytes: Array.from(bytes),
    })
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    const bytes = await this.invoke<number[] | null>('blob_get', {
      root: this.root,
      sha256: this.guardKey(sha256),
    })
    return bytes === null ? null : new Uint8Array(bytes)
  }

  async has(sha256: string): Promise<boolean> {
    return this.invoke('blob_has', { root: this.root, sha256: this.guardKey(sha256) })
  }
}

/**
 * The Tauri {@link ManifestStore}: atomic + durable `<root>/workspace.json`
 * via `manifest_*` (temp → fsync → rename → dir fsync, host-side).
 */
export class TauriManifestStore implements ManifestStore {
  constructor(
    private readonly root: string,
    private readonly invoke: Invoke = defaultInvoke,
  ) {}

  async read(): Promise<WorkspaceManifest | null> {
    const text = await this.invoke<string | null>('manifest_read', { root: this.root })
    return text === null ? null : (JSON.parse(text) as WorkspaceManifest)
  }

  async write(manifest: WorkspaceManifest): Promise<void> {
    // Match msgctl's on-disk style (indent=2 + trailing newline) — not
    // byte-load-bearing (verify only parses it), but keeps the trees diffable
    // (the node-fs NodeManifestStore emits the identical bytes).
    const json = JSON.stringify(manifest, null, 2) + '\n'
    await this.invoke('manifest_write', { root: this.root, json })
  }
}
