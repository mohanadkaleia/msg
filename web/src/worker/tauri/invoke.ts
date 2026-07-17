// worker/tauri/invoke.ts — the one place the Tauri IPC bridge is imported
// (ENG-170, M6-5). Every Tauri driver calls the host through this indirection
// so tests can inject a fake and the import surface stays single-file.
//
// DESKTOP-ONLY, like sqlite/node-driver.ts: this module (and everything under
// worker/tauri/) is reachable ONLY through the dynamic `import('./tauri/boot')`
// in client.ts, which runs strictly behind the `__TAURI_INTERNALS__` runtime
// check — Vite emits it as a lazy chunk the browser never fetches.

import { invoke as tauriInvoke } from '@tauri-apps/api/core'

/** The invoke signature the drivers use (the `@tauri-apps/api` shape). */
export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

/** The real Tauri IPC bridge (indirected so tests can pass a fake). */
export const invoke: Invoke = (cmd, args) => tauriInvoke(cmd, args)
