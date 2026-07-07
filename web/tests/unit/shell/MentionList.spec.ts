import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import MentionList from '../../../src/components/shell/composer/MentionList.vue'
import { filterMentions, type MentionItem } from '../../../src/components/shell/composer/mentions'

const users: MentionItem[] = [
  { id: 'u_ana', label: 'Ana', kind: 'user' },
  { id: 'u_ann', label: 'Annie', kind: 'user' },
  { id: 'u_bob', label: 'Bob', kind: 'user' },
]
const channels: MentionItem[] = [{ id: 's_gen', label: 'general', kind: 'channel' }]

describe('composer/mentions — filterMentions (pure, zero network)', () => {
  it('filters by kind and case-insensitive substring, prefix-first', () => {
    const out = filterMentions([...users, ...channels], 'an', 'user')
    expect(out.map((i) => i.label)).toEqual(['Ana', 'Annie'])
  })

  it('excludes the other kind entirely', () => {
    expect(filterMentions([...users, ...channels], 'gen', 'user')).toEqual([])
    expect(filterMentions([...users, ...channels], 'gen', 'channel').map((i) => i.id)).toEqual([
      's_gen',
    ])
  })

  it('returns the whole kind on an empty query', () => {
    expect(filterMentions(users, '', 'user')).toHaveLength(3)
  })
})

interface ListVm {
  onKeyDown: (e: KeyboardEvent) => boolean
}

describe('MentionList — arrow/Enter selection', () => {
  it('navigates with arrows and commits the highlighted item on Enter', () => {
    const command = vi.fn()
    const wrapper = mount(MentionList, {
      props: { items: [...users], command },
    })
    const vm = wrapper.vm as unknown as ListVm

    // Down twice → third item (Bob), Enter commits it.
    expect(vm.onKeyDown({ key: 'ArrowDown' } as KeyboardEvent)).toBe(true)
    vm.onKeyDown({ key: 'ArrowDown' } as KeyboardEvent)
    expect(vm.onKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(true)

    expect(command).toHaveBeenCalledWith({ id: 'u_bob', label: 'Bob' })
  })

  it('wraps selection and commits the first item by default', () => {
    const command = vi.fn()
    const wrapper = mount(MentionList, { props: { items: [...users], command } })
    const vm = wrapper.vm as unknown as ListVm

    // Up from index 0 wraps to the last item.
    vm.onKeyDown({ key: 'ArrowUp' } as KeyboardEvent)
    vm.onKeyDown({ key: 'Enter' } as KeyboardEvent)
    expect(command).toHaveBeenCalledWith({ id: 'u_bob', label: 'Bob' })
  })

  it('commits on click without any keyboard nav', async () => {
    const command = vi.fn()
    const wrapper = mount(MentionList, { props: { items: [...users], command } })
    await wrapper.findAll('[data-testid="mention-option"]')[1]!.trigger('mousedown')
    expect(command).toHaveBeenCalledWith({ id: 'u_ann', label: 'Annie' })
  })
})
