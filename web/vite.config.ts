/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// Single source of build + test config (D-3): the Vitest `test` block lives
// inline here so there is no second config to drift from the build pipeline.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // ENG-77 ships a SharedWorker (`new SharedWorker(new URL('./worker/…',
  // import.meta.url), { type: 'module' })`). Configuring the ES worker format
  // now means that lands as a build-only change with no config churn.
  worker: {
    format: 'es',
  },
  // Single-origin in dev (D-4, §5.1): Vite hosts the SPA and proxies the API to
  // uvicorn (:8080). The `ws` rule is declared BEFORE the plain `/v1` rule so
  // WebSocket upgrades (`/v1/ws`) route to the ws target, not the http one.
  server: {
    proxy: {
      '/v1/ws': { target: 'ws://localhost:8080', ws: true },
      '/v1': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // tests/integration holds the M6-3 headless workspace-mirror gate (ENG-167):
    // Node-environment specs that drive the real SyncEngine/WorkerCore against a
    // temp dir and spawn `msgctl verify` (needs `uv`; the spec self-skips where
    // uv is absent and HARD-FAILS under CI so the gate cannot silently vanish —
    // see tests/integration/m6-workspace-mirror.spec.ts).
    include: ['tests/unit/**/*.spec.ts', 'tests/integration/**/*.spec.ts'],
  },
})
