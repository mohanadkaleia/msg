# ENG-56 — M0: Event hashing + frozen cross-language test vectors

- **Linear:** ENG-56 · Milestone M0 — Protocol spike · Priority High
- **TDD refs:** §2.1 (envelope / `event_hash` = SHA-256 over JCS(body) only), §3.2 (upload validation order), §11.4/§12 (`msgctl verify` re-hash), D1, D9, D14
- **Implementer:** `python-engineer` (all work is `server/`)
- **Depends on (all merged to main):** ENG-53 (scaffold), ENG-54 (`envelope.py`, `payloads/`, `ids.py`), ENG-55 (`jcs.py` with `canonicalize`, `JCSError`, `MAX_DEPTH=128`)
- **This is the M0 exit-criterion artifact:** "hash vectors frozen" (§13, M0). The frozen `vectors.json` is the contract the M2 TypeScript client must reproduce bit-for-bit.

---

## 1. Goal (restated)

Two deliverables:

1. **`hash_event` / `verify_hash`** in `server/msgd/core/hashing.py` — the thin, deterministic layer
   that turns `canonicalize(body)` bytes into `event_hash = "sha256:<hex>"`. Server metadata and
   `signature` **never** affect the hash (D1); the hash covers `body` only.
2. **`server/msgd/core/testdata/vectors.json`** — the FROZEN cross-language golden suite: each case is
   `raw JSON source → canonical bytes → expected sha256`, plus must-reject cases carrying an `error`
   expectation. Python passes every case; the file is freeze-guarded so any edit is deliberate; a
   tamper test proves single-byte/single-field mutation flips the hash.

No new runtime dependencies (`hashlib`, `base64` are stdlib; `rfc8785` already pulled by ENG-55).
`hypothesis>=6.100` is already in the root dev group — no `pyproject` dep change for tests.

---

## 2. Crux ruling — hash the RAW received body, never a re-serialized model (carryover #1 & #2)

This is the central correctness decision of the ticket. It comes straight out of PR #3's security
review (hardening note #2 on `envelope.py:112`):

> Pydantic lax scalar coercion (`"1"`→`1`) means `model_dump(body)` is not byte-faithful to client
> input; ENG-56 must hash the raw received body, not the re-serialized model.

I verified the failure mode: `Body` declares `type_version: int` and several `str` id fields. Under
Pydantic's default lax mode a client that sends `"type_version": "1"` (string) or `1.0` (float) is
coerced to int `1`; `model_dump` then emits `1`, whose JCS bytes (`…"type_version":1…`) differ from
what that client actually hashed (`…"type_version":"1"…`). Hashing `model_dump` would therefore
compute a **different** digest than the client's, i.e. it silently "repairs" a nonconforming body and
would either false-reject a faithful event or mask a malformed one. (The `payload` subtree is typed
`dict[str, Any]`, so `Any` preserves it verbatim — the coercion risk is confined to the top-level
declared scalar fields, but that is enough to break byte-fidelity, so the rule is absolute.)

### Ruling

- **`hash_event(body)` takes the raw body dict** — the object straight out of `json.loads`, **before**
  any Pydantic validation. Its input type is `JSONValue` (the ENG-55 alias, a strict superset of the
  body dict) so the vector runner can feed it scalars/arrays too; the production caller passes the raw
  `body` dict. It is a pure `body → hash` function and never touches `Body`/`Envelope`.

- **Contract for the future §3.2 upload validator (state it in the docstring):** the order is
  **parse (`json.loads`) → `hash_event(raw_dict)` and compare to the raw `event_hash` → THEN validate
  models**. The raw parsed dict is the source of truth for the hash; the Pydantic models are validated
  *after* the hash is confirmed and are never the thing hashed. This matches §3.2's stated validation
  order (schema check happens, then `event_hash` recomputation) and the DB storing `body` "verbatim"
  (§4.3, `body JSONB … full client body, verbatim`).

### `verify_hash(envelope) -> bool` — the crux resolved (carryover #2)

The ticket asks for `verify_hash(envelope)`. The hard question: how do you get the raw body out of an
`Envelope` parsed with `extra="allow"`? You cannot — by the time you hold an `Envelope`, the raw bytes
are **already gone**, collapsed by the coercion above. So:

- **`verify_hash(envelope: Envelope) -> bool` is delivered as a convenience for the model-is-source
  path only** — client-side construction (`build_message_created_body`), tests, and re-hashing an
  event you built yourself. It computes
  `hash_event(envelope.body.model_dump(mode="json")) == envelope.event_hash`.
  When the `Body` *is* the source of truth, `model_dump` is definitionally faithful, so this is exact.

- **`verify_hash(envelope)` is explicitly NOT the §3.2 upload authority**, and its docstring says so in
  bold. On the upload path the raw client bytes are authoritative and may diverge from `model_dump`
  under lax coercion; the upload validator must call `hash_event(raw_body_dict)` on the **pre-model**
  parsed JSON and compare to the raw `event_hash` — which is a one-liner, so no separate raw-verify
  function is needed. Likewise `msgctl verify` (§11.4) re-hashes the **verbatim stored JSONB dict**
  via `hash_event`, not `verify_hash(envelope)`.

- **Redaction exemption (§2.1):** "redacted events are exempt from hash verification." So
  `verify_hash(envelope)` returns `True` when `envelope.server is not None and
  envelope.server.payload_redacted` — the server may null `body.payload` and the hash no longer
  matches by design. Encoded here and pinned by a test.

- **Is `model_dump` "faithful enough" (the ticket's phrasing)?** Ruled: **faithful for the
  model-is-source path, NOT faithful for the upload path.** The ENG-54 round-trip tests assert only
  *structural* (key-order-insensitive) equality of the §2.1 example, not byte-fidelity under
  adversarial coercion, so they do not license using `verify_hash(envelope)` as the upload gate. A
  dedicated test (below) locks this limitation so a future §3.2 implementer cannot mistake the
  convenience for the authority.

**Public surface of `hashing.py`:** `hash_event`, `verify_hash`, and a `HASH_ALGORITHM = "sha256"`
constant (+ the `"sha256:"` prefix). Minimal, mirrors ENG-55's `canonicalize`/`JCSError` shape.
Callers import `from msgd.core.hashing import hash_event, verify_hash` — **zero edits to
`core/__init__.py`** (its docstring already announces `hashing` and `testdata/vectors.json`), matching
the ENG-54/55 no-re-export convention.

---

## 3. Byte-encoding ruling for canonical bytes in vectors.json → **base64**

Canonical JCS output is **not** always embeddable as a JSON string: I confirmed against
`rfc8785==0.1.4` that control chars `< 0x20` are `\uXXXX`-escaped, but **`0x7f` (DEL) and other
non-ASCII bytes pass through raw** — e.g. `canonicalize({"a":1,"x":"\x7f"})` yields bytes containing a
literal `0x7f`. JSON strings cannot hold literal control bytes losslessly, so the canonical bytes must
be carried as a binary blob.

**Decision: base64 (RFC 4648 standard alphabet, with padding), field `canonical_b64`.** Rationale:

- **Lossless** for any byte string, including the raw-`0x7f` case that forces the choice.
- **More compact than hex** (~33% overhead vs 100%). Vectors range up to the 64 KB event cap; hex
  would double the largest ones and bloat the freeze-hashed file.
- **Native in both consumers** — Python `base64.b64decode`, TS/JS `atob` / `Buffer.from(x,'base64')`.
- Hex's only edge (single-byte eyeballing on review) is not real here: JCS output is a mix of ASCII
  and raw UTF-8, so both encodings are opaque to a human. Review-time safety is provided instead by
  the freeze-hash guard (§6) + the internal-consistency check (§5).

Each **valid** case carries BOTH `canonical_b64` (so the TS client can assert its JCS bytes match
*before* hashing, isolating JCS bugs from hashing bugs) and `hash` (`"sha256:<hex>"`). Each **error**
case carries `error` instead of both.

---

## 4. Vector file format (documented in an in-file `_meta` block so M2 consumes it unchanged)

`vectors.json` is a single object: a `_meta` header + a `cases` array. The whole file is emitted with
`ensure_ascii=True`, `indent=2`, LF newlines, trailing newline, and stable key order — so it is
**pure ASCII** (surrogate/emoji inputs survive as `\uXXXX` escapes) and byte-stable for the freeze
hash.

```jsonc
{
  "_meta": {
    "purpose": "Frozen cross-language JCS+hash vectors for msg (M0 exit criterion).",
    "spec": "event_hash = 'sha256:' + hex(sha256(RFC8785-JCS(body)))",
    "input": "input_json is raw JSON SOURCE TEXT. Consumers MUST json-parse it with their standard parser, then hash the parsed value — this mirrors the §3.2 wire path (bytes -> parse -> hash) and is the ONLY representation that can carry the must-reject inputs (NaN, lone surrogates, over-depth).",
    "encoding": "base64",              // canonical_b64 uses RFC 4648 standard alphabet + padding
    "hash_format": "sha256:<lowercase-hex>",
    "max_depth": 128,                  // MUST equal msgd.core.jcs.MAX_DEPTH; the TS client enforces the same
    "int_interop_cap": [-9007199254740991, 9007199254740991],  // [-(2^53)+1, 2^53-1]
    "version": 1,
    "frozen": true,
    "note_ts_client": "See §7 risks: JSON.parse loses precision >= 2^53 and rejects NaN/Infinity at PARSE time; error cases are stage-agnostic ('must not produce a hash')."
  },
  "cases": [
    { "id": "tdd-2.1-example", "desc": "...", "input_json": "{...}", "canonical_b64": "…", "hash": "sha256:49d4…" },
    { "id": "reject-nan",      "desc": "...", "input_json": "NaN",   "error": { "kind": "non_finite_float", "stage": "canonicalize" } }
  ]
}
```

**Format rulings:**

- **One input mechanism for all cases: `input_json` (raw JSON source text).** The runner does
  `json.loads(input_json)` then hashes — never touching Pydantic. This is wire-faithful (matches §3.2),
  keeps the raw-body-vs-model contract honest, and is the *only* representation that can encode the
  error inputs: `NaN`/`Infinity` (Python `json.loads` accepts them by default), lone-surrogate keys as
  `\ud800` escapes, and 2000-deep bracket strings. TS consumes it via `JSON.parse(input_json)`.
- **Error expectation:** `error` is `{ "kind": <string>, "stage": "parse"|"canonicalize" }`. Frozen
  semantics = **"this input must not yield a hash."** The `stage` is a hint, not a hard assertion,
  because parsers differ (Python `json.loads` accepts `NaN` and rejects it at canonicalize; JS
  `JSON.parse` rejects it at parse) — both consumers must reject overall, which is what the runner
  asserts.
- **`_meta.max_depth` and `_meta.int_interop_cap` pin the ENG-55 protocol constants into the frozen
  file** so the M2 client cannot silently drift from `MAX_DEPTH=128` (carryover #3) or the 2^53 cap.
- Documentation lives in `_meta` (in-file), not a separate README — the M2 client gets everything it
  needs from the one file it loads.

---

## 5. Vector case list (the frozen suite)

Grouped; ids are stable (the M2 runner keys off them). "Valid" cases carry `canonical_b64` + `hash`;
"reject" cases carry `error`.

### Valid — §2.1 & structure
1. `tdd-2.1-example` — the exact §2.1 `body` (filled ULIDs). **Anchor:** its hash is
   `sha256:49d43880190e9b17c2b4eb5cd4fbe39c972ba0d214b3f751d6033cb0fd707e51` (independently computed
   during planning; the runner also asserts this against a hardcoded constant so the golden file is
   not purely self-referential).
2. `empty-object` — `{}`.
3. `empty-array` — `[]`.
4. `scalar-null` / `scalar-true` / `scalar-false` — `null` / `true` / `false`.
5. `mixed-array` — `[3,"a",null,true,1,{},[]]` (order preserved).
6. `nested-under-cap` — `{"a":{},"z":[1,{"y":[2,{"x":[3,[]]}]}]}` (moderate nesting, well under 128).

### Valid — key ordering
7. `keys-unsorted` — `{"b":1,"a":2,"c":3}` → sorted.
8. `keys-case-sensitive` — `{"b":1,"B":2,"a":3,"A":4}` → uppercase before lowercase.
9. `keys-utf16-astral` — object keyed by `U+1F600` (emoji) and `U+FFFF`; JCS emits the emoji first
   (lead surrogate `0xD83D` < `0xFFFF`) — the case naive code-point sort and `json.dumps(sort_keys=True)`
   get wrong. Locks the UTF-16 code-unit ordering into the frozen file for the TS client.

### Valid — unicode text
10. `unicode-bmp` — a string with BMP accents/CJK.
11. `unicode-astral` — strings with `U+1F600` and `U+1D11E` (musical G-clef); emitted as raw UTF-8,
    proving no `\u` escaping of non-control chars.
12. `unicode-nfc` and `unicode-nfd` — the **same visual `é`** composed (NFC, `U+00E9`) vs decomposed
    (NFD, `U+0065 U+0301`), as **two separate vectors with DISTINCT hashes** — proving JCS does not
    normalize (NFC is the client's responsibility, per D1/ENG-55).

### Valid — escapes (incl. the raw-byte case that forces base64)
13. `escapes-short` — a string containing `"`, `\`, `\n`, `\t`, `\b`, `\f`, `\r` → short escapes.
14. `escapes-control` — ` `, ``, `` → `\uXXXX` lowercase.
15. `raw-0x7f` — `{"a":1,"x":""}` whose **canonical bytes contain a literal `0x7f`** — the
    concrete reason `canonical_b64` cannot be a JSON string. (Confirmed present in the base64 blob.)

### Valid — numbers (tricky JCS / ES6 table, each its own vector)
16. `num-int-zero` (`0`), `num-neg-zero-int` (`-0` → `0`), `num-neg-zero-float` (`-0.0` → `0`).
17. `num-int-one` (`1`), `num-neg-one` (`-1`), `num-float-two` (`2.0` → `2`).
18. `num-cap-max` — `9007199254740991` (`2^53-1`, accepted).
19. `num-frac` (`0.1`), `num-exp-large` (`1e30` → `1e+30`), `num-exp-small` (`1e-7`),
    `num-9999e22` (`9.999e22`), `num-1e21` (`1e21` → `1e+21`), `num-subnormal` (`5e-324`).

### Valid — bodies / payloads / extras
20. `body-optional-empty` — a `message.created` body with `thread_root_id:null`, `file_ids:[]`,
    `mentions:[]` (the empty/optional-fields shape).
21. `body-nested-populated` — a body with populated `file_ids` (2 `f_` ids), `mentions` (2 `u_` ids),
    and a non-null `thread_root_id` (nested payload arrays).
22. `body-unknown-extra-fields` — a body with an extra top-level `future_field` AND an extra field
    inside `payload` (§2.3 additive). **Proves unknown fields are part of `body`, are canonicalized,
    and DO change the hash** (contrast with server metadata, which is not in `body` and does not).

### Valid — depth cap (NEW, from ENG-55 Security Round 1)
23. `depth-at-cap-list` — a list nested **exactly 128** deep; accepted; canonical bytes are
    `[`×128 + `1` + `]`×128. Pins `MAX_DEPTH` acceptance boundary.
24. `depth-at-cap-dict` — a dict nested exactly 128 deep (`{"k":…}`); accepted.

### Reject — invalid input (`error`, no hash) (NEW depth cases + carryover)
25. `reject-nan` — `input_json: "NaN"` → non-finite float. (Python parses to `nan`, canonicalize
    rejects; JS rejects at parse. Both: no hash.)
26. `reject-infinity` / `reject-neg-infinity` — `Infinity` / `-Infinity` → non-finite.
27. `reject-surrogate-key` — `{"\ud800": 1}` (stored as the `\ud800` escape) → lone-surrogate object
    key; the PR #4 finding-1 regression, key path (`UnicodeEncodeError` → `JCSError`).
28. `reject-surrogate-value` — `{"x": "\ud800"}` → lone-surrogate string value (library
    `CanonicalizationError` path).
29. `reject-int-over-cap` — `9007199254740992` (`2^53`) and `reject-int-over-cap-plus1`
    (`9007199254740993`) → outside the interop cap. **Cross-language caveat flagged in `_meta` and
    §7:** JS `JSON.parse` silently truncates these to `2^53`, so the TS client must reject on
    magnitude, not on an exact bigint compare.
30. `reject-depth-over-cap-list` — depth **129** list → over cap.
31. `reject-depth-over-cap-dict` — depth 129 dict → over cap.
32. `reject-depth-pathological` — `"[" * 2000 + "1" + "]" * 2000` → the reviewer's repro; asserts no
    `RecursionError` escapes (parse-then-hash path, §3.2-reachable). Pins the ENG-55 Security Round 1
    fix into the frozen suite.

That is ~40 vectors across the eight ticket-required categories plus the two NEW depth-boundary
categories and the invalid-input group.

---

## 6. Freeze mechanism ruling → **whole-file self-sha256 guard, constant lives only in the test**

**Decision:** a `test_vectors_file_is_frozen` test asserts
`sha256(vectors.json raw bytes).hexdigest() == VECTORS_SHA256`, where `VECTORS_SHA256` is a module-level
constant **in the test file only** (never inside the file — avoids self-reference). Any edit to the
frozen file changes its bytes → the freeze test fails → the editor must consciously update
`VECTORS_SHA256` in a second place. That two-place change *is* the "edits require a deliberate
decision" acceptance criterion.

**Why whole-file raw bytes (not a normalized/semantic hash):** simplest, strictest, and catches
*every* change including reformatting. The one downside — spurious churn from whitespace/newline
differences — is neutralized by (a) the generator emitting a fixed deterministic serialization
(`ensure_ascii=True`, `indent=2`, sorted keys, LF, trailing newline) and (b) a `.gitattributes` entry
`*.json text eol=lf` (or `server/msgd/core/testdata/vectors.json text eol=lf`) so git never rewrites
line endings. Considered and rejected: hashing a re-normalized `json.load`→`json.dump` form (immune to
formatting churn but weaker — it would let a whitespace-only edit pass silently, defeating the
"deliberate edit" intent) and embedding the hash in `_meta` (self-referential, awkward).

**Generator (`server/tests/generate_vectors.py`):** a committed, re-runnable one-shot that defines the
input cases as raw JSON source strings + their valid/reject classification, computes `canonical_b64`
and `hash` for valid cases via `canonicalize`/`hash_event`, records `error` for reject cases (without
computing a hash), writes `vectors.json` deterministically, and **prints the resulting file's sha256**
so `python-engineer` pastes it into `VECTORS_SHA256`. The golden hashes are generated by our own
implementation (standard for a golden file); independence comes from three places: the §2.1 anchor
hash checked against a hardcoded constant, ENG-55's independent RFC-appendix validation of
`canonicalize`, and the M2 TS client as a genuinely separate implementation that must reproduce the
file. Regenerating on a legitimate vector change is the deliberate path: re-run generator → freeze
test fails → update the constant.

---

## 7. Files

**Create:**

| File | Action | Notes |
|---|---|---|
| `server/msgd/core/hashing.py` | create | `HASH_ALGORITHM`, `hash_event(body: JSONValue) -> str`, `verify_hash(envelope: Envelope) -> bool`; docstring encodes §2 contract. Imports `hashlib`, `canonicalize`/`JSONValue` from `jcs`, `Envelope` from `envelope`. |
| `server/msgd/core/testdata/__init__.py` | create | empty package marker (docstring only) so `importlib.resources.files("msgd.core.testdata")` locates the JSON and it ships in the wheel |
| `server/msgd/core/testdata/vectors.json` | create | the FROZEN suite (§4–§5), produced by the generator |
| `server/tests/generate_vectors.py` | create | committed deterministic generator (§6) |
| `server/tests/test_hashing.py` | create | hash/verify unit + tamper property + raw-vs-model + redaction tests (§8) |
| `server/tests/test_vectors.py` | create | vector runner + freeze guard + `_meta` format test (§8) |

**Edit (verify, may be a no-op):**

| File | Action | Notes |
|---|---|---|
| `server/pyproject.toml` | edit **if needed** | ensure hatchling ships `msgd/core/testdata/*.json` in the wheel (e.g. `[tool.hatch.build.targets.wheel] artifacts = ["msgd/core/testdata/*.json"]` or `force-include`). Verify with `uv build`; add only if the file is missing from the wheel. |
| `.gitattributes` | create/edit | `server/msgd/core/testdata/vectors.json text eol=lf` to keep the freeze hash stable across platforms |

**Explicitly NOT touched:** `core/__init__.py` (docstring already lists `hashing` + `testdata`; no
re-export, per convention), `jcs.py`, `envelope.py`, `payloads/`, root `pyproject.toml` (hypothesis
already present).

---

## 8. Step-by-step (all `python-engineer`)

**Step 1 — `hashing.py`.**
- `HASH_ALGORITHM = "sha256"`; prefix `"sha256:"`.
- `hash_event(body: JSONValue) -> str`: `return f"sha256:{hashlib.sha256(canonicalize(body)).hexdigest()}"`.
  Docstring states: takes the **raw** parsed dict (never `model_dump`); §3.2 order parse→hash→validate;
  server metadata / signature are structurally excluded (not in `body`). Propagates `JCSError` for
  out-of-domain input (does not swallow it — the caller decides reject vs 400).
- `verify_hash(envelope: Envelope) -> bool`: redaction short-circuit
  (`if envelope.server and envelope.server.payload_redacted: return True`), else
  `hash_event(envelope.body.model_dump(mode="json")) == envelope.event_hash`. Docstring: **NOT the
  §3.2 upload authority** (model-is-source only); upload/`msgctl verify` use `hash_event(raw_dict)`.
- Import-light; mypy-strict clean; `__all__` = the three names.

**Step 2 — `generate_vectors.py`.** Define the §5 case table (raw `input_json` + classification),
compute valid entries via `canonicalize`/`hash_event`, record `error` for rejects, build the `_meta`
(pulling `MAX_DEPTH` from `msgd.core.jcs` so it can't drift), `json.dump` deterministically
(`ensure_ascii=True, indent=2, sort_keys` on the object level with a stable case order, LF, trailing
newline), print the file sha256.

**Step 3 — run the generator**, commit `vectors.json`, paste its sha256 into `VECTORS_SHA256`.

**Step 4 — `test_vectors.py`.** Load via `importlib.resources`. Parametrize `cases` by `id`:
- valid: `parsed = json.loads(c["input_json"])`; assert `canonicalize(parsed) == b64decode(c["canonical_b64"])`;
  assert `hash_event(parsed) == c["hash"]`; assert
  `"sha256:"+sha256(b64decode(c["canonical_b64"])).hexdigest() == c["hash"]` (internal consistency).
- reject: assert `hash_event(json.loads(c["input_json"]))` raises (wrap `json.loads` too, so a
  parse-stage rejection also counts) — asserts **no** hash is produced and **no** unexpected exception
  (e.g. `RecursionError`) escapes.
- `test_meta_format`: assert `_meta.encoding=="base64"`, `_meta.max_depth == jcs.MAX_DEPTH`,
  `_meta.version`, `hash_format`.
- `test_2_1_anchor`: the `tdd-2.1-example` hash equals the hardcoded
  `sha256:49d43880190e9b17c2b4eb5cd4fbe39c972ba0d214b3f751d6033cb0fd707e51`.
- `test_vectors_file_is_frozen`: whole-file sha256 == `VECTORS_SHA256` (§6).

**Step 5 — `test_hashing.py`.**
- Shape: `hash_event(EXAMPLE_BODY)` matches `^sha256:[0-9a-f]{64}$`, is deterministic, equals the
  anchor constant.
- **Body-only:** build a valid `Envelope`; verify_hash True; then mutate `signature` and attach/alter
  `server` metadata → verify_hash still True (server/sig never enter the hash).
- **Raw-vs-model lock (carryover #1):** two raw dicts identical except `"type_version": "1"` (string)
  vs `1` (int) → `hash_event` returns **different** digests; and show `Body(**string_form).model_dump()`
  collapses to int (so hashing the model would lose the distinction) — pins why the upload path must
  hash the raw dict.
- **verify_hash-is-not-upload-authority lock:** construct an `Envelope` from a body that had
  `"type_version":"1"`; assert `verify_hash(envelope)` reflects the **coerced** (model_dump) form, not
  the raw string form — documenting the trap so §3.2 uses `hash_event(raw)` instead.
- **Redaction:** envelope with `server.payload_redacted=True` and a deliberately-wrong `event_hash` →
  verify_hash True.
- **Tamper property test (hypothesis):** strategy = JSON objects (reuse ENG-55's recursive
  `json_values` shape, in-domain). For each generated `body`: (a) **field mutation** — change one leaf
  value → `hash_event(mutated) != hash_event(body)` and `verify_hash(envelope_with_original_hash)` is
  False; (b) **byte mutation** — flip one byte of `canonicalize(body)` → resulting sha256 differs
  (hash sensitivity). Assumptions guard against a no-op mutation collapsing to the same canonical form.
- `verify_hash` False on a tampered `event_hash` (wrong digest).

**Step 6 — quality gates.** `uv run pytest server/tests/`, `uv run mypy`, `uv run ruff check` all
green; `uv build` confirms `vectors.json` ships in the wheel.

---

## 9. Risks / open questions

1. **The `verify_hash(envelope)` trap (highest risk).** A future §3.2 implementer could call it on the
   upload path and hash a coerced body. Mitigated by: bold docstring, the raw-vs-model lock test, the
   not-upload-authority lock test, and a `hardening:` note to carry into the §3.2 upload ticket
   ("verify via `hash_event(raw_parsed_body)`; construct models only after the hash matches").
2. **Cross-language integer precision (`2^53`).** JS `JSON.parse` truncates integers ≥ 2^53, so the TS
   client cannot reproduce the Python "reject bigint" behavior with a naive parse. Pinned as reject
   vectors + a `_meta` note + this risk: **M2 must reject numbers of magnitude ≥ 2^53 before/at parse**
   (bigint-aware parse or a magnitude guard). Not a hash split (both sides reject), but a real client
   implementation constraint.
3. **NaN/Infinity parse-stage divergence.** Python `json.loads` accepts them (reject at canonicalize);
   JS `JSON.parse` rejects at parse. Handled by stage-agnostic `error` semantics ("must not produce a
   hash"); `stage` is a hint only.
4. **Freeze-hash whitespace churn.** Mitigated by the deterministic generator + `.gitattributes`
   eol=lf. If CI runs on Windows, confirm the checkout keeps LF.
5. **Wheel packaging of `testdata/*.json`.** hatchling may not include a data file automatically;
   Step 6's `uv build` check + the optional `artifacts`/`force-include` edit covers it. Low risk (the
   tests can also load via the repo path in editable installs).
6. **Golden-file self-reference.** Hashes are generated by our own impl; independence supplied by the
   RFC-anchored §2.1 constant, ENG-55's appendix validation, and the M2 TS cross-implementation.
7. **Surrogate/emoji safe storage in the file.** `ensure_ascii=True` on the outer dump keeps
   `vectors.json` pure ASCII (surrogates as `\ud800`, emoji as `\uXXXX`) — no lone-surrogate bytes ever
   hit the UTF-8 file, and `json.loads` reconstructs them for the runner.

---

## 10. Acceptance-criteria mapping

| AC | Covered by |
|---|---|
| `hash_event(body) -> "sha256:<hex>"` hashing JCS(body) only | §2, hashing.py Step 1, body-only test |
| `verify_hash(envelope) -> bool` | §2 ruling, Step 1, verify tests + redaction |
| Server metadata / signature never affect the hash | body-only test (§8 Step 5) |
| Frozen `core/testdata/vectors.json` cross-language suite | §4–§6, test_vectors.py |
| All required categories + NEW at-cap/over-cap + invalid-input(`error`) | §5 case list |
| Canonical bytes losslessly encoded (base64, ruled) | §3 |
| Format documented for unchanged M2 consumption | §4 `_meta` |
| Python passes every vector | test_vectors.py runner |
| Vectors frozen (deliberate edit) | §6 freeze guard |
| Tamper: single-byte/field mutation flips hash / fails verify | §8 Step 5 tamper property test |
| MAX_DEPTH=128 pinned for TS mirror (carryover #3) | `_meta.max_depth`, depth vectors 23/24/30–32 |
| Raw-body-not-model contract (carryover #1) | §2, raw-vs-model lock test |
| Raw body out of Envelope crux (carryover #2) | §2 verify_hash ruling + not-authority lock test |
