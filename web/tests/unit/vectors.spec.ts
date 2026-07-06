// @vitest-environment node
//
// The load-bearing cross-language proof (ENG-76). This runner reads the ONE
// frozen file `server/msgd/core/testdata/vectors.json` — never a copy — and
// asserts the TypeScript JCS + hash port reproduces the Python reference
// byte-for-byte. If the two implementations disagree on a single byte, the
// "one protocol, two languages" claim fails here.
//
// Runs under the `node` environment (not the project-default jsdom) because
// jsdom does not expose `crypto.subtle`; Node provides the webcrypto global,
// plus `fs`, `Buffer`, and `TextEncoder`.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { canonicalize, MAX_DEPTH, parseJcsJson } from '../../src/core/jcs'
import { hashEvent } from '../../src/core/hashing'

// `../../../` climbs web/tests/unit → web/tests → web → repo root, then into
// server/…. Resolved via import.meta.url so it is cwd-independent (the `web` CI
// job runs from `working-directory: web` but does a full-repo checkout).
const vectorsPath = fileURLToPath(
  new URL('../../../server/msgd/core/testdata/vectors.json', import.meta.url),
)

if (!existsSync(vectorsPath)) {
  throw new Error(
    `Frozen vectors not found at ${vectorsPath}. The cross-language vector runner ` +
      `requires a full-repo checkout (server/ present alongside web/). If a CI change ` +
      `narrowed the web job to a sparse checkout of only web/, restore server/.`,
  )
}

interface ErrorCase {
  id: string
  desc: string
  input_json: string
  error: { kind: string; stage: string }
}

interface ValidCase {
  id: string
  desc: string
  input_json: string
  canonical_b64: string
  hash: string
}

type VectorCase = ValidCase | ErrorCase

interface VectorSuite {
  _meta: {
    max_depth: number
    int_interop_cap: [number, number]
  }
  cases: VectorCase[]
}

const suite = JSON.parse(readFileSync(vectorsPath, 'utf8')) as VectorSuite

function isErrorCase(c: VectorCase): c is ErrorCase {
  return 'error' in c
}

describe('cross-language JCS + hash vectors (frozen)', () => {
  it('has a non-trivial number of cases', () => {
    expect(suite.cases.length).toBeGreaterThan(40)
  })

  it('agrees with the frozen protocol constants (guards against TS drift)', () => {
    expect(suite._meta.max_depth).toBe(MAX_DEPTH)
    expect(suite._meta.int_interop_cap).toEqual([-9007199254740991, 9007199254740991])
  })

  for (const c of suite.cases) {
    if (isErrorCase(c)) {
      it(`rejects: ${c.id} (${c.error.kind})`, async () => {
        // Stage-agnostic per _meta: some rejects fire at parse (NaN at
        // JSON.parse, over-cap integers at the reviver), others at canonicalize
        // (surrogates, depth). The whole parse → canonicalize → hash pipeline
        // must produce no hash.
        await expect(
          (async () => {
            await hashEvent(parseJcsJson(c.input_json))
          })(),
        ).rejects.toThrow()
      })
    } else {
      it(`canonicalizes + hashes: ${c.id}`, async () => {
        const value = parseJcsJson(c.input_json)
        // Byte-for-byte on the canonicalization (isolates JCS bugs from hash bugs).
        expect(Buffer.from(canonicalize(value)).toString('base64')).toBe(c.canonical_b64)
        expect(await hashEvent(value)).toBe(c.hash)
      })
    }
  }

  it('pins the §2.1 anchor hash independently of the frozen file', async () => {
    const anchor = suite.cases.find((c): c is ValidCase => c.id === 'tdd-2.1-example')
    expect(anchor).toBeDefined()
    expect(await hashEvent(parseJcsJson(anchor!.input_json))).toBe(
      'sha256:49d43880190e9b17c2b4eb5cd4fbe39c972ba0d214b3f751d6033cb0fd707e51',
    )
  })
})
