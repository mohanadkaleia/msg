// worker/mirror/seams.ts — the M6-3 (ENG-167) disk seams: the interfaces the
// WorkspaceMirror writes the on-disk NDJSON workspace through.
//
// Pure types, no platform globals — importable from the worker bundle. The
// CONCRETE implementations are platform modules kept OUT of the web entry
// graph: `node-fs.ts` (Node fs, tests + headless desktop CI) today, and the
// Tauri/Rust twins in M6-5. Everything is injected, so the mirror itself is
// pure TS and unit-testable with in-memory fakes.
//
// The on-disk layout these seams realize is EXACTLY the `msgctl` workspace
// (cli/msgctl/workspace.py):
//
//   <root>/
//     workspace.json            # manifest + stream registry (ManifestStore)
//     streams/<stream_id>/<YYYY-MM>.ndjson   # month-partitioned log (EventLog)
//     blobs/<ab>/<sha256hex>    # content-addressed blob cache (BlobCache)
//
// …which is what `msgctl verify <root>` re-proves (hash faithfulness +
// gapless-from-1 sequences + registry↔dirs cross-checks).

/** One registered stream in the `workspace.json` manifest (msgctl `StreamInfo`). */
export interface ManifestStreamEntry {
  name: string
  kind: string
  created_at: string
}

/**
 * The `workspace.json` manifest — the TS twin of msgctl's `Workspace.to_manifest`
 * (cli/msgctl/workspace.py). Key names are LOAD-BEARING: `msgctl verify` opens
 * the manifest via `Workspace.open`, which requires `workspace_id`,
 * `local_author.user_id`, `local_author.device_id` and a `streams` object with
 * UNIQUE `name`s — a missing key or duplicate name is a `manifest_invalid`
 * FAILURE (exit 1).
 */
export interface WorkspaceManifest {
  format_version: number
  workspace_id: string
  name: string
  created_at: string
  local_author: { user_id: string; device_id: string }
  streams: Record<string, ManifestStreamEntry>
}

/**
 * The durable NDJSON event log under `<root>/streams/` (M6-3). The desktop
 * analogue of msgctl `sync._write_page`'s target.
 *
 * Contract (what implementations must guarantee):
 *  - `append` writes the given COMPLETE, newline-terminated NDJSON lines to
 *    `<root>/streams/<streamId>/<month>.ndjson` in order, append-only, and
 *    returns only once the bytes are DURABLE (fsync; plus a parent-directory
 *    fsync when the file or stream dir was just created, so a crash cannot
 *    vanish an acked line with its dirent).
 *  - `readAll` returns every line of every month file of the stream, month
 *    files in lexical (== chronological) order, WITHOUT the trailing newline,
 *    with a torn trailing line (an interrupted append) repaired/ignored — the
 *    twin of msgctl's scan-on-open (`_resume_seq`).
 *  - `listMonths` returns the stream's month names (no `.ndjson` suffix),
 *    sorted; `listStreams` the stream dirs present on disk (rebuild-from-disk
 *    enumeration).
 *
 * Path-component safety is enforced at the WorkspaceMirror trust boundary
 * (typed-ULID stream ids, `^\d{4}-\d{2}$` months) AND defensively re-checked by
 * implementations.
 */
export interface EventLog {
  append(streamId: string, month: string, lines: readonly string[]): Promise<void>
  listMonths(streamId: string): Promise<string[]>
  readAll(streamId: string): Promise<string[]>
  listStreams(): Promise<string[]>
}

/**
 * Content-addressed blob cache under `<root>/blobs/<ab>/<sha256hex>` (M6-3) —
 * the offline file store, mirroring the server BlobStore / §9 bundle layout.
 * Keys are BARE 64-char lowercase-hex sha256 (never the `sha256:`-prefixed
 * event-hash form). `put` must be atomic (temp + rename) and idempotent.
 */
export interface BlobCache {
  put(sha256: string, bytes: Uint8Array): Promise<void>
  get(sha256: string): Promise<Uint8Array | null>
  has(sha256: string): Promise<boolean>
}

/**
 * Atomic reader/writer for `<root>/workspace.json` (M6-3). `write` must be
 * atomic + durable (temp file → fsync → rename → dir fsync, msgctl
 * `write_manifest` discipline) so a crash mid-registration leaves the prior
 * manifest intact — never a torn one. `read` returns `null` when absent.
 */
export interface ManifestStore {
  read(): Promise<WorkspaceManifest | null>
  write(manifest: WorkspaceManifest): Promise<void>
}
