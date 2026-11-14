// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LibraryPreview } from '../shared/library'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* "Turn into a library": the dry run's counts, then one button. */

const REPORT: LibraryPreview = {
  frames: 5,
  families: 3,
  variants: 2,
  scripted: 1,
  ignored: [{ frameId: 's', name: '§ Auth A — Log in', section: 'Auth/Log in' }],
  unreadable: [{ frameId: 'x', name: 'Broken', reason: 'no id could be read or assigned' }],
  duplicates: [],
  categories: [],
}
const previewLibrary = vi.fn(async (_canvasId: string, opts: { preset?: string } = {}) => ({
  preset: (opts.preset ?? 'sheets') as 'sheets' | 'blank',
  rules: {},
  preview: opts.preset === 'blank' ? { ...REPORT, variants: 0 } : REPORT,
}))
const createLibrary = vi.fn(async () => ({}))
vi.mock('../src/lib/api', () => ({
  api: {
    previewLibrary: (id: string, opts?: { preset?: string }) => previewLibrary(id, opts),
    createLibrary: (...args: unknown[]) => createLibrary(...(args as [])),
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

const counts = () => document.querySelector('[data-testid="library-preview-counts"]')?.textContent ?? ''

it('shows the dry run, with the detected preset', () => {
  expect(previewLibrary).toHaveBeenCalledWith('c1', {})
  expect(counts()).toContain('3 families')
  expect(counts()).toContain('2 variants')
  expect(counts()).toContain('1 frame ignored')
  expect(document.body.textContent).toContain('1 frame could not be read')
  expect(document.body.textContent).toContain('Detected from the frame names')
})

it('creates the library on confirm with the chosen preset', async () => {
  const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Turn into a library')!
  await act(async () => confirm.click())
  expect(createLibrary).toHaveBeenCalledWith('c1', { preset: 'sheets' })
  expect(onConverted).toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})
