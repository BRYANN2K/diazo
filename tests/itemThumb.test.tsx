// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cropStyle, ItemThumb } from '../src/components/library/ItemThumb'
import { OTP_RESULT } from './libraryFindFixtures'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

/** The tile is on screen until `hide()`; `show()` brings it back. */
const screen = {
  observers: [] as { cb: IntersectionObserverCallback; el: Element | null }[],
  set(near: boolean) {
    for (const o of this.observers)
      if (o.el) o.cb([{ isIntersecting: near, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver)
  },
}
function onScreen() {
  screen.observers = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      entry: { cb: IntersectionObserverCallback; el: Element | null }
      constructor(cb: IntersectionObserverCallback) {
        this.entry = { cb, el: null }
        screen.observers.push(this.entry)
      }
      observe(el: Element) {
        this.entry.el = el
        queueMicrotask(() => screen.set(true))
      }
      disconnect() {
        this.entry.el = null
      }
    },
  )
}

/** fetch answering each call with the next status (the last one repeats) */
function answers(...statuses: number[]) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const status = statuses[Math.min(calls.length, statuses.length - 1)]!
      calls.push(url)
      return new Response(status === 200 ? new Blob(['jpeg'], { type: 'image/jpeg' }) : '{}', {
        status,
        headers: status === 503 ? { 'Retry-After': '1' } : {},
      })
    }),
  )
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:thumb', revokeObjectURL: () => {} }))
  onScreen()
  return calls
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

async function render(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

const base = OTP_RESULT.hits[0]!.item

describe('ItemThumb', () => {
  it('computes the crop of a box from the frame size', () => {
    expect(cropStyle({ x: 500, y: 100, w: 500, h: 250 }, { w: 2000, h: 1000 })).toEqual({
      width: '400%',
      height: '400%',
      left: '-100%',
      top: '-40%',
    })
  })

  it('shows its own thumbnail, and crops the frame preview when it really fails', async () => {
    const item = {
      ...base,
      thumb: '/api/libraries/lib1/items/x/thumb.jpg?v=h',
      box: { x: 500, y: 100, w: 500, h: 250 },
      frameSize: { w: 2000, h: 1000 },
    }
    const calls = answers(200)
    let el = await render(<ItemThumb item={item} />)
    await settle()
    expect(calls).toEqual([item.thumb])
    expect(el.querySelector('img')!.getAttribute('src')).toBe('blob:thumb')
    await act(async () => root?.unmount())
    host?.remove()

    answers(404)
    el = await render(<ItemThumb item={item} />)
    await settle()
    const crop = el.querySelector('[data-crop="frame"] img')!
    expect(crop.getAttribute('src')).toBe(`/i/${item.frameId}.jpg?preview`)
    expect((crop as HTMLImageElement).style.width).toBe('400%')
  })

  it('falls back to the frame preview when it has no box', async () => {
    const el = await render(<ItemThumb item={{ ...base, box: null }} />)
    expect(el.querySelector('img')!.getAttribute('src')).toBe(`/i/${base.frameId}.jpg?preview`)
  })
})
