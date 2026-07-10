// worker/mirror/node-fs.ts — the Node-fs implementations of the M6-3 disk
// seams (ENG-167): NodeEventLog, NodeBlobCache, NodeManifestStore.
//
// TEST/DESKTOP-ONLY, like sqlite/node-driver.ts: this module imports `node:*`
// builtins and is imported ONLY from Node-side code (the vitest suites and,
// until M6-5 swaps in the Tauri/Rust twins, a headless desktop harness). It is
// never reachable from the web app's entry graph, so `vite build` never sees
// it. Durability discipline mirrors msgctl (cli/msgctl/{sync,workspace}.py):
// O_APPEND + fsync for log pages, parent-dir fsync on file/dir creation, and
// temp-file → fsync → rename → dir-fsync for the manifest.

import { createHash } from 'node:crypto'
import { constants as fsConstants, type Dirent } from 'node:fs'
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

import type { BlobCache, EventLog, ManifestStore, WorkspaceManifest } from './seams'

/** The month-partition shape — defensively re-checked at the fs boundary. */
const MONTH_RE = /^\d{4}-\d{2}$/
/** A conservative safe-path-component shape (typed ULIDs satisfy it). */
const SAFE_COMPONENT_RE = /^[A-Za-z0-9_-]+$/
/** A content-addressed blob key: bare 64-char lowercase hex. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/** Defense-in-depth: refuse any path component the mirror should never mint. */
function guardComponent(value: string, what: string): string {
  if (!SAFE_COMPONENT_RE.test(value)) {
    throw new Error(`node-fs: refusing an unsafe ${what} path component`)
  }
  return value
}

/**
 * fsync a directory so a just-created/renamed dirent survives power loss —
 * the msgctl `_fsync_dir` twin (file-data fsync alone does not make a NEW
 * file's directory entry durable).
 */
async function fsyncDir(path: string): Promise<void> {
  const fh = await open(path, 'r')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The Node-fs {@link EventLog}: `<root>/streams/<streamId>/<month>.ndjson`,
 * append-only with O_APPEND + fsync, parent-dir fsync on creation, and
 * torn-trailing-line repair on first open per stream (the msgctl
 * `_scan_stream` scan-on-open — an interrupted append's partial line is
 * truncated away before anything is read or appended after it, so a crash
 * mid-write can never corrupt a later line).
 */
export class NodeEventLog implements EventLog {
  private readonly streamsDir: string
  /** Streams whose torn-tail scan already ran this process. */
  private readonly scanned = new Set<string>()

  constructor(private readonly root: string) {
    this.streamsDir = join(root, 'streams')
  }

  async append(streamId: string, month: string, lines: readonly string[]): Promise<void> {
    if (lines.length === 0) return
    guardComponent(streamId, 'stream_id')
    if (!MONTH_RE.test(month)) throw new Error('node-fs: refusing a malformed month partition')
    for (const line of lines) {
      // Each entry must be exactly one newline-terminated NDJSON line.
      if (!line.endsWith('\n') || line.indexOf('\n') !== line.length - 1) {
        throw new Error('node-fs: append expects single newline-terminated NDJSON lines')
      }
    }
    const dir = join(this.streamsDir, streamId)
    const created = await mkdir(dir, { recursive: true })
    if (created !== undefined) {
      // A new stream (or streams/) dirent — make the directory chain durable.
      await fsyncDir(this.streamsDir)
      await fsyncDir(this.root)
    }
    await this.repairTornTail(streamId)
    const path = join(dir, `${month}.ndjson`)
    const isNew = !(await exists(path))
    const fh = await open(path, 'a') // O_APPEND | O_CREAT
    try {
      await fh.write(new TextEncoder().encode(lines.join('')))
      await fh.sync()
    } finally {
      await fh.close()
    }
    if (isNew) await fsyncDir(dir)
  }

  async listMonths(streamId: string): Promise<string[]> {
    guardComponent(streamId, 'stream_id')
    const dir = join(this.streamsDir, streamId)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }
    return entries
      .filter((name) => name.endsWith('.ndjson'))
      .map((name) => name.slice(0, -'.ndjson'.length))
      .sort()
  }

  async readAll(streamId: string): Promise<string[]> {
    guardComponent(streamId, 'stream_id')
    await this.repairTornTail(streamId)
    const months = await this.listMonths(streamId)
    const lines: string[] = []
    for (const month of months) {
      const text = await readFile(join(this.streamsDir, streamId, `${month}.ndjson`), 'utf8')
      for (const line of text.split('\n')) {
        if (line.length > 0) lines.push(line)
      }
    }
    return lines
  }

  async listStreams(): Promise<string[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.streamsDir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  }

  /**
   * Repair a torn trailing line in the stream's LAST month file (only the most
   * recently appended file can carry one): truncate to the final `\n`, fsync.
   * Runs once per stream per process, before any read or append.
   */
  private async repairTornTail(streamId: string): Promise<void> {
    if (this.scanned.has(streamId)) return
    this.scanned.add(streamId)
    const months = await this.listMonths(streamId)
    const last = months[months.length - 1]
    if (last === undefined) return
    const path = join(this.streamsDir, streamId, `${last}.ndjson`)
    const bytes = await readFile(path)
    if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return
    const lastNl = bytes.lastIndexOf(0x0a)
    const fh = await open(path, 'r+')
    try {
      await fh.truncate(lastNl + 1) // lastNl === -1 → truncate to 0 (all torn)
      await fh.sync()
    } finally {
      await fh.close()
    }
  }
}

/**
 * The Node-fs {@link BlobCache}: `<root>/blobs/<ab>/<sha256hex>`, atomic
 * temp-file + rename puts, content re-verified on `put` (never store bytes
 * that do not hash to their key — the store must stay verify-green).
 */
export class NodeBlobCache implements BlobCache {
  private readonly blobsDir: string

  constructor(root: string) {
    this.blobsDir = join(root, 'blobs')
  }

  private pathFor(sha256: string): string {
    if (!SHA256_HEX_RE.test(sha256)) {
      throw new Error('node-fs: refusing a malformed blob key (want bare sha256 hex)')
    }
    return join(this.blobsDir, sha256.slice(0, 2), sha256)
  }

  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(sha256)
    if (await exists(path)) return // content-addressed — idempotent
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== sha256) {
      throw new Error('node-fs: blob bytes do not hash to their key; refusing to store')
    }
    const dir = dirname(path)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.tmp.${process.pid}.${sha256}`)
    await writeFile(tmp, bytes, { flush: true })
    try {
      await rename(tmp, path)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
    await fsyncDir(dir)
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.pathFor(sha256))
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch {
      return null
    }
  }

  async has(sha256: string): Promise<boolean> {
    try {
      await stat(this.pathFor(sha256))
      return true
    } catch {
      return false
    }
  }
}

/**
 * The Node-fs {@link ManifestStore}: atomic + durable `workspace.json` writes
 * (temp in root → fsync → rename → root fsync), the msgctl `write_manifest`
 * discipline — a crash mid-write leaves the prior manifest intact.
 */
export class NodeManifestStore implements ManifestStore {
  constructor(private readonly root: string) {}

  private get path(): string {
    return join(this.root, 'workspace.json')
  }

  async read(): Promise<WorkspaceManifest | null> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return null
    }
    return JSON.parse(text) as WorkspaceManifest
  }

  async write(manifest: WorkspaceManifest): Promise<void> {
    await mkdir(this.root, { recursive: true })
    // Match msgctl's on-disk style (indent=2 + trailing newline) — not
    // byte-load-bearing (verify only parses it), but keeps the trees diffable.
    const payload = JSON.stringify(manifest, null, 2) + '\n'
    const tmp = join(this.root, `.workspace.json.tmp.${process.pid}`)
    await writeFile(tmp, payload, { encoding: 'utf8', flush: true })
    try {
      await rename(tmp, this.path)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
    await fsyncDir(this.root)
  }
}
