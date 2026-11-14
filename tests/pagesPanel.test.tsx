// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Canvas } from '../shared/types'

vi.mock('../src/lib/pageEdits', () => ({
  savePages: () => Promise.resolve(),
  duplicatePage: () => Promise.resolve(),
  moveFramesToPage: () => Promise.resolve(),
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { PagesPanel } = await import('../src/components/PagesPanel')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* a library of 600 pages: a filter, and only the rows in view */

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  const pages = Array.from({ length: 600 }, (_, i) => ({
    id: `p${i}`,
    name: i === 437 ? 'Inputs & forms' : `Page ${i}`,
  }))
  useStore.setState({
    canvas: {
      id: 'lib',
      name: 'Library',
      frames: [],
      pages,
      createdAt: 1,
      updatedAt: 1,
      library: { description: '', visibility: 'private', items: 0, variants: 0, index: null, rulesVersion: 1 },
    } as Canvas,
    activePageId: 'p0',
    selectedIds: [],
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<PagesPanel />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const rows = () => container.querySelectorAll('[data-page-id]')

it('renders under 80 rows of 600 pages', () => {
  expect(rows().length).toBeGreaterThan(0)
  expect(rows().length).toBeLessThan(80)
})

it('narrows the list with the filter', async () => {
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Filter pages"]')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, 'inputs')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect([...rows()].map((r) => r.textContent)).toEqual(['Inputs & forms'])
})
