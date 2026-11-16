import { describe, expect, it } from 'vitest'
import { parsePreviewWidth, previewScale, previewWidthFor } from '../shared/framePreview'
import {
  FramePreviewCache,
  framePreviewUrl,
  previewWidth,
  satisfies,
  STALE_RETRIES,
  type PreviewDeps,
} from '../src/lib/framePreviews'
import { MAX_TRIES, type ThumbLoad } from '../src/lib/thumbLoader'

describe('preview widths', () => {
  it('asks for the smallest step at least as wide as the frame on screen', () => {
    /* 1280px at 8% on a 2x screen: 205 device px */
    expect(previewWidth(1280, 0.08, 2)).toBe(256)
    expect(previewWidth(1280, 0.05, 1)).toBe(128)
    expect(previewWidth(1280, 0.3, 1)).toBe(512)
    /* past the widest step, the widest */
    expect(previewWidth(1280, 1, 2)).toBe(1024)
    expect(previewWidthFor(0)).toBe(128)
  })

  it('renders a width step at the matching density, never above 2x', () => {
    expect(previewScale(1280, 256)).toBe(0.2)
    expect(previewScale(40, 1024)).toBe(2)
  })

  it('accepts only the steps from a query', () => {
    expect(parsePreviewWidth('256')).toBe(256)
    expect(parsePreviewWidth('300')).toBeNull()
    expect(parsePreviewWidth(undefined)).toBeNull()
  })

  it('versions the url and keeps a shape transparent', () => {
    expect(framePreviewUrl({ id: 'f1', version: 42, width: 256, ext: 'jpg' })).toBe('/i/f1.jpg?lod=256&v=42')
    expect(framePreviewUrl({ id: 'f1', version: 42, width: 128, ext: 'png' })).toBe('/i/f1.png?lod=128&v=42')
  })

  it('reuses a wider picture of the same version and format, never an older or stale one', () => {
    const entry = { version: 3, width: 512 as const, ext: 'jpg' as const, src: 'blob:a', bytes: 1, stale: false }
    expect(satisfies(entry, { version: 3, width: 256, ext: 'jpg' })).toBe(true)
    expect(satisfies(entry, { version: 3, width: 1024, ext: 'jpg' })).toBe(false)
    expect(satisfies(entry, { version: 4, width: 128, ext: 'jpg' })).toBe(false)
    expect(satisfies({ ...entry, stale: true }, { version: 3, width: 128, ext: 'jpg' })).toBe(false)
    /* an opaque jpg does not answer for a shape's png */
    expect(satisfies(entry, { version: 3, width: 128, ext: 'png' })).toBe(false)
  })
})

/* a cache whose network, decoder, paint and clock the test drives */
function harness(max = 400, maxBytes = 64 * 1024 * 1024) {
  const calls: { url: string; signal: AbortSignal; answer: (load: ThumbLoad) => void }[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const rafQueue: (() => void)[] = []
  const revoked: string[] = []
  let n = 0
  const deps: PreviewDeps = {
    load: (url, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        calls.push({ url, signal, answer: resolve })
      }),
    decode: () => Promise.resolve({ src: `blob:${++n}` }),
    revoke: (src) => revoked.push(src),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      if (timer) (timer as { cleared: boolean }).cleared = true
    },
    raf: (fn) => rafQueue.push(fn),
  }
  const cache = new FramePreviewCache(deps, max, maxBytes)
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const paint = () => {
    for (const fn of rafQueue.splice(0)) fn()
  }
  const fire = async () => {
    const pending = timers.filter((t) => !t.cleared)
    timers.length = 0
    for (const t of pending) t.fn()
    await flush()
  }
  return { cache, calls, timers, revoked, flush, fire, paint }
}

const ok = (stale = false): ThumbLoad => ({ kind: 'ok', blob: new Blob(['x']), stale })
const want = (id: string, version = 1, width: 128 | 256 | 512 | 1024 = 256) => ({
  id,
  version,
  width,
  ext: 'jpg' as const,
})

describe('FramePreviewCache', () => {
  it('loads once for every frame asking and keeps the decoded picture', async () => {
    const h = harness()
    h.cache.request(want('a'))
    h.cache.request(want('a'))
    expect(h.calls).toHaveLength(1)
    expect(h.cache.snapshot('a').status).toBe('loading')
    h.calls[0]!.answer(ok())
    await h.flush()
    expect(h.cache.snapshot('a')).toMatchObject({ status: 'ready', entry: { src: 'blob:1', version: 1 } })
    /* asked again (a pan back, a zoom out after a zoom in): no request */
    h.cache.request(want('a', 1, 128))
    expect(h.calls).toHaveLength(1)
  })

  it('keeps the old picture up while an edited version loads, then swaps it', async () => {
    const h = harness()
    h.cache.request(want('a', 1))
    h.calls[0]!.answer(ok())
    await h.flush()
    h.cache.request(want('a', 2))
    expect(h.calls).toHaveLength(2)
    expect(h.cache.snapshot('a')).toMatchObject({ status: 'loading', entry: { version: 1 } })
    h.calls[1]!.answer(ok())
    await h.flush()
    expect(h.cache.snapshot('a').entry).toMatchObject({ version: 2, src: 'blob:2' })
    expect(h.revoked).toEqual(['blob:1'])
  })

  it('does not answer a png ask with the jpg of the same version', async () => {
    const h = harness()
    h.cache.request(want('a', 1))
    h.calls[0]!.answer(ok())
    await h.flush()
    /* the html just loaded and the frame is a shape: a new fetch, not the jpg */
    h.cache.request({ id: 'a', version: 1, width: 256, ext: 'png' })
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.url).toBe('/i/a.png?lod=256&v=1')
  })

  it('stops a load when the last frame asking lets go', async () => {
    const h = harness()
    const release = h.cache.request(want('a'))
    release()
    expect(h.calls[0]!.signal.aborted).toBe(true)
    expect(h.cache.snapshot('a').status).toBe('idle')
  })

  it('asks a busy renderer again, then gives up into the neutral well', async () => {
    const h = harness()
    h.cache.request(want('a'))
    for (let i = 0; i < MAX_TRIES; i++) {
      h.calls[i]!.answer({ kind: 'busy', retryAfterMs: 10 })
      await h.flush()
      await h.fire()
    }
    expect(h.calls).toHaveLength(MAX_TRIES)
    expect(h.cache.snapshot('a').status).toBe('failed')
    /* the same version is not asked for again while it cools down */
    h.cache.request(want('a'))
    expect(h.calls).toHaveLength(MAX_TRIES)
  })

  it('tries a failed ask again after it cools down or the frame comes back', async () => {
    const h = harness()
    const release = h.cache.request(want('a'))
    h.calls[0]!.answer({ kind: 'failed' })
    await h.flush()
    expect(h.cache.snapshot('a').status).toBe('failed')
    /* still on screen, still cooling down */
    const alsoHeld = h.cache.request(want('a'))
    expect(h.calls).toHaveLength(1)
    /* the frame left the screen entirely: coming back is worth another shot */
    release()
    alsoHeld()
    h.cache.request(want('a'))
    expect(h.calls).toHaveLength(2)
  })

  it('shows a stale answer and asks again until the current render lands', async () => {
    const h = harness()
    h.cache.request(want('a'))
    h.calls[0]!.answer(ok(true))
    await h.flush()
    expect(h.cache.snapshot('a').entry).toMatchObject({ stale: true })
    await h.fire()
    h.calls[1]!.answer(ok(false))
    await h.flush()
    expect(h.cache.snapshot('a').entry).toMatchObject({ stale: false, src: 'blob:2' })
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0)
  })

  it('stops asking after a few stale answers', async () => {
    const h = harness()
    h.cache.request(want('a'))
    for (let i = 0; i <= STALE_RETRIES; i++) {
      h.calls[i]!.answer(ok(true))
      await h.flush()
      await h.fire()
    }
    expect(h.calls).toHaveLength(STALE_RETRIES + 1)
  })

  it('evicts the least recent pictures past its size, never one a frame is fetching', async () => {
    const h = harness(2)
    /* 'a' showed once then left the screen (released, still subscribed) */
    const unsubscribe = h.cache.subscribe('a', () => {})
    const releaseA = h.cache.request(want('a'))
    h.calls[h.calls.length - 1]!.answer(ok())
    await h.flush()
    releaseA()
    /* 'b' and 'c' are on screen now */
    const releaseB = h.cache.request(want('b'))
    h.calls[h.calls.length - 1]!.answer(ok())
    await h.flush()
    h.cache.request(want('c'))
    h.calls[h.calls.length - 1]!.answer(ok())
    await h.flush()
    expect(h.cache.size()).toBe(2)
    expect(h.cache.snapshot('a').entry).toBeNull()
    expect(h.revoked).toEqual(['blob:1'])
    /* 'b' left too: 'd' arriving evicts it, 'c' and 'd' are held */
    releaseB()
    h.cache.request(want('d'))
    h.calls[h.calls.length - 1]!.answer(ok())
    await h.flush()
    expect(h.cache.snapshot('b').entry).toBeNull()
    expect(h.cache.snapshot('c').entry).not.toBeNull()
    expect(h.cache.snapshot('d').entry).not.toBeNull()
    unsubscribe()
  })

  it('bounds memory by bytes, not only by count', async () => {
    const h = harness(400, 2048)
    /* each 1 KB picture, the frames gone from the screen: over the byte
       budget long before the count */
    for (const id of ['a', 'b', 'c']) {
      const release = h.cache.request(want(id))
      h.calls[h.calls.length - 1]!.answer({ kind: 'ok', blob: new Blob([new Uint8Array(1024)]), stale: false })
      await h.flush()
      release()
    }
    expect(h.cache.size()).toBe(2)
    expect(h.cache.totalBytes()).toBeLessThanOrEqual(2048)
    expect(h.revoked).toEqual(['blob:1'])
  })

  it('enforces the byte budget as visible holders release and notifies inactive subscribers', async () => {
    const h = harness(400, 1)
    const releaseA = h.cache.request(want('a'))
    h.calls[0]!.answer(ok())
    await h.flush()
    const releaseB = h.cache.request(want('b'))
    h.calls[1]!.answer(ok())
    await h.flush()
    expect(h.cache.totalBytes()).toBe(2)
    h.paint()
    let notified = 0
    h.cache.subscribe('a', () => notified++)
    releaseA()
    h.paint()
    expect(h.cache.totalBytes()).toBe(1)
    expect(h.cache.snapshot('a').entry).toBeNull()
    expect(notified).toBe(1)
    releaseB()
  })

  it('batches listener calls into one flush per frame', async () => {
    const h = harness()
    let notified = 0
    for (const id of ['a', 'b', 'c']) {
      h.cache.subscribe(id, () => notified++)
      h.cache.request(want(id))
    }
    for (const call of h.calls) call.answer(ok())
    await h.flush()
    /* all three landed but the listeners have not run yet */
    expect(notified).toBe(0)
    h.paint()
    expect(notified).toBe(3)
  })
})
