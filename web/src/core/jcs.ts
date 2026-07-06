/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) for msg — the browser port.
 *
 * This is the TypeScript mirror of `server/msgd/core/jcs.py`. It produces the
 * canonical-JSON *byte* layer that `event_hash` (`sha256:` over these bytes,
 * ENG-56) is computed against. Decision D1 fixes the scheme as RFC 8785 (JCS);
 * TDD §2.1 pins `event_hash` = SHA-256 over the JCS canonicalization of the
 * event `body` only. This module returns bytes and nothing else — hashing lives
 * in `hashing.ts`.
 *
 * Hand-port, not a library (the inverse of the Python decision)
 * ------------------------------------------------------------
 * `jcs.py` vendors the `rfc8785` package *because ES6 `Number::toString` float
 * formatting is the risky ~80%* of a correct JCS implementation. In JavaScript
 * that 80% is free and native: `String(n)` for finite numbers *is* ES6
 * `Number::toString` (verified against every frozen number vector — `1e30`
 * → `"1e+30"`, `1e21` → `"1e+21"`, `9.999e22` → `"9.999e+22"`, `5e-324`,
 * `-0` → `"0"`, `2.0` → `"2"`), and `Array.prototype.sort` already compares
 * strings by UTF-16 code unit (the exact JCS key order, astral surrogates
 * included). So a library would buy us *nothing* the platform doesn't give us,
 * while still forcing us to hand-write every msg-specific domain rule it does
 * not enforce — MAX_DEPTH=128, the ±(2^53−1) integer cap, NaN/Infinity
 * rejection, lone-surrogate rejection. Wrapping a dependency would be strictly
 * more surface (supply chain + our own checks) than the ~70-line canonicalizer
 * here. Hence: hand-port.
 *
 * Pinned semantics (locked by the frozen vectors in
 * `server/msgd/core/testdata/vectors.json`, byte-for-byte with the Python impl)
 * -----------------------------------------------------------------------------
 * - Input domain: object / array / string / number / boolean / null only, with
 *   string object keys. Anything else (`undefined`, `bigint`, `symbol`,
 *   `function`, `Date`, class instances) raises {@link JCSError}.
 * - Numbers serialize per ES6 `Number::toString` via `String(n)`; `-0` → `0`.
 * - NaN / Infinity are rejected.
 * - Integer interop cap `[-(2^53)+1, 2^53-1]` is enforced at *parse* time in
 *   {@link parseJcsJson} (see below), not here — JS erases the int-vs-float
 *   distinction and truncates ≥2^53 after parse, so the source literal is the
 *   only place the cap is enforceable.
 * - Strings are emitted as UTF-8 bytes with RFC 8785 §3.2.2.2 escaping;
 *   `0x7f` (DEL) is NOT escaped; no NFC normalization (D1 — client's job).
 * - Container nesting deeper than {@link MAX_DEPTH} (128) is rejected via an
 *   iterative pre-pass that runs before the recursive serializer, so a
 *   pathological 2000-deep input rejects cleanly with no stack overflow.
 */

/** Any value expressible in JSON. `string` is a scalar, never a char sequence. */
export type JSONValue =
  { [key: string]: JSONValue } | JSONValue[] | string | number | boolean | null

/**
 * Maximum container nesting depth accepted by {@link canonicalize}. Protocol
 * constant (D1): the Python impl enforces the same value and ENG-56 freezes it
 * alongside the hash vectors. Depth counts container levels only — a scalar is
 * depth 0, `{}`/`[]` is 1, the §2.1 example body is 3.
 */
export const MAX_DEPTH = 128

/** The ±(2^53−1) integer interop cap (RFC 8785), enforced in {@link parseJcsJson}. */
const INT_INTEROP_MAX = 9007199254740991n
const INT_INTEROP_MIN = -9007199254740991n

/**
 * Input cannot be RFC 8785 canonicalized: out-of-domain value, non-finite
 * number, over-cap integer, non-string / lone-surrogate key, lone-surrogate
 * string value, or nesting deeper than {@link MAX_DEPTH}. Mirrors
 * `msgd.core.jcs.JCSError`.
 */
export class JCSError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JCSError'
  }
}

/**
 * True iff `str` contains no lone surrogates (ES2024 `String.prototype.isWellFormed`).
 * Neither `JSON.parse` nor `TextEncoder` rejects lone surrogates — `JSON.parse`
 * happily produces them and `TextEncoder` silently substitutes U+FFFD — so this
 * explicit check is the only thing that rejects `reject-surrogate-*`. Typed via
 * a local cast because the project's `lib` target (ES2022) predates the method.
 */
function isWellFormed(str: string): boolean {
  return (str as unknown as { isWellFormed(): boolean }).isWellFormed()
}

/** RFC 8785 §3.2.2.2 two-char escapes, keyed by code unit. */
const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
}

/** Escape a string per RFC 8785 §3.2.2.2, rejecting lone surrogates. */
function serializeString(str: string): string {
  if (!isWellFormed(str)) {
    throw new JCSError('string contains a lone surrogate')
  }
  let out = '"'
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    const short = SHORT_ESCAPES[code]
    if (short !== undefined) {
      out += short
    } else if (code < 0x20) {
      // Other control chars → lowercase \u00XX. Everything else (including
      // 0x7f and all non-ASCII) is emitted raw; TextEncoder handles UTF-8.
      out += '\\u' + code.toString(16).padStart(4, '0')
    } else {
      out += str.charAt(i)
    }
  }
  return out + '"'
}

/** Recursive value → canonical-JSON string serializer (keys sorted, arrays not). */
function serializeValue(value: JSONValue): string {
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JCSError('number is not finite')
    }
    // String(n) === ES6 Number::toString; String(-0) === "0".
    return String(value)
  }
  if (typeof value === 'string') {
    return serializeString(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(serializeValue).join(',') + ']'
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new JCSError('unsupported object type (only plain objects are canonicalizable)')
    }
    // `value` is now narrowed to the object member of JSONValue.
    const record = value
    // Array default sort compares by UTF-16 code unit — exactly JCS key order.
    const keys = Object.keys(record).sort()
    const parts: string[] = []
    for (const key of keys) {
      const child = record[key]
      // `child` is always present (key came from Object.keys); the guard only
      // satisfies noUncheckedIndexedAccess without an assertion.
      if (child === undefined) {
        continue
      }
      parts.push(serializeString(key) + ':' + serializeValue(child))
    }
    return '{' + parts.join(',') + '}'
  }
  throw new JCSError(`unsupported value of type ${typeof value}`)
}

/**
 * Reject nesting deeper than {@link MAX_DEPTH}. Iterative worklist, never
 * recursive — the guard itself must be immune to the stack exhaustion it guards
 * against — and called *before* the recursive serializer so a 2000-deep input
 * rejects cleanly with no `RangeError`. Descends only into object values and
 * array items; scalars are not iterated. Mirrors `jcs.py::_check_depth`.
 */
function checkDepth(value: JSONValue): void {
  const stack: Array<[JSONValue, number]> = [[value, 0]]
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined) {
      break
    }
    const [current, depth] = item
    if (Array.isArray(current)) {
      if (depth + 1 > MAX_DEPTH) {
        throw new JCSError(`nesting depth exceeds ${MAX_DEPTH}`)
      }
      for (const child of current) {
        stack.push([child, depth + 1])
      }
    } else if (current !== null && typeof current === 'object') {
      if (depth + 1 > MAX_DEPTH) {
        throw new JCSError(`nesting depth exceeds ${MAX_DEPTH}`)
      }
      for (const child of Object.values(current)) {
        stack.push([child, depth + 1])
      }
    }
  }
}

/**
 * Return the RFC 8785 (JCS) canonicalization of `value` as UTF-8 bytes.
 *
 * The production caller passes the event `body`. Output is deterministic and
 * suitable for hashing. The ±(2^53−1) integer cap is NOT checked here — it is a
 * parse-time rule ({@link parseJcsJson}); `canonicalize` only guards
 * `Number.isFinite` (defense for programmatically constructed values).
 *
 * @throws {JCSError} out-of-domain value, non-finite number, non-plain object,
 *   lone-surrogate key/value, or nesting deeper than {@link MAX_DEPTH}.
 */
export function canonicalize(value: JSONValue): Uint8Array {
  checkDepth(value)
  return new TextEncoder().encode(serializeValue(value))
}

/**
 * Enforce the ±(2^53−1) integer interop cap for one parsed number, given the
 * raw source literal that produced it (`undefined` when the runtime does not
 * expose JSON.parse source-text access).
 *
 * Fails CLOSED: if `value` is a number but no `source` is available, the cap
 * cannot be enforced (we can neither tell an over-cap integer literal from an
 * accepted float, nor recover the pre-truncation digits that `JSON.parse` loses
 * for magnitudes ≥2^53), so we throw rather than silently accept a value that
 * would hash differently from the Python reference. The accept/reject boundary
 * must not depend on the engine — the same engine-independence discipline as
 * {@link MAX_DEPTH}. Target runtimes (Node 22 CI, evergreen browsers) all have
 * source access; a runtime that lacks it cannot safely participate in the
 * byte-for-byte hash contract, so refusing is the correct posture.
 *
 * Exported for the fail-closed unit test; NOT part of the module's public API
 * (not re-exported from the barrel).
 *
 * @internal
 * @throws {JCSError} if `value` is a number with no source (unsupported runtime)
 *   or an integer-form literal outside `[-(2^53)+1, 2^53-1]`.
 */
export function enforceIntegerCap(value: unknown, source: string | undefined): void {
  if (typeof value !== 'number') {
    return
  }
  if (source === undefined) {
    throw new JCSError(
      'unsupported runtime: JSON.parse source-text access is required to enforce the integer interop cap',
    )
  }
  // Integer-form literals (`/^-?\d+$/`, no `.`/`e`/`E`) are capped on the
  // pre-truncation source via BigInt; exponential/fractional forms pass
  // uncapped, exactly matching Python's int-vs-float split.
  if (/^-?\d+$/.test(source)) {
    const literal = BigInt(source)
    if (literal > INT_INTEROP_MAX || literal < INT_INTEROP_MIN) {
      throw new JCSError('integer outside the ±(2^53−1) interop range')
    }
  }
}

/**
 * Parse JSON source text into a {@link JSONValue}, enforcing the ±(2^53−1)
 * integer interop cap on the *source literal* — the TS equivalent of the wire
 * path's `json.loads`.
 *
 * Why the cap lives here, on the source text, not on the parsed number: the
 * vectors are deliberately adversarial. `1e21` (≈10²¹, exponential) is accepted
 * though it is numerically *larger* than `2^53`, while the plain integer literal
 * `9007199254740992` (=2^53) is rejected. So the rule is NOT magnitude and NOT
 * `Number.isSafeInteger`. Python distinguishes them by source type
 * (`json.loads("1e21")` → float, uncapped; `json.loads("9007…992")` → int,
 * capped). `JSON.parse` erases that distinction *and* truncates ≥2^53
 * (`JSON.parse("9007199254740993")` → `9007199254740992`), so the cap cannot be
 * enforced on the parsed `number`. Instead we read `context.source` — the
 * pre-truncation literal (Stage-4 JSON.parse source access; Node 21+, evergreen
 * browsers) — and cap it via {@link enforceIntegerCap}, which fails CLOSED on
 * any runtime that does not expose it.
 *
 * NaN/Infinity reject at `JSON.parse` (`SyntaxError`), before this reviver runs.
 *
 * @throws {JCSError} an integer-form literal outside `[-(2^53)+1, 2^53-1]`, or
 *   an unsupported runtime lacking JSON source-text access.
 */
export function parseJcsJson(text: string): JSONValue {
  const parsed: unknown = JSON.parse(
    text,
    // The `context` (3rd) arg carries the raw source text. Typed locally as
    // optional so it stays assignable under the project's ES2022 lib; when the
    // runtime omits it, enforceIntegerCap fails closed for any number.
    function reviver(_key: string, value: unknown, context?: { source?: string }): unknown {
      enforceIntegerCap(value, context?.source)
      return value
    },
  )
  return parsed as JSONValue
}
