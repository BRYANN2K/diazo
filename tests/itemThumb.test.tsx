// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cropStyle, ItemThumb } from '../src/components/library/ItemThumb'
import { MAX_TRIES, retryAfterMs, retryDelay } from '../src/lib/thumbLoader'
import { OTP_RESULT } from './libraryFindFixtures'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

/** Whether the tile is on screen: `screen.set(near)` tells its observer. */
const screen = {
  auto: true,
  observers: [] as { cb: IntersectionObserverCallback; el: Element | null }[],
  set(near: boolean) {
    for (const o of this.observers)
      if (o.el) o.cb([{ isIntersecting: near, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver)
  },
}
function onScreen(auto = true) {
  screen.observers = []
  screen.auto = auto
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
        if (screen.auto) queueMicrotask(() => screen.set(true))
      }
      disconnect() {
        this.entry.el = null
      }
    },
  )
}

/** fetch answering each call with the next status (the last one repeats) */
function answers(...statuses: (number | 'hang')[]) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const status = statuses[Math.min(calls.length, statuses.length - 1)]!
      calls.push(url)
      if (status === 'hang') return new Promise<Response>(() => {})
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

  const own = {
    ...base,
    thumb: '/api/libraries/lib1/items/x/thumb.jpg?v=h',
    box: { x: 500, y: 100, w: 500, h: 250 },
    frameSize: { w: 2000, h: 1000 },
  }

  it('shows a skeleton while the picture loads', async () => {
    answers('hang')
    const el = await render(<ItemThumb item={own} />)
    await settle()
    expect(el.querySelector('[data-slot="skeleton"]')).not.toBeNull()
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('[data-thumb]')!.getAttribute('data-thumb')).toBe('loading')
  })

  it('asks again after Retry-After when the server is busy', async () => {
    vi.useFakeTimers()
    try {
      const calls = answers(503, 200)
      const el = await render(<ItemThumb item={own} />)
      await act(async () => vi.advanceTimersByTimeAsync(10))
      expect(calls).toHaveLength(1)
      expect(el.querySelector('[data-slot="skeleton"]')).not.toBeNull()
      await act(async () => vi.advanceTimersByTimeAsync(2000))
      expect(calls).toHaveLength(2)
      expect(el.querySelector('img')!.getAttribute('src')).toBe('blob:thumb')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after a few busy answers and falls back on the frame crop', async () => {
    vi.useFakeTimers()
    try {
      const calls = answers(503)
      const el = await render(<ItemThumb item={own} />)
      for (let i = 0; i < MAX_TRIES + 2; i++) await act(async () => vi.advanceTimersByTimeAsync(31_000))
      expect(calls).toHaveLength(MAX_TRIES)
      expect(el.querySelector('[data-crop="frame"] img')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads only while on screen', async () => {
    const calls = answers(200)
    onScreen(false)
    const el = await render(<ItemThumb item={own} />)
    await settle()
    expect(calls).toHaveLength(0)
    expect(el.querySelector('[data-slot="skeleton"]')).not.toBeNull()
    await act(async () => screen.set(true))
    await settle()
    expect(calls).toHaveLength(1)
  })

  it('waits what the server asks, else a doubling backoff, capped', () => {
    const mid = () => 0.5
    expect(retryDelay(1, 2000, mid)).toBe(2000)
    expect(retryDelay(3, 0, mid)).toBe(4000)
    expect(retryDelay(9, 0, mid)).toBe(30_000)
    expect(retryAfterMs('2')).toBe(2000)
    expect(retryAfterMs(null)).toBe(5000)
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000)
  })
})
