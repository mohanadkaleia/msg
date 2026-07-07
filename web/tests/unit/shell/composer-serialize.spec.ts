import type { JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'

import { serializeDoc } from '../../../src/components/shell/composer/serialize'

const doc = (content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const p = (content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const t = (text: string, marks?: string[]): JSONContent => ({
  type: 'text',
  text,
  ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
})

describe('composer/serialize — editor doc → markdown source + mentions', () => {
  it('round-trips inline marks back to markdown source (not stripped text)', () => {
    const out = serializeDoc(
      doc([
        p([t('a '), t('bold', ['bold']), t(' '), t('em', ['italic']), t(' '), t('c', ['code'])]),
      ]),
    )
    expect(out.text).toBe('a **bold** *em* `c`')
    expect(out.mentions).toEqual([])
  })

  it('serializes bullet and ordered lists', () => {
    const li = (text: string): JSONContent => ({
      type: 'listItem',
      content: [p([t(text)])],
    })
    expect(serializeDoc(doc([{ type: 'bulletList', content: [li('one'), li('two')] }])).text).toBe(
      '- one\n- two',
    )
    expect(serializeDoc(doc([{ type: 'orderedList', content: [li('a'), li('b')] }])).text).toBe(
      '1. a\n2. b',
    )
  })

  it('turns hard breaks into newlines (Shift+Enter)', () => {
    const out = serializeDoc(doc([p([t('line one'), { type: 'hardBreak' }, t('line two')])]))
    expect(out.text).toBe('line one\nline two')
  })

  it('collects @user mention ids and renders @label text; de-dupes', () => {
    const mention = (id: string, label: string): JSONContent => ({
      type: 'mention',
      attrs: { id, label },
    })
    const out = serializeDoc(
      doc([p([mention('u_dana', 'Dana'), t(' and '), mention('u_dana', 'Dana')])]),
    )
    expect(out.text).toBe('@Dana and @Dana')
    expect(out.mentions).toEqual(['u_dana'])
  })

  it('renders #channel chips as text only — never into mentions[]', () => {
    const channel: JSONContent = {
      type: 'channelMention',
      attrs: { id: 's_gen', label: 'general' },
    }
    const out = serializeDoc(doc([p([t('see '), channel])]))
    expect(out.text).toBe('see #general')
    expect(out.mentions).toEqual([])
  })

  it('emits no HTML for any node — output is plain markdown source', () => {
    const out = serializeDoc(doc([p([t('<img onerror=alert(1)>', ['bold'])])]))
    // The angle brackets survive as LITERAL text (escaped by being source, not markup).
    expect(out.text).toBe('**<img onerror=alert(1)>**')
    expect(out.text).not.toContain('</')
  })
})
