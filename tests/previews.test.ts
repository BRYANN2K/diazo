import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

/* Mock only the leaves (Chromium, byte storage) — previews.ts and thumbs.ts
 * run for real, so these tests cover the integrated dispatch: cache → stored
 * thumb → rate limit → render. */
const mocks = vi.hoisted(() => ({
  renderFrame: vi.fn(),
  putObject: vi.fn(),
  getObject: vi.fn(),
  deleteObject: vi.fn(),
}))

vi.mock('../server/screenshot.ts', () => ({ renderFrame: mocks.renderFrame }))
vi.mock('../server/storage.ts', () => ({
  putObject: mocks.putObject,
  getObject: mocks.getObject,
  deleteObject: mocks.deleteObject,
}))

import { getImage, primeImage } from '../server/previews.ts'
import * as thumbs from '../server/thumbs.ts'
import { store } from '../server/store.ts'

let seq = 0
const frame = (over: Partial<Frame> = {}): Frame =>
  ({
    id: `f${seq++}`,
    canvasId: 'c',
    name: 'f',
    x: 0,
    y: 0,
    width: 1280,
    height: 900,
    html: '',
    updatedAt: 1,
    updatedBy: 't',
    ...over,
  }) as Frame

const anon = () => Promise.resolve(false)
const authed = () => Promise.resolve(true)
const req = (over: Partial<Parameters<typeof getImage>[1]> = {}): Parameters<typeof getImage>[1] => ({
  ext: 'jpg',
  scale: 1,
  quality: 90,
  preview: false,
  ip: `ip${seq++}`,
  isAuthenticated: anon,
  ...over,
})

beforeEach(() => {
  mocks.renderFrame.mockReset().mockResolvedValue(Buffer.from('rendered'))
  mocks.putObject.mockReset().mockResolvedValue(undefined)
  mocks.getObject.mockReset().mockResolvedValue(null)
  mocks.deleteObject.mockReset().mockResolvedValue(undefined)
})

describe('getImage', () => {
  it('png?preview does a full png render, never the jpeg thumb path', async () => {
    const r = await getImage(frame(), req({ ext: 'png', preview: true }))
    expect(r.status).toBe('ok')
    expect(mocks.renderFrame).toHaveBeenCalledWith(expect.anything(), 1, expect.objectContaining({ type: 'png' }))
    expect(mocks.getObject).not.toHaveBeenCalled()
    expect(mocks.putObject).not.toHaveBeenCalled()
  })

  it('jpg?preview renders card-size and persists the thumb', async () => {
    const f = frame()
    const r = await getImage(f, req({ preview: true }))
    expect(r.status).toBe('ok')
    expect(mocks.renderFrame).toHaveBeenCalledWith(
      expect.anything(),
      0.5, // 640 / 1280
      expect.objectContaining({ type: 'jpeg', quality: 70, maxHeight: 1200 }),
    )
    await new Promise((r2) => setTimeout(r2, 10))
    expect(mocks.putObject).toHaveBeenCalledWith(`thumb/${f.id}-v1.jpg`, expect.anything(), 'image/jpeg')
  })

  it('caches per frame version — one render serves repeat requests, an update re-renders', async () => {
    const f = frame()
    const r = req()
    await getImage(f, r)
    await getImage(f, r)
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
    await getImage({ ...f, updatedAt: 2 }, r)
    expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
  })

  it('a failed render is not cached — the next request retries', async () => {
    mocks.renderFrame.mockRejectedValueOnce(new Error('chromium died'))
    const f = frame()
    const r = req()
    await expect(getImage(f, r)).rejects.toThrow('chromium died')
    await expect(getImage(f, r)).resolves.toMatchObject({ status: 'ok' })
    expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
  })

  it('meters anonymous renders per IP but lets authenticated users through', async () => {
    const ip = 'shared-proxy-ip'
    for (let i = 0; i < 12; i++) {
      expect((await getImage(frame(), req({ ip }))).status).toBe('ok')
    }
    expect((await getImage(frame(), req({ ip }))).status).toBe('rate-limited')
    expect((await getImage(frame(), req({ ip, isAuthenticated: authed }))).status).toBe('ok')
  })

  it('serves a stored thumb without consuming render budget', async () => {
    const ip = 'exhausted-ip'
    for (let i = 0; i < 12; i++) await getImage(frame(), req({ ip }))
    mocks.getObject.mockResolvedValue(Buffer.from('stored'))
    const r = await getImage(frame(), req({ ip, preview: true }))
    expect(r.status).toBe('ok')
    expect(r.status === 'ok' && r.buf.toString()).toBe('stored')
  })

  it('primeImage seeds the png cache so the card load after a screenshot is not metered', async () => {
    const ip = 'chatgpt-card-ip'
    for (let i = 0; i < 12; i++) await getImage(frame(), req({ ip }))
    const f = frame()
    primeImage(f, 1, Buffer.from('from-the-tool'))
    const png = req({ ip, ext: 'png', scale: 1 })
    const r = await getImage(f, png)
    expect(r.status).toBe('ok')
    expect(r.status === 'ok' && r.buf.toString()).toBe('from-the-tool')
    expect(mocks.renderFrame).toHaveBeenCalledTimes(12)
    /* the prime is per frame version: an edit needs a real render again */
    expect((await getImage({ ...f, updatedAt: 2 }, png)).status).toBe('rate-limited')
  })

  it('full renders and previews share one bound on concurrent renders', async () => {
    const resolvers: ((buf: Buffer) => void)[] = []
    mocks.renderFrame.mockImplementation(() => new Promise<Buffer>((r) => resolvers.push(r)))
    const tick = () => new Promise((r) => setTimeout(r, 10))
    const all = [
      getImage(frame(), req({ preview: true })),
      ...Array.from({ length: 4 }, () => getImage(frame(), req())),
    ]
    await tick()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(3)
    for (let i = 0; i < all.length; i++) {
      resolvers[i]?.(Buffer.from('x'))
      await tick()
    }
    await Promise.all(all)
    expect(mocks.renderFrame).toHaveBeenCalledTimes(5)
  })

  it('a stage image renders once at background priority and is then served from memory', async () => {
    const f = frame()
    const r = await getImage(f, req({ lod: 512 }))
    expect(r).toMatchObject({ status: 'ok', fresh: true })
    expect(mocks.renderFrame).toHaveBeenCalledWith(
      expect.anything(),
      0.4, // 512 / 1280
      expect.objectContaining({ type: 'jpeg', priority: 'background' }),
    )
    await getImage(f, req({ lod: 512 }))
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
    /* another width is its own render */
    await getImage(f, req({ lod: 128 }))
    expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
  })

  it('a write during the first render comes back stale for every request sharing it', async () => {
    const resolvers: ((buf: Buffer) => void)[] = []
    mocks.renderFrame.mockImplementation(() => new Promise<Buffer>((r) => resolvers.push(r)))
    const f = frame()
    const live = vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === f.id ? f : undefined))
    const first = getImage(f, req({ lod: 256 }))
    /* the design moves on while the render runs */
    await new Promise((r) => setTimeout(r, 10))
    f.updatedAt = 2
    thumbs.noteDesignWrite(f.id)
    const second = getImage(f, req({ lod: 256 }))
    resolvers[0]!(Buffer.from('older design'))
    /* both requests shared the one render, and it honestly says it is behind */
    expect(await first).toMatchObject({ status: 'ok', fresh: false })
    expect(await second).toMatchObject({ status: 'ok', fresh: false })
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
    /* not remembered as current: the next ask reads storage again and stays
       honest while the re-render runs */
    mocks.getObject.mockImplementation((key: string) =>
      Promise.resolve(key.endsWith('.json') ? null : Buffer.from('older design')),
    )
    expect(await getImage(f, req({ lod: 256 }))).toMatchObject({ status: 'ok', fresh: false })
    live.mockRestore()
  })

  it('a stage render of the current design is cached under its version', async () => {
    mocks.renderFrame.mockResolvedValue(Buffer.from('current'))
    const f = frame()
    expect(await getImage(f, req({ lod: 512 }))).toMatchObject({ status: 'ok', fresh: true })
    /* same version again: from memory, no render, no new storage read */
    const reads = mocks.getObject.mock.calls.length
    expect(await getImage(f, req({ lod: 512 }))).toMatchObject({ status: 'ok', fresh: true })
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
    expect(mocks.getObject.mock.calls.length).toBe(reads)
  })

  it('serves a stored stage image at once, marked stale while it refreshes, and keeps it out of memory', async () => {
    mocks.getObject.mockImplementation((key: string) =>
      Promise.resolve(key.endsWith('.json') ? null : Buffer.from('older design')),
    )
    mocks.renderFrame.mockImplementation(() => new Promise(() => {}))
    const f = frame()
    const first = await getImage(f, req({ lod: 256 }))
    expect(first).toMatchObject({ status: 'ok', fresh: false })
    expect(first.status === 'ok' && first.buf.toString()).toBe('older design')
    /* the refresh is running; the next ask reads storage again rather than a cached stale copy */
    await getImage(f, req({ lod: 256 }))
    expect(mocks.getObject.mock.calls.filter(([key]) => key === `thumb/${f.id}-w256.jpg`)).toHaveLength(2)
  })
})
