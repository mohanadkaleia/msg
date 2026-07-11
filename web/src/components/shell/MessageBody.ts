// MessageBody — renders a message's stored text as rich content (lists, inline
// code, code blocks, blockquotes, bold/italic/strike) when `format` is
// `"markdown"`, or as the exact pre-wrap plain text when `format` is `"plain"`.
//
// This is the READ side of the composer round-trip: composer/serialize.ts writes
// markdown source onto the wire, lib/markdown.ts parses that same subset back
// into a typed tree, and this component turns the tree into real elements.
//
// SECURITY (critical): message text is other users' input. Every leaf lands as a
// VNode TEXT child (Vue escapes it) — there is NO v-html, no innerHTML, and the
// parser itself only ever outputs plain strings. `<img onerror>` in a message
// renders as the literal characters, exactly as before.
//
// Render-function component (not an SFC) because blockquotes nest blocks —
// recursion is a plain function call here, no recursive template needed. The
// root keeps the `message-text` testid + per-message `dir` (ENG-175 RTL) that
// the old plain `<p>` carried; block styling lives under `.rich-text` in
// style.css (token-driven, shared with the composer's live editor).
import { defineComponent, h, type PropType, type VNodeChild } from 'vue'

import { parseMarkdown, type BlockNode, type InlineNode } from '../../lib/markdown'
import type { TextDirection } from '../../lib/textDirection'

function renderInline(nodes: readonly InlineNode[]): VNodeChild[] {
  return nodes.map((node) => {
    switch (node.type) {
      case 'text':
        return node.text // text VNode child — Vue escapes
      case 'code':
        return h('code', node.text)
      case 'strong':
        return h('strong', renderInline(node.children))
      case 'em':
        return h('em', renderInline(node.children))
      case 'strike':
        return h('s', renderInline(node.children))
    }
  })
}

function renderBlock(node: BlockNode): VNodeChild {
  switch (node.type) {
    case 'paragraph':
      return h('p', renderInline(node.children))
    case 'bulletList':
      return h(
        'ul',
        node.items.map((item) => h('li', renderInline(item))),
      )
    case 'orderedList':
      return h(
        'ol',
        node.items.map((item) => h('li', renderInline(item))),
      )
    case 'codeBlock':
      return h('pre', h('code', node.text))
    case 'blockquote':
      return h('blockquote', node.children.map(renderBlock))
  }
}

export default defineComponent({
  name: 'MessageBody',
  props: {
    /** The stored message text — markdown SOURCE or plain text, per `format`. */
    text: { type: String, required: true },
    /** The message's stored wire format (§5.4): markdown renders rich. */
    format: { type: String as PropType<'markdown' | 'plain'>, required: true },
    /** Per-message base direction (ENG-175 first-strong detection). */
    dir: { type: String as PropType<TextDirection>, required: true },
  },
  setup(props) {
    return () => {
      const blocks: BlockNode[] =
        props.format === 'markdown'
          ? parseMarkdown(props.text)
          : [{ type: 'paragraph', children: [{ type: 'text', text: props.text }] }]
      return h(
        'div',
        {
          dir: props.dir,
          class: 'rich-text break-words text-start text-sm text-primary',
          'data-testid': 'message-text',
        },
        blocks.map(renderBlock),
      )
    }
  },
})
