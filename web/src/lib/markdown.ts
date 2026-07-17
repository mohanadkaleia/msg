// lib/markdown.ts — parse stored message markdown SOURCE into a render tree.
//
// Messages are stored as markdown source text (`format: "markdown"` — the wire
// contract the M2 textarea locked in; composer/serialize.ts is the writer). This
// is the READER: it parses exactly the subset that serializer emits — bold /
// italic / strike / inline code marks, bullet + ordered lists, fenced code
// blocks, and blockquotes — into a small typed tree that MessageBody renders as
// real elements (`<ul>`, `<pre>`, `<blockquote>`, …).
//
// SECURITY: purely lexical — the OUTPUT is a data tree whose leaves are plain
// strings. It never produces HTML, and MessageBody renders every leaf as a text
// VNode child (Vue escapes), so no `<img onerror>` in a message can become live
// markup. Anything that does not match a construct (unbalanced `**`, a stray
// fence, a `#` heading line, a raw URL) stays literal text — graceful, never
// thrown away, never markup.

/** Inline run: a leaf text/code span, or an emphasis wrapper over child runs. */
export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em' | 'strike'; children: InlineNode[] }

/** Block-level node. `blockquote` nests blocks; lists hold inline-run items. */
export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'bulletList' | 'orderedList'; items: InlineNode[][] }
  | { type: 'codeBlock'; text: string }
  | { type: 'blockquote'; children: BlockNode[] }

const BULLET_RE = /^- (.*)$/u
const ORDERED_RE = /^\d+\. (.*)$/u
const QUOTE_RE = /^> ?(.*)$/u
const FENCE_RE = /^```/u

/** Parse markdown source (the stored message text) into block nodes. */
export function parseMarkdown(source: string): BlockNode[] {
  return parseBlocks(source.split('\n'))
}

function parseBlocks(lines: readonly string[]): BlockNode[] {
  const blocks: BlockNode[] = []
  /** Pending plain lines, flushed into ONE pre-wrap paragraph (newlines kept). */
  let run: string[] = []

  const flush = (): void => {
    // Trim blank edges of the run (block separators), but keep interior blank
    // lines — `whitespace-pre-wrap` renders them exactly as the source had them.
    while (run.length > 0 && run[0]!.trim() === '') run.shift()
    while (run.length > 0 && run[run.length - 1]!.trim() === '') run.pop()
    if (run.length > 0) blocks.push({ type: 'paragraph', children: parseInline(run.join('\n')) })
    run = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!

    if (FENCE_RE.test(line)) {
      flush()
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        body.push(lines[i]!)
        i += 1
      }
      i += 1 // consume the closing fence (or run off the end — unterminated is ok)
      blocks.push({ type: 'codeBlock', text: body.join('\n') })
      continue
    }

    if (BULLET_RE.test(line)) {
      flush()
      const items: InlineNode[][] = []
      while (i < lines.length && BULLET_RE.test(lines[i]!)) {
        items.push(parseInline(BULLET_RE.exec(lines[i]!)![1]!))
        i += 1
      }
      blocks.push({ type: 'bulletList', items })
      continue
    }

    if (ORDERED_RE.test(line)) {
      flush()
      const items: InlineNode[][] = []
      while (i < lines.length && ORDERED_RE.test(lines[i]!)) {
        items.push(parseInline(ORDERED_RE.exec(lines[i]!)![1]!))
        i += 1
      }
      blocks.push({ type: 'orderedList', items })
      continue
    }

    if (QUOTE_RE.test(line)) {
      flush()
      const inner: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) {
        inner.push(QUOTE_RE.exec(lines[i]!)![1]!)
        i += 1
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(inner) })
      continue
    }

    run.push(line)
    i += 1
  }
  flush()
  return blocks
}

/**
 * Parse an inline run: `` `code` `` (literal inside), `**strong**`, `*em*`,
 * `~~strike~~`, and `***both***` (serialize.ts nests bold-then-italic that way).
 * Emphasis contents are parsed recursively; anything unbalanced stays literal.
 */
export function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = []
  let literal = ''
  let i = 0

  const flushLiteral = (): void => {
    if (literal.length > 0) out.push({ type: 'text', text: literal })
    literal = ''
  }

  /**
   * Try `open…close` at `i`; on success push `make(inner)` and advance.
   * Emphasis (`emphasis: true`) rejects whitespace-flanked contents so literal
   * text like `5 * 3 * 2` stays literal (the same rule the composer's input
   * rules follow — serialize.ts never emits space-flanked delimiters).
   */
  const tryWrap = (
    open: string,
    close: string,
    make: (inner: string) => InlineNode,
    emphasis = true,
  ): boolean => {
    if (!text.startsWith(open, i)) return false
    const end = text.indexOf(close, i + open.length)
    if (end === -1 || end === i + open.length) return false // unbalanced/empty → literal
    const inner = text.slice(i + open.length, end)
    if (emphasis && (inner !== inner.trimStart() || inner !== inner.trimEnd())) return false
    flushLiteral()
    out.push(make(inner))
    i = end + close.length
    return true
  }

  while (i < text.length) {
    const wrapped =
      tryWrap('`', '`', (inner) => ({ type: 'code', text: inner }), false) ||
      // `***x***` before `**` — bold+italic serializes as italic-around-bold.
      tryWrap('***', '***', (inner) => ({
        type: 'em',
        children: [{ type: 'strong', children: parseInline(inner) }],
      })) ||
      tryWrap('**', '**', (inner) => ({ type: 'strong', children: parseInline(inner) })) ||
      tryWrap('~~', '~~', (inner) => ({ type: 'strike', children: parseInline(inner) })) ||
      tryWrap('*', '*', (inner) => ({ type: 'em', children: parseInline(inner) }))
    if (!wrapped) {
      literal += text[i]!
      i += 1
    }
  }
  flushLiteral()
  return out
}
