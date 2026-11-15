// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { CanvasFindResult } from '../shared/canvasFind'
import type { LibrarySearchResult } from '../shared/library'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The find bar's layout: three scopes in a segmented control (the page or
   every page under "This canvas"), results in sections, the side pane with
   its variant chips, the keyboard hints, and the empty and loading states. */

const searchLibraries = vi.fn<(q: { q?: string }) => Promise<LibrarySearchResult>>()
const findEverywhere = vi.fn<(q: string) => Promise<CanvasFindResult>>()
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', () => ({
  api: {
    searchLibraries: (q: { q?: string }) => searchLibraries(q),
    listLibraries: async () => ({ libraries: [] }),
    findInCanvas: async () => ({ hits: [], total: 0, frames: 0 }),
    findEverywhere: (q: string) => findEverywhere(q),
  },
}))
/* the live preview is FindPreview's own test; here it names what it frames */
vi.mock('../src/components/FindPreview', () => ({
  FindPreview: ({ focus, interactive }: { focus: { key: string }; interactive?: boolean }) => (
    <div data-testid="preview" data-focus={focus.key} data-interactive={interactive ? 'yes' : 'no'} />
  ),
}))
vi.mock('../src/lib/findInsert', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/findInsert')>()),
  insertLibraryItem: async () => null,
}))
vi.mock('../src/lib/navigate', () => ({ navigate: vi.fn() }))

const { useStore } = await import('../src/lib/store')
const { FindBar, resetFindLibrariesForTest } = await import('../src/components/FindBar')
const { OTP_RESULT, summary } = await import('./libraryFindFixtures')

let root: Root
let host: HTMLDivElement

const frame = (id: string, name: string, html: string, pageId = 'p1'): Frame =>
  ({ id, canvasId: 'c1', pageId, name, html, x: 0, y: 0, width: 400, height: 300 }) as Frame

function openCanvas(over: Partial<Canvas> = {}) {
  useStore.setState({
    canvas: {
      id: 'c1',
      name: 'Project',
      frames: [
        frame('hero', 'Hero', '<html><body><h1>Sign in</h1><p>Sign in with email</p></body></html>'),
        frame('sheet', 'cp.scb-otp-input — OTP', '<html><body><p>x</p></body></html>'),
      ],
      pages: [
        { id: 'p1', name: 'Page 1' },
        { id: 'p2', name: 'Page 2' },
      ],
      ...over,
    } as unknown as Canvas,
    activePageId: 'p1',
    selectedId: null,
    selectedIds: [],
    selectedElement: null,
    selectedElements: [],
  })
}

async function mount(mode: 'find' | 'replace' = 'find') {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<FindBar mode={mode} step={null} onClose={() => {}} />))
}

const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Find"]')!
const wait = (ms = 300) => act(async () => new Promise((r) => setTimeout(r, ms)))

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await wait()
}

async function key(k: string, opts: KeyboardEventInit = {}) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }))
  })
}

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.click()
  })
}

const segment = (label: string) =>
  [...host.querySelectorAll<HTMLElement>('[aria-label="Where to search"] [data-slot="segmented-item"]')].find(
    (b) => b.textContent === label,
  )

beforeEach(() => {
  resetFindLibrariesForTest()
  searchLibraries.mockReset()
  searchLibraries.mockResolvedValue(OTP_RESULT)
  findEverywhere.mockReset()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

describe('scopes', () => {
  it('offers This canvas, Library and All as one segmented control', async () => {
    openCanvas()
    await mount()
    const items = [...host.querySelectorAll('[data-slot="segmented-item"]')].map((b) => b.textContent)
    expect(items).toEqual(['This canvas', 'Library', 'All'])
    /* a canvas of several pages starts on every page of it */
    expect(segment('This canvas')!.getAttribute('data-state')).toBe('on')
    expect(button('All pages')!.getAttribute('data-state')).toBe('on')
  })

  it('narrows This canvas to the page, and keeps that pick when coming back', async () => {
    openCanvas()
    await mount()
    await click(button('This page'))
    await type('sign')
    /* the page's own matches, under their frame's name */
    expect(host.textContent).toContain('Hero')
    expect(host.querySelectorAll('mark')).toHaveLength(2)
    await click(segment('Library'))
    expect(host.textContent).not.toContain('This page')
    await click(segment('This canvas'))
    expect(button('This page')!.getAttribute('data-state')).toBe('on')
  })

  it('opens the replace line on the page, whatever the scope was', async () => {
    openCanvas({
      library: { description: '', visibility: 'private', items: 2, variants: 3, index: null, rulesVersion: 1 },
    } as Partial<Canvas>)
    await mount('replace')
    expect(host.querySelector('input[aria-label="Replace with"]')).not.toBeNull()
    expect(button('This page')!.getAttribute('data-state')).toBe('on')
  })
})

describe('results', () => {
  it('lists the canvases’ matches, then the library items, each under its heading', async () => {
    openCanvas({ pages: [{ id: 'p1', name: 'Page 1' }] } as Partial<Canvas>)
    findEverywhere.mockResolvedValue({
      hits: [
        {
          canvasId: 'lib1',
          canvasName: 'Design Library',
          frameId: 'sheet',
          pageId: 'p1',
          pageName: 'Page',
          frameName: 'cp.scb-otp-input — OTP',
          where: 'name',
          n: -1,
          before: '',
          text: 'otp',
          after: '',
          item: summary('cp.scb-otp-input', { label: 'OTP input' }),
        },
        {
          canvasId: 'c2',
          canvasName: 'Checkout',
          frameId: 'pay',
          pageId: 'p9',
          pageName: 'Flow',
          frameName: 'Payment',
          where: 'text',
          n: 0,
          before: 'enter the ',
          text: 'otp',
          after: ' code',
        },
      ],
      total: 2,
      frames: 2,
    })
    await mount()
    await type('otp')
    const sections = [...host.querySelectorAll('li[data-section]')].map((li) => li.getAttribute('data-section'))
    expect(sections).toEqual(['canvas', 'library'])
    const text = host.textContent ?? ''
    expect(text.indexOf('On canvases')).toBeLessThan(text.indexOf('Library items'))
    /* a library row names its kind and its category */
    const libraryRow = host.querySelector('li[data-section="library"]')!
    expect(libraryRow.querySelector('[data-slot="badge"]')!.textContent).toBe('cp')
    expect(libraryRow.textContent).toContain('Inputs & forms')
  })

  it('shows skeleton rows while the first answer is on its way, then says when nothing matched', async () => {
    openCanvas({
      library: { description: '', visibility: 'private', items: 2, variants: 3, index: null, rulesVersion: 1 },
    } as Partial<Canvas>)
    let answer: (r: LibrarySearchResult) => void = () => {}
    searchLibraries.mockReturnValue(new Promise((r) => (answer = r)))
    await mount()
    await type('zzz')
    expect(host.querySelector('[aria-busy]')).not.toBeNull()
    await act(async () => answer({ hits: [], total: 0, facets: { kind: [], category: [], source: [], tag: [] } }))
    expect(host.querySelector('[aria-busy]')).toBeNull()
    expect(host.textContent).toContain('Nothing matches “zzz”')
  })

  it('says what each scope searches before anything is typed', async () => {
    openCanvas()
    await mount()
    expect(host.textContent).toContain('Search the text and frame names of this canvas.')
  })
})

describe('the preview pane and the keyboard', () => {
  beforeEach(() =>
    openCanvas({
      library: { description: '', visibility: 'private', items: 2, variants: 3, index: null, rulesVersion: 1 },
    } as Partial<Canvas>),
  )

  it('shows the family live and interactive, and switches variant from its chips', async () => {
    await mount()
    await type('otp')
    const preview = () => host.querySelector<HTMLElement>('[data-testid="preview"]')!
    /* a family frames its first matched variant */
    expect(preview().dataset.focus).toBe('cp.scb-otp-input-dark')
    expect(preview().dataset.interactive).toBe('yes')
    await click(button('six'))
    expect(preview().dataset.focus).toBe('cp.scb-otp-input-six')
    /* the family opened in the list, on that variant */
    expect(host.textContent).toContain('cp.scb-otp-input-split')
  })

  it('opens and closes the variants with ⌥↩ and names the keys in the footer', async () => {
    await mount()
    await type('otp')
    expect(host.textContent).not.toContain('cp.scb-otp-input-six')
    await key('Enter', { altKey: true })
    expect(host.textContent).toContain('cp.scb-otp-input-six')
    await key('Enter', { altKey: true })
    expect(host.textContent).not.toContain('cp.scb-otp-input-six')
    const keys = [...host.querySelectorAll('kbd')].map((k) => k.textContent)
    expect(keys).toEqual(expect.arrayContaining(['↩', '⌥↩', '⌘C']))
  })

  it('offers Insert into the selected frame in the pane', async () => {
    useStore.setState({ selectedId: 'hero' })
    await mount()
    await type('otp')
    expect(button('Insert into “Hero”')).toBeDefined()
    expect([...host.querySelectorAll('kbd')].map((k) => k.textContent)).toContain('⇧↩')
  })
})
