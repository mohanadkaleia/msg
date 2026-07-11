// tests/unit/shell/SearchOverlay.spec.ts — ENG-127 message search. Proves the
// filter grammar resolves against REAL store data (in:#channel → stream_id,
// from:@name → user_id via the directory), the query is debounced into
// `client.search` with exactly the parsed params, results render channel/author/
// snippet with a SAFE highlight, Load more pages by the server cursor, and a
// click emits the jump. The XSS teeth are here too: a hit whose text/query carry
// markup must render as INERT escaped text — these tests FAIL if the snippet
// render ever switches to v-html.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SearchOverlay from '../../../src/components/shell/SearchOverlay.vue'
import { setWorkerClient } from '../../../src/composables/useWorkerClient'
import { newMessageId } from '../../../src/core'
import { useAuthStore } from '../../../src/stores/auth'
import { useWorkspaceStore } from '../../../src/stores/workspace'
import type { SearchHit } from '../../../src/worker'
import { FakeWorker } from './fakeWorker'

const DEBOUNCE = 250

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    message_id: newMessageId(),
    stream_id: 's_eng',
    author_user_id: 'u_sara',
    text: 'well hello there',
    created_seq: 10,
    rank: 1,
    thread_root_id: null,
    ...over,
  }
}

describe('SearchOverlay (ENG-127)', () => {
  let fake: FakeWorker

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    fake = new FakeWorker()
    fake.addStream({ stream_id: 's_eng', name: 'eng' })
    fake.addStream({ stream_id: 's_gen', name: 'general' })
    fake.addStream({ stream_id: 's_dm', name: 'Sara Chen', kind: 'dm' })
    fake.setDirectory(
      [
        { user_id: 'u_sara', display_name: 'Sara Chen' },
        { user_id: 'u_bob', display_name: 'Bob' },
      ],
      [],
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    setWorkerClient(undefined)
    document.body.innerHTML = ''
  })

  async function mountOverlay(): Promise<VueWrapper> {
    setWorkerClient(fake.client)
    await useWorkspaceStore().load()
    const wrapper = mount(SearchOverlay, { props: { open: true }, attachTo: document.body })
    await flushPromises()
    return wrapper
  }

  /** Type into the search input and let the debounce + request settle. */
  async function type(wrapper: VueWrapper, text: string): Promise<void> {
    await wrapper.get('[data-testid="search-input"]').setValue(text)
    vi.advanceTimersByTime(DEBOUNCE)
    await flushPromises()
  }

  it('parses in:#channel / from:@name and calls client.search with resolved ids', async () => {
    fake.queueSearch({ hits: [hit()], next_cursor: null })
    const wrapper = await mountOverlay()

    await type(wrapper, 'in:#eng from:@sara hello')

    expect(fake.searchSpy).toHaveBeenCalledTimes(1)
    expect(fake.searchSpy).toHaveBeenCalledWith({
      q: 'hello',
      in: 's_eng',
      from: 'u_sara',
      limit: 20,
    })
  })

  it('debounces: rapid keystrokes collapse into one search call', async () => {
    fake.queueSearch({ hits: [], next_cursor: null })
    const wrapper = await mountOverlay()

    await wrapper.get('[data-testid="search-input"]').setValue('hel')
    vi.advanceTimersByTime(100)
    await wrapper.get('[data-testid="search-input"]').setValue('hello')
    vi.advanceTimersByTime(DEBOUNCE)
    await flushPromises()

    expect(fake.searchSpy).toHaveBeenCalledTimes(1)
    expect(fake.searchSpy).toHaveBeenCalledWith({ q: 'hello', limit: 20 })
  })

  it('is the unified "Search anything" modal with a borderless input (ENG-152)', async () => {
    const wrapper = await mountOverlay()

    // Unified identity: the modal input carries the top-bar's "Search anything…"
    // placeholder (one search surface, one language).
    const input = wrapper.get('[data-testid="search-input"]')
    expect(input.attributes('placeholder')).toBe('Search anything…')
    expect(wrapper.get('[data-testid="search-prompt"]').text()).toContain('Search anything')

    // No inner border/box on the input — the modal CARD is the only border. The
    // focus-visible variant out-specifies the global :focus-visible accent
    // outline (a text input ALWAYS matches :focus-visible when focused).
    const classes = input.classes()
    expect(classes).toContain('outline-none')
    expect(classes).toContain('focus-visible:outline-none')
    expect(classes.some((c) => c.startsWith('border') || c.includes('ring-'))).toBe(false)
  })

  it('shows a prompt (and never searches) while the free-text q is empty', async () => {
    const wrapper = await mountOverlay()

    expect(wrapper.find('[data-testid="search-prompt"]').exists()).toBe(true)

    // Filters alone are not a query either.
    await type(wrapper, 'in:#eng ')
    expect(wrapper.find('[data-testid="search-prompt"]').exists()).toBe(true)
    expect(fake.searchSpy).not.toHaveBeenCalled()
  })

  it('blocks the search and says so when an in:/from: filter resolves to nothing', async () => {
    const wrapper = await mountOverlay()

    await type(wrapper, 'in:#nope hello')
    expect(fake.searchSpy).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="search-filter-hint"]').text()).toContain('#nope')
  })

  it('strips unsupported before:/after: tokens and surfaces an honest hint', async () => {
    fake.queueSearch({ hits: [hit()], next_cursor: null })
    const wrapper = await mountOverlay()

    await type(wrapper, 'before:2026-01-01 hello')

    // The token is NOT sent (created_seq is not a date — no fake mapping) …
    expect(fake.searchSpy).toHaveBeenCalledWith({ q: 'hello', limit: 20 })
    // … and the UI says so instead of silently ignoring it.
    expect(wrapper.get('[data-testid="search-unsupported-hint"]').text()).toContain(
      'before:2026-01-01',
    )
  })

  it('renders channel, author, snippet with <mark>-wrapped terms, and a timestamp', async () => {
    const h = hit({ text: 'well hello there' })
    fake.queueSearch({ hits: [h], next_cursor: null })
    const wrapper = await mountOverlay()

    await type(wrapper, 'hello')

    const result = wrapper.get('[data-testid="search-result"]')
    expect(result.text()).toContain('# eng')
    expect(result.text()).toContain('Sara Chen')
    expect(result.text()).toContain('well hello there')

    // The highlight wraps ONLY the matched substring.
    const marks = result.findAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.text()).toBe('hello')
  })

  it('labels a DM hit with the DM name (no # prefix)', async () => {
    fake.queueSearch({ hits: [hit({ stream_id: 's_dm' })], next_cursor: null })
    const wrapper = await mountOverlay()

    await type(wrapper, 'hello')
    const label = wrapper.get('[data-testid="search-result"]').text()
    expect(label).toContain('Sara Chen')
    expect(label).not.toContain('# Sara Chen')
  })

  // ENG-171: real DM streams are server-named null — the label must resolve to
  // the OTHER participant's directory name via `dm_user_ids` (like the sidebar),
  // never the raw `s_…` stream id it printed before.
  it('resolves a name-less DM hit label from its participants, not the raw id (ENG-171)', async () => {
    fake.addStream({ stream_id: 's_dm2', kind: 'dm', dm_user_ids: ['u_me', 'u_sara'] })
    // Author is Bob so the 'Sara Chen' assertion can only come from the DM label.
    fake.queueSearch({
      hits: [hit({ stream_id: 's_dm2', author_user_id: 'u_bob' })],
      next_cursor: null,
    })
    const wrapper = await mountOverlay()
    useAuthStore().myUserId = 'u_me'
    await flushPromises()

    await type(wrapper, 'hello')
    const label = wrapper.get('[data-testid="search-result"]').text()
    expect(label).toContain('Sara Chen')
    expect(label).toContain('Bob')
    expect(label).not.toContain('s_dm2')
  })

  // ENG-171: a hit author resolves through the shared directory lookup
  // (`displayNameOf`) — never the raw `u_…` id — with an honest raw-id
  // fallback for an author not (yet) in the directory.
  it('resolves the author via the directory, raw-id fallback when absent (ENG-171)', async () => {
    fake.queueSearch({
      hits: [hit({ author_user_id: 'u_bob' }), hit({ author_user_id: 'u_ghost' })],
      next_cursor: null,
    })
    const wrapper = await mountOverlay()

    await type(wrapper, 'hello')
    const rows = wrapper.findAll('[data-testid="search-result"]')
    expect(rows[0]!.text()).toContain('Bob')
    expect(rows[0]!.text()).not.toContain('u_bob')
    expect(rows[1]!.text()).toContain('u_ghost')
  })

  it('keeps the SERVER order of hits (never re-sorts by rank tab-side)', async () => {
    fake.queueSearch({
      hits: [hit({ text: 'hello first', rank: 0.1 }), hit({ text: 'hello second', rank: 0.9 })],
      next_cursor: null,
    })
    const wrapper = await mountOverlay()

    await type(wrapper, 'hello')
    const rows = wrapper.findAll('[data-testid="search-result"]')
    expect(rows[0]!.text()).toContain('hello first')
    expect(rows[1]!.text()).toContain('hello second')
  })

  it('shows the empty state when a settled search has no hits', async () => {
    fake.queueSearch({ hits: [], next_cursor: null })
    const wrapper = await mountOverlay()

    await type(wrapper, 'zzz')
    expect(wrapper.find('[data-testid="search-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="search-result"]').exists()).toBe(false)
  })

  it('pages with Load more using the server cursor and appends the next page', async () => {
    fake.queueSearch({ hits: [hit({ text: 'hello one' })], next_cursor: 'c1' })
    fake.queueSearch({ hits: [hit({ text: 'hello two' })], next_cursor: null })
    const wrapper = await mountOverlay()

    await type(wrapper, 'hello')
    expect(wrapper.findAll('[data-testid="search-result"]')).toHaveLength(1)

    await wrapper.get('[data-testid="search-load-more"]').trigger('click')
    await flushPromises()

    expect(fake.searchSpy).toHaveBeenCalledTimes(2)
    expect(fake.searchSpy).toHaveBeenLastCalledWith({ q: 'hello', limit: 20, cursor: 'c1' })
    const rows = wrapper.findAll('[data-testid="search-result"]')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.text()).toContain('hello two')
    // The cursor is exhausted → the affordance disappears.
    expect(wrapper.find('[data-testid="search-load-more"]').exists()).toBe(false)
  })

  it('emits jump with the hit stream + message ids from the result action', async () => {
    const h = hit()
    fake.queueSearch({ hits: [h], next_cursor: null })
    const wrapper = await mountOverlay()

    await type(wrapper, 'hello')
    await wrapper.get('[data-testid="search-jump"]').trigger('click')

    expect(wrapper.emitted('jump')).toEqual([['s_eng', h.message_id]])
  })

  it('closes on Escape and on backdrop click', async () => {
    const wrapper = await mountOverlay()

    await wrapper.get('[data-testid="search-input"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)

    await wrapper.get('[data-testid="search-overlay"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  // -- XSS TEETH (critical): markup in hit text / query stays INERT ------------
  // These fail if anyone renders the snippet via v-html or builds an HTML string
  // from the text or the query: the payload would become a live element.

  it('renders markup in a hit text as escaped text, never as elements', async () => {
    const payload = 'hello <img src=x onerror=alert(1)> bye'
    fake.queueSearch({ hits: [hit({ text: payload })], next_cursor: null })
    const wrapper = await mountOverlay()

    await type(wrapper, 'hello')

    // No element was created from the message text …
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('img[onerror]').exists()).toBe(false)
    expect(document.querySelector('img[onerror]')).toBeNull()
    // … the raw markup is visible as ESCAPED text …
    const result = wrapper.get('[data-testid="search-result"]')
    expect(result.text()).toContain('<img src=x onerror=alert(1)>')
    // … and <mark> wraps ONLY the matched substring.
    const marks = result.findAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.text()).toBe('hello')
  })

  it('renders a markup-shaped QUERY as an escaped, marked substring — no injection', async () => {
    const payload = 'try <script>alert(1)</script> now'
    fake.queueSearch({ hits: [hit({ text: payload })], next_cursor: null })
    const wrapper = await mountOverlay()

    await type(wrapper, '<script>')

    expect(wrapper.find('script').exists()).toBe(false)
    expect(document.querySelector('script')).toBeNull()
    const result = wrapper.get('[data-testid="search-result"]')
    expect(result.text()).toContain('<script>alert(1)</script>')
    const marks = result.findAll('mark')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.text()).toBe('<script>')
  })
})
