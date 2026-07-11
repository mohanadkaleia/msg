import { describe, expect, it } from 'vitest'

import { parseInline, parseMarkdown, type InlineNode } from '../../../src/lib/markdown'
import { serializeDoc } from '../../../src/components/shell/composer/serialize'

const text = (t: string): InlineNode => ({ type: 'text', text: t })

describe('lib/markdown — stored markdown source → render tree', () => {
  it('parses a plain multi-line message into ONE pre-wrap paragraph', () => {
    expect(parseMarkdown('line one\nline two')).toEqual([
      { type: 'paragraph', children: [text('line one\nline two')] },
    ])
  })

  it('parses bullet and ordered lists into list blocks with per-item runs', () => {
    expect(parseMarkdown('- one\n- two')).toEqual([
      { type: 'bulletList', items: [[text('one')], [text('two')]] },
    ])
    expect(parseMarkdown('1. a\n2. b')).toEqual([
      { type: 'orderedList', items: [[text('a')], [text('b')]] },
    ])
  })

  it('parses fenced code blocks LITERALLY (no inline marks inside)', () => {
    expect(parseMarkdown('```\nconst x = **not bold**\n```')).toEqual([
      { type: 'codeBlock', text: 'const x = **not bold**' },
    ])
    // Unterminated fence: everything to EOF is still code, nothing is lost.
    expect(parseMarkdown('```\ndangling')).toEqual([{ type: 'codeBlock', text: 'dangling' }])
  })

  it('parses blockquotes, including multi-line (`> ` on every line)', () => {
    expect(parseMarkdown('> quoted\n> more')).toEqual([
      { type: 'blockquote', children: [{ type: 'paragraph', children: [text('quoted\nmore')] }] },
    ])
  })

  it('splits mixed content into ordered blocks around the paragraph runs', () => {
    const blocks = parseMarkdown('intro\n- a\n- b\noutro')
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'bulletList', 'paragraph'])
  })

  it('parses inline bold / italic / strike / code, nested and combined', () => {
    expect(parseInline('a **bold** *em* ~~gone~~ `x`')).toEqual([
      text('a '),
      { type: 'strong', children: [text('bold')] },
      text(' '),
      { type: 'em', children: [text('em')] },
      text(' '),
      { type: 'strike', children: [text('gone')] },
      text(' '),
      { type: 'code', text: 'x' },
    ])
    // serialize.ts nests bold+italic as ***x*** — italic around bold.
    expect(parseInline('***x***')).toEqual([
      { type: 'em', children: [{ type: 'strong', children: [text('x')] }] },
    ])
  })

  it('keeps unbalanced or space-flanked delimiters LITERAL (never drops text)', () => {
    expect(parseInline('2 ** 3 and a*b')).toEqual([text('2 ** 3 and a*b')])
    expect(parseInline('5 * 3 * 2')).toEqual([text('5 * 3 * 2')])
    expect(parseInline('unclosed **bold')).toEqual([text('unclosed **bold')])
  })

  it('leaves mentions, #channels, and URLs as literal text inside constructs', () => {
    expect(parseMarkdown('- ping @Dana see #general https://example.test')).toEqual([
      { type: 'bulletList', items: [[text('ping @Dana see #general https://example.test')]] },
    ])
  })

  it('never produces markup: hostile text stays a string leaf', () => {
    const [block] = parseMarkdown('<img src=x onerror=alert(1)> **<b>hi</b>**')
    expect(block).toEqual({
      type: 'paragraph',
      children: [
        text('<img src=x onerror=alert(1)> '),
        { type: 'strong', children: [text('<b>hi</b>')] },
      ],
    })
  })

  it('round-trips what composer/serialize.ts emits (write → read parity)', () => {
    // A doc with every formatting control the toolbar offers.
    const { text: source } = serializeDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hi ' }, bold('team')] },
        {
          type: 'bulletList',
          content: [li('first'), li('second')],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'let x = 1' }] },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'wise words' }] }],
        },
      ],
    })
    expect(source).toBe('hi **team**\n- first\n- second\n```\nlet x = 1\n```\n> wise words')
    expect(parseMarkdown(source)).toEqual([
      { type: 'paragraph', children: [text('hi '), { type: 'strong', children: [text('team')] }] },
      { type: 'bulletList', items: [[text('first')], [text('second')]] },
      { type: 'codeBlock', text: 'let x = 1' },
      { type: 'blockquote', children: [{ type: 'paragraph', children: [text('wise words')] }] },
    ])
  })

  it('round-trips a multi-line blockquote (hard break inside the quote)', () => {
    const { text: source } = serializeDoc({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'hardBreak' },
                { type: 'text', text: 'line two' },
              ],
            },
          ],
        },
      ],
    })
    // EVERY line is prefixed, so the whole quote survives the read-back.
    expect(source).toBe('> line one\n> line two')
    expect(parseMarkdown(source)).toEqual([
      {
        type: 'blockquote',
        children: [{ type: 'paragraph', children: [text('line one\nline two')] }],
      },
    ])
  })
})

function bold(t: string) {
  return { type: 'text', text: t, marks: [{ type: 'bold' }] }
}

function li(t: string) {
  return {
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
  }
}
