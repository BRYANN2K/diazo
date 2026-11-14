// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ImportReport } from '../shared/library'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* "Add to library…" when the library already has it: where it is, then
   Open, Import anyway or Add as a variant. */

const REPORT: ImportReport = {
  frames: [],
  totals: { frames: 0, items: 0, variants: 0, ignored: 0, drafts: 0, findings: 0 },
  duplicates: [
    {
      frameId: 'f1',
      name: 'AI SDK UI',
      matches: [
        {
          libraryId: 'lib1',
          libraryName: 'Design Library',
          itemId: 'bk.ai-sdk-ui',
          name: 'AI SDK UI',
          category: 'Sections/Chat',
          reason: 'same-url',
          score: 1,
          url: '/l/lib1/i/bk.ai-sdk-ui',
        },
      ],
    },
  ],
}

const importToLibrary = vi.fn(async (_id: string, input: { dryRun?: boolean }) => ({
  report: input.dryRun ? REPORT : { ...REPORT, duplicates: [] },
  applied: input.dryRun ? [] : [{ frameId: 'f1', libraryFrameId: 'copy' }],
}))
const navigate = vi.fn()
vi.mock('../src/lib/api', () => ({
  api: {
    listLibraries: async () => ({ libraries: [{ id: 'lib1', name: 'Design Library', role: 'manage' }] }),
    getLibraryDetail: async () => ({ taxonomy: { kinds: [], sources: [], categories: [] } }),
    importToLibrary: (id: string, input: { dryRun?: boolean }) => importToLibrary(id, input),
  },
}))
vi.mock('../src/lib/navigate', () => ({ navigate: (to: string) => navigate(to) }))

const { AddToLibraryModal } = await import('../src/components/library/AddToLibraryModal')

let root: Root
let host: HTMLDivElement
const onClose = vi.fn()

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<AddToLibraryModal frameIds={['f1']} onClose={onClose} />))
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!

it('says where it already is and offers the three ways on', async () => {
  const box = document.querySelector('[data-testid="add-duplicates"]')!.textContent
  expect(box).toContain('already in Design Library → Sections/Chat: AI SDK UI')
  expect(box).toContain('same page')
  expect(button('Add').disabled).toBe(true)
  await act(async () => button('Open').click())
  expect(navigate).toHaveBeenCalledWith('/l/lib1/i/bk.ai-sdk-ui')
  await act(async () => button('Add as a variant').click())
  expect(importToLibrary).toHaveBeenLastCalledWith('lib1', { frameIds: ['f1'], asVariantOf: 'bk.ai-sdk-ui' })
  await act(async () => button('Import anyway').click())
  expect(importToLibrary).toHaveBeenLastCalledWith('lib1', { frameIds: ['f1'], force: true })
})
