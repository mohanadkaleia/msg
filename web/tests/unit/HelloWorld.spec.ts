import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import HelloWorld from '../../src/components/HelloWorld.vue'

describe('HelloWorld', () => {
  it('renders the msg prop', () => {
    const wrapper = mount(HelloWorld, { props: { msg: 'hello vitest' } })
    expect(wrapper.text()).toContain('hello vitest')
  })
})
