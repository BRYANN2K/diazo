// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import { OTP_RESULT } from './libraryFindFixtures'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* "From library" on a block: Update shows only when its item moved on, and
   replaces the block in place as one save (the undo step). */

let currentRev = 3
const libraryRevs = vi.fn(async () => ({ revs: [{ libraryId: 'lib1', itemId: 'cp.b', rev: currentRev }] }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', () => ({
  api: {
    libraryRevs: () => libraryRevs(),
    libraryItem: async () => ({ item: { ...OTP_RESULT.hits[0]!.item, id: 'cp.b', rev: currentRev } }),
  },
}))
vi.mock('../src/lib/findSnapshot', () => ({
  snapshotLibraryItem: async () => ({
    html: '<em>new</em>',
    ancestors: [],
    rootClasses: [],
    rootAttrs: [],
    rules: [],
    keyframes: [],
    fontFaces: [],
    vars: [],
    inherited: [],
    found: true,
    scripted: false,
  }),
}))
const saveFrameHtml = vi.fn()
vi.mock('../src/lib/layerEdits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/layerEdits')>()),
  saveFrameHtml: (frame: Frame, html: string) => saveFrameHtml(frame, html),
}))

const { useStore } = await import('../src/lib/store')
const { LibrarySourceSection } = await import('../src/components/library/LibrarySourceSection')

const HTML =
  '<!doctype html><html><body><main data-doop-id="mmmmmm"><div data-doop-ref="cp.b" data-doop-ref-lib="lib1" data-doop-ref-rev="1" data-doop-id="bbbbbb"><span data-doop-id="ssssss">old</span></div></main><footer data-doop-id="ffffff">f</footer></body></html>'
const frame = { id: 'f1', canvasId: 'c', name: 'F', html: HTML } as Frame

let root: Root
let host: HTMLDivElement
async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<LibrarySourceSection frame={frame} selector='[data-doop-id="ssssss"]' />))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  libraryRevs.mockClear()
  saveFrameHtml.mockClear()
  useStore.setState({ canvas: { id: 'c', name: 'C', role: 'edit', frames: [frame] } as unknown as Canvas })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const update = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Update')

describe('From library', () => {
  it('offers Update only when the item moved on, asking once', async () => {
    currentRev = 1
    await mount()
    expect(host.textContent).toContain('cp.b')
    expect(update()).toBeUndefined()
    expect(libraryRevs).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    host.remove()
    currentRev = 3
    await mount()
    expect(update()).toBeDefined()
  })

  it('replaces the block in place, as one save', async () => {
    currentRev = 3
    await mount()
    await act(async () => update()!.click())
    const confirm = [...document.querySelectorAll('[data-slot="confirm-dialog"] button')].find(
      (b) => b.textContent === 'Update',
    ) as HTMLButtonElement
    await act(async () => confirm.click())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(saveFrameHtml).toHaveBeenCalledTimes(1)
    const html = saveFrameHtml.mock.calls[0]![1] as string
    expect(html).toContain('data-doop-ref-rev="3"')
    expect(html).toContain('data-doop-id="bbbbbb"')
    expect(html).toContain('<em>new</em>')
    expect(html.indexOf('bbbbbb')).toBeLessThan(html.indexOf('ffffff'))
  })
})
