import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types'

/* Deferred renders so tests control when Chromium "finishes" */
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

import * as thumbs from '../server/thumbs.ts'
import { store } from '../server/store.ts'

const frame = (id: string): Frame =>
  ({
    id,
    canvasId: 'c',
    name: id,
    x: 0,
    y: 0,
    width: 1280,
    height: 900,
    html: '',
    updatedAt: 1,
    updatedBy: 't',
  }) as Frame

function deferredRenders() {
  const resolvers: Array<(b: Buffer) => void> = []
  mocks.renderFrame.mockImplementation(() => new Promise<Buffer>((r) => resolvers.push(r)))
  return resolvers
}

const tick = () => new Promise((r) => setTimeout(r, 25))

beforeEach(() => {
  mocks.renderFrame.mockReset()
  mocks.putObject.mockReset().mockResolvedValue(undefined)
  mocks.getObject.mockReset().mockResolvedValue(null)
  mocks.deleteObject.mockReset().mockResolvedValue(undefined)
})

describe('thumbs', () => {
  it('bounds concurrent renders globally — breadth across frames cannot fan out unbounded', async () => {
    const resolvers = deferredRenders()
    const all = Array.from({ length: 10 }, (_, i) => thumbs.create(frame(`cap-${i}`)))
    await tick()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(3)

    /* finishing one admits exactly one waiter — never a burst */
    resolvers[0]!(Buffer.from('x'))
    await tick()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(4)

    for (let i = 1; i < 10; i++) {
      resolvers[i]?.(Buffer.from('x'))
      await tick()
    }
    await Promise.all(all)
    expect(mocks.renderFrame).toHaveBeenCalledTimes(10)
  })

  it('does not persist a thumb for a frame purged mid-render', async () => {
    const resolvers = deferredRenders()
    const p = thumbs.create(frame('purged-mid-render'))
    await tick()
    thumbs.purge('purged-mid-render')
    resolvers[0]!(Buffer.from('late'))
    await p
    await tick()
    expect(mocks.putObject).not.toHaveBeenCalled()
  })

  it('deletes its own write when purge lands during the put', async () => {
    const resolvers = deferredRenders()
    let finishPut!: () => void
    mocks.putObject.mockImplementation(() => new Promise<void>((r) => (finishPut = r)))
    const p = thumbs.create(frame('purged-during-put'))
    await tick()
    resolvers[0]!(Buffer.from('x'))
    await tick() /* now inside putObject */
    thumbs.purge('purged-during-put')
    finishPut()
    await p
    await tick()
    expect(mocks.deleteObject).toHaveBeenCalledWith('thumb/purged-during-put.jpg')
  })

  it('getStored serves stored bytes and refreshes stale ones in the background, deduped', async () => {
    deferredRenders()
    mocks.getObject.mockResolvedValue(Buffer.from('stale'))
    const f = frame('stale-frame')
    const [a, b] = await Promise.all([thumbs.getStored(f), thumbs.getStored(f)])
    expect(a?.buf.toString()).toBe('stale')
    expect(b?.buf.toString()).toBe('stale')
    expect(a?.fresh).toBe(false)
    await tick()
    /* one background refresh, not one per request (dedupe + throttle) */
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
  })

  it('renders a stage image as the whole frame at its width step, persisted per width', async () => {
    mocks.renderFrame.mockResolvedValue(Buffer.from('w256'))
    const f = frame('stage-render')
    const v: thumbs.ThumbVariant = { kind: 'stage', width: 256, ext: 'jpg' }
    await thumbs.create(f, v)
    expect(mocks.renderFrame).toHaveBeenCalledWith(
      expect.anything(),
      0.2, // 256 / 1280
      expect.objectContaining({ type: 'jpeg', priority: 'background' }),
    )
    /* the whole frame, not the card's top slice */
    expect(mocks.renderFrame.mock.calls[0]![2]).not.toHaveProperty('maxHeight')
    expect(mocks.putObject).toHaveBeenCalledWith('thumb/stage-render-w256.jpg', expect.anything(), 'image/jpeg')
    mocks.getObject.mockResolvedValue(Buffer.from('w256'))
    expect(await thumbs.getStored(f, v)).toMatchObject({ fresh: true })
  })

  it('keeps a stage image fresh across a move and stale after a design write, then refreshes it', async () => {
    vi.useFakeTimers()
    try {
      mocks.renderFrame.mockResolvedValue(Buffer.from('x'))
      const f = frame('stage-fresh')
      const v: thumbs.ThumbVariant = { kind: 'stage', width: 128, ext: 'png' }
      const live = vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === f.id ? f : undefined))
      /* the write that made the frame */
      thumbs.noteDesignWrite(f.id)
      await thumbs.create(f, v)
      mocks.getObject.mockResolvedValue(Buffer.from('x'))
      /* moved: updatedAt goes up but the design did not change */
      f.updatedAt = 5
      expect((await thumbs.getStored(f, v))?.fresh).toBe(true)
      /* written: stale until it re-renders, which waits for the frame to be quiet */
      f.updatedAt = 6
      thumbs.noteDesignWrite(f.id)
      expect((await thumbs.getStored({ ...f }, v))?.fresh).toBe(false)
      mocks.renderFrame.mockClear()
      await vi.advanceTimersByTimeAsync(thumbs.REFRESH_AFTER_WRITE_MS + 10)
      expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
      expect((await thumbs.getStored(f, v))?.fresh).toBe(true)
      live.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not render anything after a write to a frame nobody looked at as an image', async () => {
    vi.useFakeTimers()
    try {
      const f = frame('never-shown')
      const live = vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === f.id ? f : undefined))
      thumbs.noteDesignWrite(f.id)
      await vi.advanceTimersByTimeAsync(thumbs.REFRESH_AFTER_WRITE_MS + 10)
      expect(mocks.renderFrame).not.toHaveBeenCalled()
      live.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('purges every stage width with the card', () => {
    thumbs.purge('purged-stage')
    expect(mocks.deleteObject).toHaveBeenCalledWith('thumb/purged-stage.jpg')
    expect(mocks.deleteObject).toHaveBeenCalledWith('thumb/purged-stage-w128.jpg')
    expect(mocks.deleteObject).toHaveBeenCalledWith('thumb/purged-stage-w1024.png')
  })
})
