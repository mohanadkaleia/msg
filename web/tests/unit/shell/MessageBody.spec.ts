import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import MessageBody from '../../../src/components/shell/MessageBody'
import MessageItem from '../../../src/components/shell/MessageItem.vue'
import type { DisplayMessage } from '../../../src/stores/messages'

function mountBody(
  text: string,
  format: 'markdown' | 'plain' = 'markdown',
  dir: 'ltr' | 'rtl' = 'ltr',
) {
  return mount(MessageBody, { props: { text, format, dir } })
}

function makeMessage(over: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    message_id: 'm_00000000000000000000000000',
    stream_id: 's1',
    created_seq: 1,
    author_user_id: 'u_other',
    text: 'hello',
    format: 'markdown',
    mention_user_ids: [],
    file_ids: [],
    ts: Date.now(),
    mine: false,
    ...over,
  }
}

describe('MessageBody — rendered messages carry the composer formatting', () => {
  it('renders bullet and ordered lists as real <ul>/<ol>/<li>', () => {
    const ul = mountBody('- one\n- two')
    expect(ul.findAll('ul > li').map((n) => n.text())).toEqual(['one', 'two'])

    const ol = mountBody('1. a\n2. b')
    expect(ol.findAll('ol > li').map((n) => n.text())).toEqual(['a', 'b'])
    expect(ol.find('ul').exists()).toBe(false)
  })

  it('renders inline code as <code> and fenced blocks as <pre><code>', () => {
    const inline = mountBody('run `npm test` now')
    expect(inline.find('p > code').text()).toBe('npm test')

    const block = mountBody('```\nconst x = 1\nconst y = 2\n```')
    expect(block.find('pre > code').text()).toBe('const x = 1\nconst y = 2')
  })

  it('renders blockquotes as <blockquote> with inner paragraphs', () => {
    const wrapper = mountBody('> wise words')
    expect(wrapper.find('blockquote > p').text()).toBe('wise words')
  })

  it('renders bold / italic / strike as semantic elements', () => {
    const wrapper = mountBody('a **b** *i* ~~s~~')
    expect(wrapper.find('strong').text()).toBe('b')
    expect(wrapper.find('em').text()).toBe('i')
    expect(wrapper.find('s').text()).toBe('s')
  })

  it('keeps @mentions, #channels, and URLs as text inside formatted blocks', () => {
    const wrapper = mountBody('- ping @Dana in #general: https://example.test')
    expect(wrapper.find('li').text()).toBe('ping @Dana in #general: https://example.test')
  })

  it('applies the detected dir on the message-text root (RTL, ENG-175)', () => {
    const wrapper = mountBody('- سلام', 'markdown', 'rtl')
    const root = wrapper.get('[data-testid="message-text"]')
    expect(root.attributes('dir')).toBe('rtl')
    expect(wrapper.find('li').text()).toBe('سلام')
  })

  it('never turns hostile message text into markup (XSS) — markdown format', () => {
    const payload = '<img src=x onerror="window.__pwned=1"> **<b>bold</b>**'
    const wrapper = mountBody(payload)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('b').exists()).toBe(false)
    // The angle-bracket text survives as literal characters (inside <strong>).
    expect(wrapper.text()).toContain('<img src=x onerror="window.__pwned=1">')
    expect(wrapper.find('strong').text()).toBe('<b>bold</b>')
  })

  it('renders format:"plain" text verbatim — no markdown parsing at all', () => {
    const wrapper = mountBody('- not a list **not bold**', 'plain')
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.find('strong').exists()).toBe(false)
    expect(wrapper.get('[data-testid="message-text"]').text()).toBe('- not a list **not bold**')
  })
})

describe('MessageItem — formatted messages in the message list', () => {
  it('renders a markdown message rich under the message-text testid', () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ text: '- first\n- second\n> quote\n`code`' }) },
    })
    const body = wrapper.get('[data-testid="message-text"]')
    expect(body.findAll('li').map((n) => n.text())).toEqual(['first', 'second'])
    expect(body.find('blockquote').text()).toBe('quote')
    expect(body.find('code').text()).toBe('code')
  })

  it('detects RTL from the raw source and sets dir on a formatted message', () => {
    const wrapper = mount(MessageItem, {
      props: { message: makeMessage({ text: '- مرحبا بالجميع' }) },
    })
    expect(wrapper.get('[data-testid="message-text"]').attributes('dir')).toBe('rtl')
  })

  it('still renders mention text inside a formatted message', () => {
    const wrapper = mount(MessageItem, {
      props: {
        message: makeMessage({ text: '1. ask @Dana', mention_user_ids: ['u_dana'] }),
      },
    })
    expect(wrapper.get('[data-testid="message-text"]').find('li').text()).toBe('ask @Dana')
  })
})
