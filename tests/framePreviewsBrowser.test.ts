import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import sharp from 'sharp'
import { findBrowserPath } from '../server/screenshot'
import type { Frame } from '../shared/types'
import { pagePerTest } from './browser'
import { canvasFrame, prepareCanvasPage, showCanvasPage, type FixtureResponder } from './canvasPageFixture'

/* A page of many screens zoomed out: every frame shows the server's picture
   of its design (here a solid colour the test serves), not a white box, and
   the zoom-out mounts no document. */
describe.skipIf(!findBrowserPath())('frames on a zoomed-out canvas', () => {
  const pages = pagePerTest()
  let page: Page
  let picture: Buffer
  /** a different colour, served when the test wants a visibly new render */
  let newer: Buffer
  /** the /i/ requests the page made, path and query */
  let asked: string[]
  /** frame ids answered busy once, with the status to answer */
  let busyOnce: Map<string, number>
  /** frame ids first answered `X-Doop-Preview: stale` */
  let staleOnce: Set<string>
  /** a test's own responder, consulted before the default picture answer */
  let override: FixtureResponder | undefined

  const grid = Array.from({ length: 24 }, (_, i) =>
    canvasFrame({
      id: `s${i}`,
      name: `Screen ${i}`,
      x: (i % 6) * 1400,
      y: Math.floor(i / 6) * 1000,
      width: 1280,
      height: 900,
    }),
  )
  /* a frame of another page, sent without its HTML */
  const deferred: Frame = {
    ...canvasFrame({ id: 'deferred', name: 'Deferred', x: 0, y: 4200, width: 1280, height: 900 }),
    html: '',
    htmlDeferred: true,
  }
  /* one frame alone: the surface and its only picture are unambiguous */
  const one = () => canvasFrame({ id: 'one', name: 'One', x: 0, y: 0, width: 1280, height: 900 })

  beforeAll(async () => {
    const make = (background: string) =>
      sharp({ create: { width: 64, height: 45, channels: 3, background } })
        .png()
        .toBuffer()
    picture = await make('#e11d48')
    newer = await make('#16a34a')
  })

  beforeEach(async () => {
    asked = []
    busyOnce = new Map()
    staleOnce = new Set()
    override = undefined
    page = await pages.open()
    page.setDefaultTimeout(15_000)
    await page.setViewport({ width: 1600, height: 1000 })
    await prepareCanvasPage(page, (path) => {
      if (!path.startsWith('/i/')) return undefined
      asked.push(path)
      const custom = override?.(path)
      if (custom !== undefined) return custom
      const id = path.slice(3, path.indexOf('.'))
      const busy = busyOnce.get(id)
      if (busy !== undefined) {
        busyOnce.delete(id)
        return { status: busy, contentType: 'application/json', body: '{}', headers: { 'Retry-After': '0' } }
      }
      const stale = staleOnce.delete(id)
      return {
        status: 200,
        contentType: 'image/png',
        body: picture,
        headers: stale ? { 'X-Doop-Preview': 'stale' } : {},
      }
    })
  })

  async function fitAll() {
    await page.keyboard.down('Shift')
    await page.keyboard.press('Digit1')
    await page.keyboard.up('Shift')
  }

  /** at least `n` decoded pictures on the stage */
  const pictured = (n: number) =>
    page.waitForFunction(
      (count) =>
        [...document.querySelectorAll<HTMLImageElement>('[data-frame-image] img')].filter(
          (img) => img.complete && img.naturalWidth > 0,
        ).length >= count,
      {},
      n,
    )

  /** frames whose surface shows a loaded picture */
  const shown = () =>
    page.$$eval(
      '[data-frame-surface]',
      (surfaces) =>
        surfaces.filter((s) => {
          const img = s.querySelector<HTMLImageElement>('[data-frame-image] img')
          return !!img && img.complete && img.naturalWidth > 0
        }).length,
    )

  /** Wait on completed resource requests, including the camera settle
   *  interval; cache hits need no network. No fixed render-duration sleep. */
  async function requestsSettled() {
    await page.waitForFunction(() => {
      const count = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/i/')).length
      const w = window as unknown as { __requests?: { count: number; since: number } }
      if (w.__requests?.count !== count) w.__requests = { count, since: performance.now() }
      return performance.now() - w.__requests.since >= 700
    })
  }

  /** the one surface's picture element (single-frame pages only) */
  const theImage = () => page.waitForSelector('[data-frame-surface] [data-frame-image] img')

  it('shows every frame as its picture, mounting no document', async () => {
    await showCanvasPage(page, [...grid, deferred])
    await fitAll()
    await pictured(grid.length + 1)
    expect(await page.$$eval('iframe[data-doop-frame]', (els) => els.length)).toBe(0)
    expect(await shown()).toBe(grid.length + 1)

    /* asked at about the size it shows, never the full-size render */
    expect(asked.length).toBeGreaterThan(0)
    for (const path of asked) expect(path).toMatch(/^\/i\/[\w-]+\.jpg\?lod=(128|256)&v=\d+$/)

    /* painted on top: the frame's white backdrop does not cover it */
    const box = await page.$eval('[data-frame-surface]', (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    const shot = await page.screenshot({ type: 'png', clip: { x: box.x - 2, y: box.y - 2, width: 4, height: 4 } })
    const { data } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
    expect(data[0]).toBeGreaterThan(200)
    expect(data[1]).toBeLessThan(60)
  })

  it('draws a deferred frame from its picture and leaves its HTML deferred', async () => {
    await showCanvasPage(page, [...grid, deferred])
    await fitAll()
    await pictured(grid.length + 1)
    await expect.poll(() => asked.some((path) => path.startsWith('/i/deferred.jpg?lod='))).toBe(true)
    const state = await page.evaluate(() => {
      const frame = window.canvasPageHarness.frames().find((f) => f.id === 'deferred')
      return { deferred: frame?.htmlDeferred, html: frame?.html }
    })
    expect(state).toEqual({ deferred: true, html: '' })
  })

  it('asks a busy renderer again and shows the picture when it comes', async () => {
    busyOnce = new Map(grid.slice(0, 3).map((f) => [f.id, 503]))
    await showCanvasPage(page, grid)
    await fitAll()
    await pictured(grid.length)
    expect(busyOnce.size).toBe(0)
    expect(asked.filter((path) => path.startsWith('/i/s0.')).length).toBe(2)
  })

  it('asks again past a 429 rather than taking the frame for broken', async () => {
    busyOnce.set('one', 429)
    await showCanvasPage(page, [one(), ...grid.slice(1)])
    await fitAll()
    await theImage()
    await pictured(grid.length)
    expect(asked.filter((path) => path.startsWith('/i/one.')).length).toBe(2)
  })

  it('shows a stale answer at once and asks again until the current one lands', async () => {
    staleOnce.add('one')
    await showCanvasPage(page, [one(), ...grid.slice(1)])
    await fitAll()
    await theImage()
    await pictured(1)
    /* stale beats blank — the render the server started comes back for it */
    await expect
      .poll(() => asked.filter((path) => path.startsWith('/i/one.')).length, { timeout: 10_000 })
      .toBeGreaterThan(1)
    await pictured(1)
  }, 15_000)

  it('keeps the old picture up while the edit renders, then swaps it in place', async () => {
    /* the new version's answer is held until the test says so */
    let releaseEdit: (() => void) | undefined
    override = (path) => {
      if (path.startsWith('/i/one.') && path.includes('v=1'))
        return new Promise((resolve) => {
          releaseEdit = () => resolve({ status: 200, contentType: 'image/png', body: newer })
        })
      return undefined
    }
    await showCanvasPage(page, [one(), ...grid.slice(1)])
    await fitAll()
    const img = await theImage()
    await pictured(grid.length)
    const before = await img!.evaluate((el: HTMLImageElement) => el.src)

    /* the design changes: a new version, so a new picture URL */
    await page.evaluate(() => {
      const h = window.canvasPageHarness
      h.seed(h.frames().map((f) => (f.id === 'one' ? { ...f, updatedAt: f.updatedAt + 1 } : f)))
    })
    await expect.poll(() => asked.some((path) => path.startsWith('/i/one.') && path.includes('v=1'))).toBe(true)

    /* while the render is in flight the old decode stays — no blank, no flash */
    expect(await img!.evaluate((el: HTMLImageElement) => el.src)).toBe(before)

    releaseEdit!()
    await page.waitForFunction(
      (old) => {
        const el = document.querySelector<HTMLImageElement>('[data-frame-surface] [data-frame-image] img')
        return !!el && el.src !== old && el.complete && el.naturalWidth > 0
      },
      {},
      before,
    )
  })

  it('keeps the picture over a frame gone live until the document shows, fading once', async () => {
    const liveFrame = {
      ...one(),
      html: '<body style="margin:0;background:#16a34a"><p id="live-painted">Current document</p></body>',
    }
    await showCanvasPage(page, [liveFrame, ...grid.slice(1)])
    await fitAll()
    await pictured(grid.length)

    /* watch the cover's whole life: appearing over the live iframe counts
       as covered, the opacity-0 class counts as the one fade */
    await page.evaluate(() => {
      interface CoverSeen {
        appeared: boolean
        faded: boolean
      }
      const seen: CoverSeen = { appeared: false, faded: false }
      ;(window as unknown as { __cover: CoverSeen }).__cover = seen
      const cover = () => document.querySelector('[data-frame-surface] [data-frame-image]')
      new MutationObserver(() => {
        const el = cover()
        if (!el) return
        seen.appeared = true
        if (el.classList.contains('opacity-0')) seen.faded = true
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    })

    /* zoom into the frame: its document mounts under the picture */
    await page.click('[data-frame-title]')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Digit2')
    await page.keyboard.up('Shift')
    const iframe = await page.waitForSelector('iframe[data-doop-frame]')
    const liveDocument = await iframe!.contentFrame()
    await liveDocument!.waitForSelector('#live-painted')

    /* once the document confirms it shows, the cover fades and leaves */
    await page.waitForFunction(
      () => !document.querySelector('[data-frame-surface]')?.querySelector('[data-frame-image]'),
    )
    expect(await page.evaluate(() => (window as unknown as { __cover: unknown }).__cover)).toEqual({
      appeared: true,
      faded: true,
    })
  })

  it('asks a standalone element as png so its transparency survives', async () => {
    const shape: Frame = {
      ...one(),
      id: 'shape',
      name: 'Shape',
      html: '<body data-doop-canvas-element="true"><div></div></body>',
    }
    await showCanvasPage(page, [shape, ...grid.slice(1)])
    await fitAll()
    await expect.poll(() => asked.some((path) => path.startsWith('/i/shape.png?lod='))).toBe(true)
    expect(asked.some((path) => path.startsWith('/i/shape.jpg'))).toBe(false)
    await pictured(1)
  })

  it('keeps the pictures in memory: zooming back out asks for nothing', async () => {
    await showCanvasPage(page, grid)
    await fitAll()
    await pictured(grid.length)
    /* in on one frame (it goes live), then out again */
    await page.click('[data-frame-title]')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Digit2')
    await page.keyboard.up('Shift')
    await page.waitForSelector('iframe[data-doop-frame]')
    /* the sharper pictures the close-up asked for have landed */
    await requestsSettled()
    await page.keyboard.press('Escape')
    const before = asked.length
    await fitAll()
    /* requests wait out the camera's settle timer, so give it room to fire
       before calling the request count stable */
    await page.evaluate(() => {
      delete (window as unknown as { __requests?: unknown }).__requests
    })
    await requestsSettled()
    expect(await shown()).toBe(grid.length)
    expect(asked.length).toBe(before)
  })
})
