// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* "New library": three ways in; starting empty takes a name and starting
   categories, typed or suggested from one line, then opens the gallery. */

const api = {
  suggestLibraryCategories: vi.fn(async (_brief: string) => ({ categories: ['Components', 'Components/Buttons'] })),
  newLibrary: vi.fn(async (_input: unknown) => ({ id: 'newlib' })),
}
const navigate = vi.fn()
vi.mock('../src/lib/api', () => ({ api, ApiError: class extends Error {} }))
vi.mock('../src/lib/navigate', () => ({ navigate: (to: string) => navigate(to) }))

const { NewLibraryModal } = await import('../src/components/library/NewLibraryModal')

let root: Root
let host: HTMLDivElement
const onClose = vi.fn()
const onPath = vi.fn()

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<NewLibraryModal onClose={onClose} onPath={onPath} />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!

/** Type into a React-controlled field. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  await act(async () => el.dispatchEvent(new Event('input', { bubbles: true })))
}

it('offers the three ways in', async () => {
  const rows = document.querySelector('[data-testid="new-library-paths"]')!.textContent
  expect(rows).toContain('Start empty')
  expect(rows).toContain('From a canvas')
  expect(rows).toContain('Organise with AI…')
  await act(async () => button('From a canvas').click())
  expect(onPath).toHaveBeenCalledWith('canvas')
})

it('starts empty with suggested categories and opens the gallery', async () => {
  await act(async () => button('Start empty').click())
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input')]
  await type(inputs[0]!, 'Fresh library')
  await type(inputs[2]!, 'Marketing sites for AI start-ups')
  await act(async () => button('Suggest with AI').click())
  expect(api.suggestLibraryCategories).toHaveBeenCalledWith('Marketing sites for AI start-ups')
  const area = document.querySelector<HTMLTextAreaElement>('[data-testid="new-library-categories"]')!
  expect(area.value).toBe('Components\nComponents/Buttons')
  await act(async () => button('Create library').click())
  expect(api.newLibrary).toHaveBeenCalledWith({
    name: 'Fresh library',
    description: 'Marketing sites for AI start-ups',
    categories: ['Components', 'Components/Buttons'],
  })
  expect(navigate).toHaveBeenCalledWith('/l/newlib')
})
