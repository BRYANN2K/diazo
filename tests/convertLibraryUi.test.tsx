// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LibraryPreview } from '../shared/library'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* "Turn into a library" in three steps: the preset, the report, the
   proposed categories (editable), then one button. */

const REPORT: LibraryPreview = {
  frames: 5,
  families: 3,
  variants: 2,
  scripted: 1,
  ignored: [{ frameId: 's', name: '§ Auth A — Log in', section: 'Auth/Log in' }],
  unreadable: [{ frameId: 'x', name: 'Broken', reason: 'no id could be read or assigned' }],
  duplicates: [],
  categories: [],
  taxonomy: {
    kinds: [{ id: 'bk', label: 'Blocks', insertable: true }],
    sources: [{ id: 'scb', label: 'scb' }],
    categories: [{ path: 'Auth/Log in' }, { path: 'Inputs & forms' }],
  },
}
const previewLibrary = vi.fn(async (_canvasId: string, opts: { preset?: string } = {}) => ({
  preset: (opts.preset ?? 'sheets') as 'sheets' | 'blank',
  rules: {},
  preview: opts.preset === 'blank' ? { ...REPORT, variants: 0 } : REPORT,
}))
const createLibrary = vi.fn(async (_canvasId: string, _opts: unknown) => ({}))
vi.mock('../src/lib/api', () => ({
  api: {
    previewLibrary: (id: string, opts?: { preset?: string }) => previewLibrary(id, opts),
    createLibrary: (id: string, opts: unknown) => createLibrary(id, opts),
  },
}))

const { ConvertToLibraryModal } = await import('../src/components/library/ConvertToLibraryModal')

let root: Root
let host: HTMLDivElement
const onClose = vi.fn()
const onConverted = vi.fn()

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root.render(<ConvertToLibraryModal canvasId="c1" onClose={onClose} onConverted={onConverted} />),
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!
const click = (text: string) => act(async () => button(text).click())
const counts = () => document.querySelector('[data-testid="library-preview-counts"]')?.textContent ?? ''

it('shows the dry run with the detected preset first', () => {
  expect(previewLibrary).toHaveBeenCalledWith('c1', {})
  expect(document.body.textContent).toContain('Step 1 of 3')
  expect(counts()).toContain('3 families')
  expect(counts()).toContain('2 variants')
  expect(document.body.textContent).toContain('Detected from the frame names')
})

it('walks to the report, then to the categories, and applies them edited', async () => {
  await click('Next')
  expect(document.body.textContent).toContain('Step 2 of 3')
  expect(document.body.textContent).toContain('Unreadable (1)')
  await click('Next')
  expect(document.body.textContent).toContain('Step 3 of 3')
  const fields = document.querySelectorAll<HTMLInputElement>('[data-testid="library-categories"] input')
  expect([...fields].map((f) => f.value)).toEqual(['Auth/Log in', 'Inputs & forms'])
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove this category"]')!.click())
  await click('Turn into a library')
  expect(createLibrary).toHaveBeenCalledWith('c1', {
    preset: 'sheets',
    taxonomy: { ...REPORT.taxonomy, categories: [{ path: 'Inputs & forms' }] },
  })
  expect(onConverted).toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})
