import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ModalDialog from '../src/components/ModalDialog.vue'

// Teleported nodes never appear under the wrapper, so every assertion queries document.body.
function dialog(): HTMLElement {
  const node = document.body.querySelector<HTMLElement>('[role="dialog"]')
  if (!node) throw new Error('The dialog is not mounted')
  return node
}

afterEach(() => {
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

describe('modal dialog', () => {
  it('stays out of the document until it is opened', () => {
    mount(ModalDialog, { props: { open: false, title: 'Analysis trail' }, attachTo: document.body })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('labels itself and locks the page behind it while open', async () => {
    const wrapper = mount(ModalDialog, {
      props: { open: false, title: 'Analysis trail', description: 'Each role’s questions and governed SQL.' },
      attachTo: document.body,
    })
    await wrapper.setProps({ open: true })

    const node = dialog()
    expect(node.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(node.getAttribute('aria-labelledby')!)?.textContent).toBe('Analysis trail')
    expect(document.getElementById(node.getAttribute('aria-describedby')!)?.textContent).toContain('governed SQL')
    expect(document.body.style.overflow).toBe('hidden')

    await wrapper.setProps({ open: false })
    expect(document.body.style.overflow).toBe('')
  })

  // Regression: the listener is registered in the capture phase so an ancestor cannot swallow Escape.
  it('asks to close on Escape and on a backdrop click, but not on a click inside', async () => {
    const wrapper = mount(ModalDialog, { props: { open: false, title: 'Analysis trail' }, attachTo: document.body })
    await wrapper.setProps({ open: true })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(1)

    dialog().click()
    expect(wrapper.emitted('close')).toHaveLength(1)

    document.body.querySelector<HTMLElement>('.modal-scrim')!.click()
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('releases the scroll lock if it unmounts while still open', async () => {
    const wrapper = mount(ModalDialog, { props: { open: false, title: 'Analysis trail' }, attachTo: document.body })
    await wrapper.setProps({ open: true })
    expect(document.body.style.overflow).toBe('hidden')

    wrapper.unmount()
    expect(document.body.style.overflow).toBe('')
  })
})
