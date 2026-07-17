// worker/tauri/detect.ts — the ONE Tauri runtime check (ENG-170, M6-5).
//
// Deliberately free of any `@tauri-apps/*` import so it is safe to import
// STATICALLY from web-bundle code (client.ts, the router): the check is a
// plain global probe, and everything Tauri-flavored stays behind the dynamic
// `import('./boot')` that only runs when this returns true.

/** True inside a Tauri webview (`window.__TAURI_INTERNALS__` injected by the shell). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
