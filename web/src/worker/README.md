# src/worker — SharedWorker sync engine (ENG-77)

Documented seam. This directory holds the single WebSocket owned by a
`SharedWorker` and shared across tabs: the socket, the Dexie/IndexedDB cache,
the sync engine, and the outbox (TDD §5.1/§5.3).

Vite is already configured for it — `worker: { format: 'es' }` in
`vite.config.ts` and `"WebWorker"` in the `tsconfig.app.json` `lib` array — so
`new SharedWorker(new URL('./worker/…', import.meta.url), { type: 'module' })`
compiles and bundles once the code lands. No worker file ships at ENG-75.

Empty by design at ENG-75 (scaffold). ENG-77 fills it.
