import { describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import { RendererBusyError } from '../server/renderBrowser'
import { itemThumb, NoThumbError, thumbClip, thumbKey, type ThumbDeps } from '../server/libraryThumbs'
import { syntheticItems } from './libraryFixtures'

const frame = { id: 'frame-1', width: 2040, height: 440, html: '<p>x</p>' } as Frame
const item = { ...syntheticItems(1)[0]!, frameId: 'frame-1', box: { x: 532, y: 92, w: 490, h: 300 } }

function deps(over: Partial<ThumbDeps> = {}): ThumbDeps & { stored: Map<string, Buffer> } {
  const stored = new Map<string, Buffer>()
  return {
    stored,
    render: vi.fn(async () => Buffer.from('jpeg')),
    get: async (key) => stored.get(key) ?? null,
    put: async (key, body) => {
      stored.set(key, body)
    },
    frame: async () => frame,
    ...over,
  }
}

describe('thumbnails', () => {
  it('clips to the box plus a margin, clamped to the frame', () => {
    expect(thumbClip(item.box, frame)).toEqual({ x: 520, y: 80, width: 514, height: 324 })
    expect(thumbClip({ x: 0, y: 0, w: 2040, h: 440 }, frame)).toEqual({ x: 0, y: 0, width: 2040, height: 440 })
  })

  it('renders a jpeg at most 640 px on its longest side, at background priority', async () => {
    const d = deps()
    await itemThumb(item, d)
    expect(d.render).toHaveBeenCalledWith(frame, 1, expect.objectContaining({ type: 'jpeg', priority: 'background' }))
    const wide = { ...item, hash: 'wide', box: { x: 0, y: 0, w: 2040, h: 440 } }
    await itemThumb(wide, d)
    expect((d.render as ReturnType<typeof vi.fn>).mock.calls[1]![1]).toBeCloseTo(640 / 2040)
  })

  it('keys the cache by content hash, and serves the cached one', async () => {
    expect(thumbKey('lib1', item)).toBe(`lt/lib1/${item.itemId}-${item.hash}.jpg`)
    expect(thumbKey('lib1', { ...item, hash: 'other' })).not.toBe(thumbKey('lib1', item))
    const d = deps()
    await itemThumb(item, d)
    await itemThumb(item, d)
    expect(d.render).toHaveBeenCalledTimes(1)
  })

  it('passes a busy renderer on, and refuses an item with no box', async () => {
    const busy = deps({
      render: async () => {
        throw new RendererBusyError('queue full')
      },
    })
    await expect(itemThumb(item, busy)).rejects.toBeInstanceOf(RendererBusyError)
    await expect(itemThumb({ ...item, box: null }, deps())).rejects.toBeInstanceOf(NoThumbError)
  })
})
