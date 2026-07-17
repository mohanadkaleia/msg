// composer/serialize.ts — the TipTap seam that PRESERVES the M2 wire contract.
//
// The M2 textarea sent raw markdown SOURCE text (`format: "markdown"`). TipTap
// renders markdown shortcuts as real ProseMirror marks/nodes (a `**bold**` input
// rule strips the asterisks and bolds the run), so `editor.getText()` would LOSE
// the markdown. This walks the editor's ProseMirror JSON back into the SAME
// markdown source the textarea produced — bold → `**…**`, lists → `- …`, etc. —
// and, in the same pass, collects the resolved `u_` ids of every @mention chip
// into `mentions[]` (the payload field ENG-80's projection already stores as
// `mention_user_ids`). Pure + browser-free, so it is unit-testable with teeth and
// carries no XSS surface (it emits plain text, never HTML).

import type { JSONContent } from '@tiptap/core'

/** Node name of the `@user` mention chip (default @tiptap/extension-mention). */
export const USER_MENTION = 'mention'
/** Node name of the `#channel` mention chip (our extended instance). */
export const CHANNEL_MENTION = 'channelMention'

/** The markdown source + resolved user-mention ids extracted from an editor doc. */
export interface SerializedMessage {
  /** Markdown source text — byte-for-byte the shape the M2 textarea sent. */
  text: string
  /** Resolved `u_` ids of every `@user` chip, de-duplicated, in first-seen order. */
  mentions: string[]
}

/** Serialize a ProseMirror doc (`editor.getJSON()`) to markdown source + mentions. */
export function serializeDoc(doc: JSONContent): SerializedMessage {
  const mentions: string[] = []
  const text = serializeBlocks(doc.content ?? [], mentions).replace(/\s+$/u, '')
  return { text, mentions: dedupe(mentions) }
}

/** Block-level nodes, joined by a single newline (Shift-Enter hard breaks add their own). */
function serializeBlocks(nodes: readonly JSONContent[], mentions: string[]): string {
  return nodes.map((n) => serializeBlock(n, mentions)).join('\n')
}

function serializeBlock(node: JSONContent, mentions: string[]): string {
  const children = node.content ?? []
  switch (node.type) {
    case 'paragraph':
      return serializeInline(children, mentions)
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1
      return `${'#'.repeat(level)} ${serializeInline(children, mentions)}`
    }
    case 'bulletList':
      return children.map((li) => `- ${serializeInline(listItemInline(li), mentions)}`).join('\n')
    case 'orderedList':
      return children
        .map((li, i) => `${i + 1}. ${serializeInline(listItemInline(li), mentions)}`)
        .join('\n')
    case 'codeBlock':
      return `\`\`\`\n${serializeInline(children, mentions)}\n\`\`\``
    case 'blockquote':
      // Prefix EVERY line — a child block can be multi-line (a hard break, a
      // nested list), and an unprefixed continuation line would fall out of the
      // quote when the renderer (lib/markdown.ts) reads the source back.
      return children
        .map((b) =>
          serializeBlock(b, mentions)
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        )
        .join('\n')
    default:
      // Unknown block: fall through to its inline content (never emit markup).
      return serializeInline(children, mentions)
  }
}

/** Flatten a listItem's block children (usually a single paragraph) to inline nodes. */
function listItemInline(listItem: JSONContent): JSONContent[] {
  const out: JSONContent[] = []
  for (const block of listItem.content ?? []) out.push(...(block.content ?? []))
  return out
}

function serializeInline(nodes: readonly JSONContent[], mentions: string[]): string {
  let out = ''
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += applyMarks(node.text ?? '', node.marks ?? [])
        break
      case 'hardBreak':
        out += '\n'
        break
      case USER_MENTION: {
        const id = attr(node, 'id')
        const label = attr(node, 'label') ?? id
        if (id.length > 0) mentions.push(id)
        out += `@${label}`
        break
      }
      case CHANNEL_MENTION: {
        // Channel references are text-only: the payload's `mentions[]` is USER
        // ids (`u_`) exclusively (per the message payload validator), so a channel
        // chip contributes `#name` to the text and nothing to `mentions[]`.
        out += `#${attr(node, 'label') || attr(node, 'id')}`
        break
      }
      default:
        if (node.content) out += serializeInline(node.content, mentions)
    }
  }
  return out
}

/** Read a string attribute off a node (defensively — attrs are loosely typed). */
function attr(node: JSONContent, key: string): string {
  const value: unknown = node.attrs?.[key]
  return typeof value === 'string' ? value : ''
}

type Mark = NonNullable<JSONContent['marks']>[number]

/** Wrap a text run in its markdown mark delimiters (code innermost, then emphasis). */
function applyMarks(text: string, marks: readonly Mark[]): string {
  if (text.length === 0) return text
  let out = text
  const has = (type: string): boolean => marks.some((m) => m.type === type)
  if (has('code')) out = `\`${out}\``
  if (has('bold')) out = `**${out}**`
  if (has('italic')) out = `*${out}*`
  if (has('strike')) out = `~~${out}~~`
  return out
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}
