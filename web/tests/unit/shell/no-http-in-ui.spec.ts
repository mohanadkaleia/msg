import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The shell is a DUMB view over the worker RPC (ENG-82 constraint): it reads only
// through the WorkerClient and NEVER the HTTP API for message data; the session
// token lives worker-side and is unreachable from a tab. This test gives that
// invariant teeth — it greps every UI source file (components, shell views,
// stores, composables) for any HTTP-client import, raw fetch, or token reference.

// Vitest runs with the `web/` package root as cwd (single vite.config.ts).
const SRC = resolve(process.cwd(), 'src')

const UI_DIRS = ['components', 'stores', 'composables']
const UI_FILES = [`${SRC}/views/ShellView.vue`]

/** Recursively collect .ts/.vue files under a directory. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(full)
  }
  return out
}

function uiSourceFiles(): string[] {
  const files = [...UI_FILES]
  for (const d of UI_DIRS) files.push(...walk(`${SRC}/${d}`))
  return files
}

// Forbidden surfaces: the worker HTTP client, a raw fetch, or anything token-ish.
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /worker\/http/, why: 'imports the worker HTTP client' },
  { pattern: /createHttpClient/, why: 'constructs an HTTP client' },
  { pattern: /\bfetch\s*\(/, why: 'calls fetch() directly' },
  { pattern: /session_token|META_SESSION_TOKEN/, why: 'references the session token' },
  { pattern: /getToken/, why: 'reaches for the worker token' },
  { pattern: /\/v1\//, why: 'hits an HTTP API path directly' },
]

describe('shell UI never touches HTTP or the token', () => {
  it('has no forbidden import / fetch / token reference in any UI source', () => {
    const violations: string[] = []
    for (const file of uiSourceFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text)) violations.push(`${file}: ${why} (${String(pattern)})`)
      }
    }
    expect(violations).toEqual([])
  })
})
