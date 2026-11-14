import { describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'
import type { LibraryItem } from '../shared/library'
import { RendererBusyError } from '../server/renderBrowser'
import {
  itemThumb,
  isRendering,
  NoThumbError,
  renderThumbs,
  thumbClip,
  thumbKey,
  thumbTag,
  THUMB_VERSION,
  type ThumbDeps,
} from '../server/libraryThumbs'
import { syntheticItems } from './libraryFixtures'

const frame = { id: 'frame-1', width: 2040, height: 440, html: '<p>x</p>' } as Frame
const item: LibraryItem = { ...syntheticItems(1)[0]!, frameId: 'frame-1', box: { x: 532, y: 92, w: 490, h: 300 } }

function deps(over: Partial<ThumbDeps> = {}): ThumbDeps & { stored: Map<string, Buffer> } {
  const stored = new Map<string, Buffer>()
  return {
    stored,
    render: vi.fn(async (_frame: Frame, items: LibraryItem[]) => items.map((it) => Buffer.from(`jpeg ${it.itemId}`))),
    get: async (key) => stored.get(key) ?? null,
    has: async (key) => stored.has(key),
    put: async (key, body) => {
      stored.set(key, body)
    },
    frame: async () => frame,
    ...over,
  }
}

describe('thumbnails', () => {
  it('clips to the box plus a margin, clamped to the frame', () => {
    expect(thumbClip(item.box!, frame)).toEqual({ x: 520, y: 80, width: 514, height: 324 })
    expect(thumbClip({ x: 0, y: 0, w: 2040, h: 440 }, frame)).toEqual({ x: 0, y: 0, width: 2040, height: 440 })
  })

  it('keys the picture by content, box and version, in a key storage accepts', () => {
    const key = thumbKey('lib1', item)
    expect(key).toMatch(/^lt\/lib1\/[A-Za-z0-9_-]+\.jpg$/)
    expect(key).toContain(thumbTag(item))
    expect(thumbKey('lib1', { ...item, hash: 'other' })).not.toBe(key)
    expect(thumbKey('lib1', { ...item, box: { ...item.box!, w: 10 } })).not.toBe(key)
    expect(thumbKey('lib1', { ...item, box: null })).not.toBe(key)
    /* two ids that spell the same safely still get their own keys */
    expect(thumbKey('lib1', { ...item, itemId: 'cp.a-b' })).not.toBe(thumbKey('lib1', { ...item, itemId: 'cp_a-b' }))
    expect(THUMB_VERSION).toBeGreaterThan(0)
  })

  it('renders at the asked priority, stores, then serves the stored one', async () => {
    const d = deps()
    await itemThumb(item, { priority: 'interactive' }, d)
    expect(d.render).toHaveBeenCalledWith(frame, [item], 'interactive')
    expect(d.stored.get(thumbKey(item.canvasId, item))?.toString()).toBe(`jpeg ${item.itemId}`)
    await itemThumb(item, {}, d)
    expect(d.render).toHaveBeenCalledTimes(1)
  })

  it('renders a key being rendered once, whoever asks', async () => {
    let finish: (pictures: Buffer[]) => void = () => {}
    const d = deps({ render: vi.fn(() => new Promise<Buffer[]>((resolve) => (finish = resolve))) })
    const [fromQueue] = renderThumbs([item], 'background', d)
    const fromRoute = itemThumb(item, { priority: 'interactive' }, d)
    expect(isRendering(thumbKey(item.canvasId, item))).toBe(true)
    await Promise.resolve()
    finish([Buffer.from('one')])
    expect((await fromQueue!).toString()).toBe('one')
    expect((await fromRoute).toString()).toBe('one')
    expect(d.render).toHaveBeenCalledTimes(1)
    expect(isRendering(thumbKey(item.canvasId, item))).toBe(false)
  })

  it('renders the items of a frame together, each failing on its own', async () => {
    const [a, b] = syntheticItems(2).map((it) => ({ ...it, frameId: 'frame-1' }))
    const d = deps({ render: vi.fn(async () => [Buffer.from('a'), new Error('b broke')]) })
    const [pa, pb] = renderThumbs([a!, b!], 'background', d)
    expect((await pa!).toString()).toBe('a')
    await expect(pb!).rejects.toThrow('b broke')
    expect(d.render).toHaveBeenCalledTimes(1)
    expect(d.stored.size).toBe(1)
  })

  it('passes a busy renderer on, and refuses an item whose frame is gone', async () => {
    const busy = deps({
      render: async () => {
        throw new RendererBusyError('queue full')
      },
    })
    await expect(itemThumb(item, {}, busy)).rejects.toBeInstanceOf(RendererBusyError)
    await expect(itemThumb(item, {}, deps({ frame: async () => undefined }))).rejects.toBeInstanceOf(NoThumbError)
  })
})
