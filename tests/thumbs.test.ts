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

const stage = (width: 128 | 256 | 512 | 1024, ext: 'jpg' | 'png' = 'jpg'): thumbs.ThumbVariant => ({
  kind: 'stage',
  width,
  ext,
})

function deferredRenders() {
  const resolvers: Array<(b: Buffer) => void> = []
  mocks.renderFrame.mockImplementation(() => new Promise<Buffer>((r) => resolvers.push(r)))
  return resolvers
}

const tick = () => new Promise((r) => setTimeout(r, 25))
/** storage answers `bytes` for any object, the ledger excepted */
const stored = (bytes: string | null) =>
  mocks.getObject.mockImplementation((key: string) =>
    Promise.resolve(key.endsWith('.json') || bytes === null ? null : Buffer.from(bytes)),
  )

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

  it('lifts the purge once the renders it guarded settle', async () => {
    const resolvers = deferredRenders()
    const p = thumbs.create(frame('purged-then-back'))
    await tick()
    thumbs.purge('purged-then-back')
    resolvers[0]!(Buffer.from('late'))
    await p
    await tick() /* `pending` clears in a finally after the promise resolves */
    /* the frame came back (an undo): previews persist again */
    mocks.renderFrame.mockResolvedValue(Buffer.from('new'))
    const { buf } = await thumbs.create(frame('purged-then-back'))
    expect(buf.toString()).toBe('new')
    await vi.waitFor(() =>
      expect(mocks.putObject).toHaveBeenCalledWith('thumb/purged-then-back-v1.jpg', expect.anything(), 'image/jpeg'),
    )
  })

  it('deletes its own write when purge lands during the put', async () => {
    const resolvers = deferredRenders()
    let finishPut!: () => void
    mocks.putObject.mockImplementation((key: string) =>
      key.endsWith('.json') ? Promise.resolve() : new Promise<void>((r) => (finishPut = r)),
    )
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
    stored('stale')
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
    await thumbs.create(f, stage(256))
    expect(mocks.renderFrame).toHaveBeenCalledWith(
      expect.anything(),
      0.2, // 256 / 1280
      expect.objectContaining({ type: 'jpeg', priority: 'background' }),
    )
    /* the whole frame, clipped at the stage pixel cap rather than the card's slice */
    const opts = mocks.renderFrame.mock.calls[0]![2] as { maxHeight: number }
    expect(opts.maxHeight).toBeGreaterThan(1200)
    expect(opts.maxHeight).toBeLessThanOrEqual(4_000_000 / (256 * 0.2) + 1)
    expect(mocks.putObject).toHaveBeenCalledWith('thumb/stage-render-w256-v1.jpg', expect.anything(), 'image/jpeg')
    stored('w256')
    expect(await thumbs.getStored(f, stage(256))).toMatchObject({ fresh: true })
  })

  it('returns the version a render drew, behind the frame after a mid-render write', async () => {
    const resolvers = deferredRenders()
    const f = frame('write-during-render')
    const live = vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === f.id ? f : undefined))
    const p = thumbs.create(f, stage(256))
    await tick()
    /* a design write lands while the render runs */
    f.updatedAt = 2
    thumbs.noteDesignWrite(f.id)
    resolvers[0]!(Buffer.from('old'))
    const { buf, renderedAt } = await p
    expect(buf.toString()).toBe('old')
    expect(renderedAt).toBe(1)
    expect(thumbs.freshAt(f, renderedAt)).toBe(false)
    live.mockRestore()
  })

  it('keeps a stage image fresh across a move even when the process saw no design write', async () => {
    mocks.renderFrame.mockResolvedValue(Buffer.from('x'))
    const f = frame('restart-fresh')
    await thumbs.create(f, stage(128))
    stored('x')
    /* a move bumps updatedAt but the design did not change */
    f.updatedAt = 9
    expect((await thumbs.getStored(f, stage(128)))?.fresh).toBe(true)
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
  })

  it('remembers what it rendered across a restart: the ledger, not another render', async () => {
    mocks.renderFrame.mockResolvedValue(Buffer.from('x'))
    const f = frame('across-restart')
    await thumbs.create(f, stage(256))
    await thumbs.flushLedger()
    /* what the next process will read beside the image itself */
    const ledger = mocks.putObject.mock.calls.filter(([k]) => k === 'thumb/_freshness.json').at(-1)?.[1] as Buffer
    expect(JSON.parse(ledger.toString()).written['across-restart-w256.jpg']).toBe(1)
    expect(JSON.parse(ledger.toString()).design['across-restart']).toBe(1)

    /* a restart: a fresh module over the same storage, ledger included */
    vi.resetModules()
    mocks.getObject.mockImplementation((key: string) =>
      Promise.resolve(key.endsWith('.json') ? ledger : Buffer.from('x')),
    )
    const restarted = await import('../server/thumbs.ts')
    /* even the move that bumped updatedAt since keeps the stored design */
    f.updatedAt = 9
    expect(await restarted.getStored(f, stage(256))).toMatchObject({ fresh: true })
    /* the point of the ledger: this restart re-rendered nothing */
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
  })

  it('detects a persisted edit after restart even if its write notification was lost', async () => {
    mocks.renderFrame.mockResolvedValue(Buffer.from('old'))
    const f = frame('missed-notification')
    await thumbs.create(f, stage(256))
    const ledger = mocks.putObject.mock.calls.filter(([k]) => k === 'thumb/_freshness.json').at(-1)![1] as Buffer
    vi.resetModules()
    mocks.getObject.mockImplementation((key: string) =>
      Promise.resolve(key.endsWith('.json') ? ledger : Buffer.from('old')),
    )
    const restarted = await import('../server/thumbs.ts')
    f.html = '<body>persisted edit</body>'
    f.updatedAt = 2
    deferredRenders()
    expect(await restarted.getStored(f, stage(256))).toMatchObject({ fresh: false })
  })

  it('revalidates a stored preview whose rendered version is unknown after a ledger loss', async () => {
    /* the image is there but the ledger is not: treat it as maybe-stale and
       re-render in the background — never serve it as current */
    vi.resetModules()
    stored('x')
    const restarted = await import('../server/thumbs.ts')
    const resolvers = deferredRenders()
    /* html on hand: the re-imported store does not hold this frame */
    const f = { ...frame('ledger-loss'), html: '<p>still here</p>' }
    const stored1 = await restarted.getStored(f, stage(256))
    expect(stored1).toMatchObject({ fresh: false })
    expect(stored1?.buf.toString()).toBe('x')
    await tick()
    expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
    resolvers[0]!(Buffer.from('y'))
    await vi.waitFor(async () => expect((await restarted.getStored(f, stage(256)))?.fresh).toBe(true))
  })

  it('keeps a stage image fresh across a move and stale after a design write, then refreshes it', async () => {
    vi.useFakeTimers()
    try {
      mocks.renderFrame.mockResolvedValue(Buffer.from('x'))
      const f = frame('stage-fresh')
      const v = stage(128, 'png')
      f.html = '<body data-doop-canvas-element="rect"></body>'
      const live = vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === f.id ? f : undefined))
      /* the write that made the frame */
      thumbs.noteDesignWrite(f.id)
      await thumbs.create(f, v)
      stored('x')
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

  it('does not register a png ask on a frame whose html is not a canvas element', async () => {
    vi.useFakeTimers()
    try {
      const f = frame('png-gated')
      const live = vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === f.id ? f : undefined))
      thumbs.remember(f, stage(128, 'png'))
      thumbs.noteDesignWrite(f.id)
      await vi.advanceTimersByTimeAsync(thumbs.REFRESH_AFTER_WRITE_MS + 10)
      expect(mocks.renderFrame).not.toHaveBeenCalled()
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

  it('invalidate drops a live frame’s stored previews and lets it persist again', async () => {
    mocks.renderFrame.mockResolvedValue(Buffer.from('x'))
    const f = frame('restyled')
    await thumbs.create(f, stage(128))
    await tick()
    mocks.putObject.mockClear()
    thumbs.invalidate(f.id)
    stored(null)
    expect(await thumbs.getStored(f, stage(128))).toBeNull()
    /* not dead: the next render persists as usual */
    await thumbs.create(f, stage(128))
    await vi.waitFor(() =>
      expect(mocks.putObject).toHaveBeenCalledWith('thumb/restyled-w128-v1.jpg', expect.anything(), 'image/jpeg'),
    )
  })

  it('expires requested variants after a day instead of refreshing them forever', async () => {
    vi.useFakeTimers()
    try {
      const f = frame('expired-variant')
      const live = vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === f.id ? f : undefined))
      thumbs.remember(f, stage(128))
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1)
      thumbs.noteDesignWrite(f.id)
      await vi.advanceTimersByTimeAsync(thumbs.REFRESH_AFTER_WRITE_MS + 1)
      expect(mocks.renderFrame).not.toHaveBeenCalled()
      live.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds object deletions across a large canvas purge', async () => {
    const finish: (() => void)[] = []
    mocks.deleteObject.mockImplementation(() => new Promise<void>((resolve) => finish.push(resolve)))
    for (let i = 0; i < 12; i++) thumbs.purge(`delete-bound-${i}`)
    expect(mocks.deleteObject).toHaveBeenCalledTimes(4)
    for (let i = 0; i < 12; i++) {
      finish[i]!()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(mocks.deleteObject).toHaveBeenCalledTimes(12)
  })

  it('purges the stored stage variants with the card', async () => {
    mocks.renderFrame.mockResolvedValue(Buffer.from('x'))
    const f = frame('purged-stage')
    await thumbs.create(f, stage(128))
    await thumbs.create(f, stage(1024, 'png'))
    await tick()
    thumbs.purge(f.id)
    await tick()
    expect(mocks.deleteObject).toHaveBeenCalledWith('thumb/purged-stage.jpg')
    expect(mocks.deleteObject).toHaveBeenCalledWith('thumb/purged-stage-w128.jpg')
    expect(mocks.deleteObject).toHaveBeenCalledWith('thumb/purged-stage-w1024.png')
  })

  it('renders a script-written revision offline, and a later human revision online', async () => {
    vi.useFakeTimers()
    try {
      mocks.renderFrame.mockResolvedValue(Buffer.from('x'))
      const f = frame('script-touched')
      f.html = '<body><img src="https://img.example/x.png"></body>'
      const live = vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === f.id ? f : undefined))
      thumbs.remember(f, stage(128))
      /* the run's write marks the revision it produced — that revision's
         automatic preview renders without the network */
      f.updatedAt = 2
      thumbs.noteScriptFrameWrite(f.id)
      thumbs.noteDesignWrite(f.id)
      await vi.advanceTimersByTimeAsync(thumbs.REFRESH_AFTER_WRITE_MS + 10)
      expect(mocks.renderFrame).toHaveBeenCalledTimes(1)
      expect(mocks.renderFrame).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ offline: true }),
      )
      /* a collaborator's revision afterwards renders online again — the
         mark covers exactly the revision the script wrote */
      f.updatedAt = 3
      thumbs.noteDesignWrite(f.id)
      await vi.advanceTimersByTimeAsync(thumbs.REFRESH_AFTER_WRITE_MS + 10)
      expect(mocks.renderFrame).toHaveBeenCalledTimes(2)
      expect(mocks.renderFrame).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        expect.not.objectContaining({ offline: true }),
      )
      live.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
})
