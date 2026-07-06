// Playwright global setup (ENG-83): boot the real msgd server harness
// (serverctl.py — Postgres testcontainer + subprocess uvicorn on the true ASGI
// app) and wait until it is healthy. The spawned process group id is stashed on
// disk so global-teardown can kill the whole tree.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const READY_FILE = resolve(HERE, '.server-ready')
const PGID_FILE = resolve(HERE, '.server-pgid')
const LOG_FILE = resolve(HERE, '.server.log')

async function waitReady(timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(READY_FILE)) return readFileSync(READY_FILE, 'utf-8').trim()
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`msgd server harness not ready after ${timeoutMs}ms — see ${LOG_FILE}`)
}

const WEB_DIR = resolve(HERE, '../..')

export default async function globalSetup(): Promise<void> {
  rmSync(READY_FILE, { force: true })

  // Build the SPA the server will serve (production topology: msgd serves
  // web/dist same-origin, so there is no proxy and the WS bearer handshake
  // reaches the server). Must finish BEFORE serverctl boots so the mount picks
  // up a fresh dist.
  const build = spawnSync('pnpm', ['build'], { cwd: WEB_DIR, stdio: 'inherit' })
  if (build.status !== 0) throw new Error('pnpm build failed for the e2e golden path')

  // Detached so the child leads its own process group; teardown kills -pgid so
  // the `uv run` wrapper, python, uvicorn, and the container all go down.
  const child = spawn('uv', ['run', 'python', 'web/tests/e2e/serverctl.py'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, MSGD_E2E_PORT: process.env.MSGD_E2E_PORT ?? '8099' },
  })
  child.unref()
  if (child.pid) writeFileSync(PGID_FILE, String(child.pid), 'utf-8')

  const baseUrl = await waitReady()
  // Hand the resolved base URL to the tests (baseURL) via env.
  process.env.MSG_E2E_BASE_URL = baseUrl
  console.log(`[e2e] msgd server (SPA + API + WS) ready at ${baseUrl}`)
}
