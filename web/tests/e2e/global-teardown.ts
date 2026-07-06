// Playwright global teardown (ENG-83): kill the msgd server harness process
// group started by global-setup, so Postgres + uvicorn are cleaned up.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PGID_FILE = resolve(HERE, '.server-pgid')
const READY_FILE = resolve(HERE, '.server-ready')

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(PGID_FILE)) return
  const pid = Number(readFileSync(PGID_FILE, 'utf-8').trim())
  try {
    // Negative pid → the whole process group (detached leader in global-setup).
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  // Give the container teardown a moment before Playwright exits.
  await new Promise((r) => setTimeout(r, 3000))
  rmSync(PGID_FILE, { force: true })
  rmSync(READY_FILE, { force: true })
}
