import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LibraryItem, ThumbProgress } from '../shared/library'
import { RendererBusyError } from '../server/renderBrowser'
import { thumbKey } from '../server/libraryThumbs'
import {
  BATCH,
  isPrewarming,
  prewarmLibrary,
  resetPrewarmForTest,
  setPrewarmDeps,
  thumbProgress,
  type PrewarmDeps,
} from '../server/libraryThumbQueue'
import { syntheticItems } from './libraryFixtures'

/**
 * The thumbnail prewarm with a stub renderer and storage: what it renders,
 * in which order, how many at once, and how it resumes, skips, waits out a
 * busy renderer and reports progress.
 */

const LIB = 'lib1'

/** n items, `perFrame` to a frame, in the given order */
function items(n: number, perFrame = 1): LibraryItem[] {
  return syntheticItems(n, LIB).map((item, i) => ({ ...item, frameId: `f${Math.floor(i / perFrame)}` }))
}

interface Rig {
  stored: Set<string>
  renders: string[][]
  progress: ThumbProgress[]
  peak: number
  deps: Partial<PrewarmDeps>
}

function rig(list: LibraryItem[], over: Partial<PrewarmDeps> = {}): Rig {
  const r: Rig = { stored: new Set(), renders: [], progress: [], peak: 0, deps: {} }
  let active = 0
  r.deps = {
    available: () => true,
    isLibrary: () => true,
    items: async () => list,
    has: async (key) => r.stored.has(key),
    concurrency: () => 2,
    progress: (_id, p) => {
      if (p) r.progress.push(p)
    },
    finished: () => {},
    sleep: async () => {},
    render: (batch) => {
      r.renders.push(batch.map((item) => item.itemId))
      active++
      r.peak = Math.max(r.peak, active)
      return batch.map(async (item) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        r.stored.add(thumbKey(item.canvasId, item))
        return Buffer.from('jpeg')
      })
    },
    ...over,
  }
  const render = r.deps.render!
  r.deps.render = (batch) => {
    const out = render(batch)
    void Promise.allSettled(out).then(() => active--)
    return out
  }
  setPrewarmDeps(r.deps)
  return r
}

afterEach(() => {
  resetPrewarmForTest()
  setPrewarmDeps(null)
})

describe('thumbnail prewarm', () => {
  it('renders what is missing, in order, the items of a frame together', async () => {
    const list = items(2 * BATCH + 3, BATCH + 2)
    const r = rig(list)
    await prewarmLibrary(LIB)
    /* frame f0 holds BATCH + 2 items: one page of BATCH, then the rest */
    expect(r.renders[0]).toEqual(list.slice(0, BATCH).map((i) => i.itemId))
    expect(r.renders.flat().sort()).toEqual(list.map((i) => i.itemId).sort())
    expect(
      r.renders.every((batch) => new Set(batch.map((id) => list.find((i) => i.itemId === id)!.frameId)).size === 1),
    ).toBe(true)
    expect(r.stored.size).toBe(list.length)
    expect(thumbProgress(LIB)).toMatchObject({ ready: list.length, total: list.length, running: false })
  })

  it('never renders more batches at once than its share of the renderer', async () => {
    const r = rig(items(12), { concurrency: () => 2 })
    await prewarmLibrary(LIB)
    expect(r.peak).toBeLessThanOrEqual(2)
    expect(r.renders).toHaveLength(12)
  })

  it('resumes from what storage holds, and skips what is there', async () => {
    const list = items(6)
    const r = rig(list)
    for (const item of list.slice(0, 4)) r.stored.add(thumbKey(item.canvasId, item))
    await prewarmLibrary(LIB)
    expect(r.renders.flat()).toEqual(list.slice(4).map((i) => i.itemId))
    expect(r.progress[0]).toMatchObject({ ready: 4, total: 6, running: true })
    r.renders.length = 0
    await prewarmLibrary(LIB)
    expect(r.renders).toEqual([])
    expect(thumbProgress(LIB)).toMatchObject({ ready: 6, total: 6, running: false })
  })

  it('runs one job per library: a second ask while it runs runs it once more after', async () => {
    const list = items(3)
    const r = rig(list)
    const askedItems = vi.fn(async () => list)
    setPrewarmDeps({ ...r.deps, items: askedItems })
    const first = prewarmLibrary(LIB)
    expect(isPrewarming(LIB)).toBe(true)
    const second = prewarmLibrary(LIB)
    const third = prewarmLibrary(LIB)
    expect(second).toBe(first)
    expect(third).toBe(first)
    await first
    await vi.waitFor(() => expect(isPrewarming(LIB)).toBe(false))
    expect(askedItems).toHaveBeenCalledTimes(2)
    expect(r.renders.flat()).toEqual(list.map((i) => i.itemId))
  })

  it('waits out a busy renderer and tries the same items again, never counting them failed', async () => {
    const list = items(2)
    let refusals = 1
    const sleep = vi.fn(async () => {})
    const r = rig(list, { sleep })
    const render = r.deps.render!
    setPrewarmDeps({
      ...r.deps,
      render: (batch) => {
        if (refusals-- > 0) return batch.map(() => Promise.reject(new RendererBusyError('queue full')))
        return render(batch)
      },
    })
    await prewarmLibrary(LIB)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(r.stored.size).toBe(2)
    expect(thumbProgress(LIB)).toMatchObject({ ready: 2, total: 2 })
    expect(thumbProgress(LIB)?.failed).toBeUndefined()
  })

  it('counts a broken item as failed and goes on', async () => {
    const list = items(3)
    const r = rig(list)
    const render = r.deps.render!
    setPrewarmDeps({
      ...r.deps,
      render: (batch) =>
        batch[0]!.itemId === list[1]!.itemId ? [Promise.reject(new Error('script error'))] : render(batch),
    })
    await prewarmLibrary(LIB)
    expect(thumbProgress(LIB)).toMatchObject({ ready: 2, total: 3, failed: 1, running: false })
  })

  it('does nothing without a renderer, or for a canvas that is no library', async () => {
    const r = rig(items(2), { available: () => false })
    await prewarmLibrary(LIB)
    setPrewarmDeps({ ...r.deps, available: () => true, isLibrary: () => false })
    await prewarmLibrary(LIB)
    expect(r.renders).toEqual([])
    expect(thumbProgress(LIB)).toBeNull()
  })
})
