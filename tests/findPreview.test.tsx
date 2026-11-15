// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The ⌘F preview runs the item live: its scripts and animations kept, the
   pointer let in when interactive, a library frame read through the library
   when it cannot be opened as a frame, and paused while off screen. */

const frame = vi.fn(async (_id: string) => {
  throw new Error('404')
})
const libraryItemHtml = vi.fn(async (_lib: string, _item: string) => ({
  html: '<html><body><div class="spin">x</div><script>window.demo = 1</script></body></html>',
  width: 320,
  height: 200,
  locator: { whole: true },
  fidelity: 'frame',
}))
vi.mock('../src/lib/api', () => ({
  api: {
    frame: (id: string) => frame(id),
    libraryItemHtml: (lib: string, item: string) => libraryItemHtml(lib, item),
  },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { FindPreview } = await import('../src/components/FindPreview')

if (typeof ResizeObserver === 'undefined') {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
}

let root: Root
let host: HTMLDivElement
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)))

beforeEach(() => {
  frame.mockClear()
  libraryItemHtml.mockClear()
  useStore.setState({ canvas: { id: 'c1', frames: [], pages: [] } as unknown as Canvas })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('FindPreview', () => {
  it('reads a library frame through the library and keeps its scripts and animations', async () => {
    await act(async () =>
      root.render(
        <FindPreview
          frameId="sheet-a"
          focus={{ key: 'cp.a', text: 'cp.a' }}
          item={{ libraryId: 'lib1', itemId: 'cp.a' }}
          interactive
        />,
      ),
    )
    await settle()
    expect(frame).toHaveBeenCalledWith('sheet-a')
    expect(libraryItemHtml).toHaveBeenCalledWith('lib1', 'cp.a')
    const iframe = host.querySelector('iframe')!
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    const doc = iframe.getAttribute('srcdoc') ?? ''
    expect(doc).toContain('<script>window.demo = 1</script>')
    expect(doc).not.toContain('animation-play-state')
    expect(doc).not.toContain('prefers-reduced-motion')
    /* the pointer reaches the document, so a hover demo reacts */
    expect(iframe.className).toContain('pointer-events-auto')
  })

  it('keeps the pointer out of a preview that is not interactive', async () => {
    await act(async () =>
      root.render(
        <FindPreview
          frameId="sheet-b"
          focus={{ key: 'cp.b', text: 'cp.b' }}
          item={{ libraryId: 'lib1', itemId: 'cp.b' }}
        />,
      ),
    )
    await settle()
    expect(host.querySelector('iframe')!.className).toContain('pointer-events-none')
  })

  it('pauses the document while the tab is hidden and plays it on return', async () => {
    await act(async () =>
      root.render(
        <FindPreview
          frameId="sheet-c"
          focus={{ key: 'cp.c', text: 'cp.c' }}
          item={{ libraryId: 'lib1', itemId: 'cp.c' }}
        />,
      ),
    )
    await settle()
    const wrap = host.firstElementChild as HTMLElement
    expect(wrap.dataset.playing).toBe('true')
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(wrap.dataset.playing).toBe('false')
    state.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(wrap.dataset.playing).toBe('true')
    state.mockRestore()
  })
})
