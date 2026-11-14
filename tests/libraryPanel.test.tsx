// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { LibraryListEntry } from '../shared/library'
import { OTP_RESULT } from './libraryFindFixtures'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The Layers panel's Library tab: the remembered library, click to insert
   into the selected frame, ⇧ click to open the item; no iframe. */

const entry = (id: string): LibraryListEntry => ({
  id,
  name: `Library ${id}`,
  library: { description: '', visibility: 'private', items: 1, variants: 3, index: null, rulesVersion: 1 },
  role: 'read',
  workspaceId: null,
  listed: false,
})
const libraryItems = vi.fn(async (_id: string, _q: unknown) => OTP_RESULT)
const insertLibraryItem = vi.fn(async (_opts: unknown) => null)
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', () => ({
  api: {
    listLibraries: async () => ({ libraries: [entry('lib1'), entry('lib2')] }),
    libraryItems: (id: string, q: unknown) => libraryItems(id, q),
  },
}))
vi.mock('../src/lib/findInsert', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/findInsert')>()),
  insertLibraryItem: (opts: unknown) => insertLibraryItem(opts),
}))
const navigate = vi.fn()
vi.mock('../src/lib/navigate', () => ({ navigate: (to: string) => navigate(to) }))

const { useStore } = await import('../src/lib/store')
const { LibraryPanel, PANEL_STORAGE_KEY } = await import('../src/components/library/LibraryPanel')

let root: Root
let host: HTMLDivElement

async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<LibraryPanel />))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200))
  })
}

beforeEach(() => {
  libraryItems.mockClear()
  insertLibraryItem.mockClear()
  navigate.mockClear()
  useStore.setState({
    canvas: {
      id: 'proj',
      name: 'Project',
      createdAt: 1,
      updatedAt: 1,
      role: 'edit',
      pages: [{ id: 'p1', name: 'Page' }],
      frames: [{ id: 'target', canvasId: 'proj', pageId: 'p1', name: 'Login', html: '<body></body>' } as Frame],
    } as Canvas,
    selectedId: 'target',
    selectedIds: ['target'],
    selectedElement: null,
    selectedElements: [],
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  localStorage.clear()
})

const tile = () => host.querySelector<HTMLElement>('[data-item-id="cp.scb-otp-input"]')!

describe('the Library tab', () => {
  it('opens on the library picked last time', async () => {
    localStorage.setItem(PANEL_STORAGE_KEY, 'lib2')
    await mount()
    expect(libraryItems).toHaveBeenCalledWith('lib2', expect.anything())
    expect(host.querySelector('iframe')).toBeNull()
  })

  it('inserts into the selected frame on click', async () => {
    await mount()
    await act(async () => tile().click())
    expect(insertLibraryItem).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: 'cp.scb-otp-input',
        libraryId: 'lib1',
        target: expect.objectContaining({ at: null }),
      }),
    )
  })

  it('opens the item on ⇧ click', async () => {
    await mount()
    await act(async () => tile().dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
    expect(insertLibraryItem).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/l/lib1/i/cp.scb-otp-input?from=proj&frame=target')
  })
})
