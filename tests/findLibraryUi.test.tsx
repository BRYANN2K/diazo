// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { LibrarySearchResult } from '../shared/library'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* ⌘F's Library scope against a mocked API: families from the index, their
   variants under them, insert into the selected frame, ⇧ to go. */

const searchLibraries = vi.fn<(q: { q?: string }) => Promise<LibrarySearchResult>>()
const listLibraries = vi.fn(async () => ({ libraries: [] as unknown[] }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', () => ({
  api: {
    searchLibraries: (q: { q?: string }) => searchLibraries(q),
    listLibraries: () => listLibraries(),
    findInCanvas: async () => ({ hits: [], total: 0, frames: 0 }),
    findEverywhere: async () => ({ hits: [], total: 0, frames: 0 }),
  },
}))
vi.mock('../src/components/FindPreview', () => ({ FindPreview: () => null }))
const insertLibraryItem = vi.fn(async (_opts: unknown) => null)
vi.mock('../src/lib/findInsert', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/findInsert')>()),
  insertLibraryItem: (opts: unknown) => insertLibraryItem(opts),
}))
const navigate = vi.fn()
vi.mock('../src/lib/navigate', () => ({ navigate: (to: string) => navigate(to) }))

const { useStore } = await import('../src/lib/store')
const { FindBar, resetFindLibrariesForTest } = await import('../src/components/FindBar')
const { OTP_RESULT } = await import('./libraryFindFixtures')

let root: Root
let host: HTMLDivElement

const frame = (id: string, name: string): Frame =>
  ({
    id,
    canvasId: 'c1',
    pageId: 'p1',
    name,
    html: '<html><body><p>x</p></body></html>',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  }) as Frame

function openCanvas(over: Partial<Canvas>) {
  useStore.setState({
    canvas: {
      id: 'c1',
      name: 'Design Library',
      frames: [frame('target', 'Login'), frame('sheet', 'cp.scb-otp-input — OTP')],
      pages: [{ id: 'p1', name: 'Page' }],
      ...over,
    } as unknown as Canvas,
    activePageId: 'p1',
    selectedId: null,
    selectedIds: [],
    selectedElement: null,
    selectedElements: [],
  })
}

async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<FindBar mode="find" step={null} onClose={() => {}} />))
}

const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Find"]')!

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200))
  })
}

async function key(k: string, opts: KeyboardEventInit = {}) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }))
  })
}

beforeEach(() => {
  resetFindLibrariesForTest()
  searchLibraries.mockReset()
  searchLibraries.mockResolvedValue(OTP_RESULT)
  insertLibraryItem.mockClear()
  navigate.mockClear()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

describe('the Library scope', () => {
  it('is the default on a library canvas and lists one row per family', async () => {
    openCanvas({
      library: { description: '', visibility: 'private', items: 2, variants: 3, index: null, rulesVersion: 1 },
    })
    await mount()
    await type('otp')
    expect(searchLibraries).toHaveBeenCalledWith(expect.objectContaining({ q: 'otp' }))
    const text = host.textContent ?? ''
    expect(text).toContain('cp.scb-otp-input')
    expect(text).toContain('3 variants')
    expect(text).not.toContain('cp.scb-otp-input-six')
  })

  it('walks into the variants with ↓ and inserts the pointed one with ↩', async () => {
    openCanvas({
      library: { description: '', visibility: 'private', items: 2, variants: 3, index: null, rulesVersion: 1 },
    })
    useStore.setState({ selectedId: 'target' })
    await mount()
    await type('otp')
    const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Show what matched inside"]')!
    await act(async () => expand.click())
    expect(host.textContent).toContain('cp.scb-otp-input-six')
    await key('ArrowDown')
    await key('ArrowDown')
    await key('Enter')
    expect(insertLibraryItem).toHaveBeenCalledWith(
      expect.objectContaining({ sourceFrameId: 'sheet', focus: 'cp.scb-otp-input-six', ref: 'cp.scb-otp-input-six' }),
    )
  })

  it('goes on ⇧↩ instead of inserting', async () => {
    openCanvas({ id: 'project', library: undefined })
    useStore.setState({ selectedId: 'target' })
    listLibraries.mockResolvedValueOnce({ libraries: [{ id: 'lib1' }] })
    await mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    await type('otp')
    await key('Enter', { shiftKey: true })
    expect(insertLibraryItem).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/c/lib1?frame=sheet')
  })

  it('makes no insert from a canvas only named like a library', async () => {
    openCanvas({ library: undefined, name: 'Design Library' })
    useStore.setState({
      selectedId: 'target',
      canvas: { ...useStore.getState().canvas!, pages: [{ id: 'p1', name: 'Page' }] } as Canvas,
    })
    await mount()
    await type('otp')
    /* the default scope is not Library: no library search was made */
    expect(searchLibraries).not.toHaveBeenCalled()
    await key('Enter')
    expect(insertLibraryItem).not.toHaveBeenCalled()
  })
})
