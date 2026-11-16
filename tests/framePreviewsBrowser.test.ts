import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import sharp from 'sharp'
import { findBrowserPath } from '../server/screenshot'
import type { Frame } from '../shared/types'
import { pagePerTest } from './browser'
import { canvasFrame, prepareCanvasPage, showCanvasPage } from './canvasPageFixture'

/* A page of many screens zoomed out: every frame shows the server's picture
   of its design (here a solid colour the test serves), not a white box, and
   the zoom-out mounts no document. */
describe.skipIf(!findBrowserPath())('frames on a zoomed-out canvas', () => {
  const pages = pagePerTest()
  let page: Page
  let picture: Buffer
  /** the /i/ requests the page made, path and query */
  let asked: string[]
  /** paths answered busy once before the picture */
  let busyOnce: Set<string>

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

  beforeAll(async () => {
    picture = await sharp({ create: { width: 64, height: 45, channels: 3, background: '#e11d48' } })
      .png()
      .toBuffer()
  })

  beforeEach(async () => {
    asked = []
    busyOnce = new Set()
    page = await pages.open()
    page.setDefaultTimeout(15_000)
    await page.setViewport({ width: 1600, height: 1000 })
    await prepareCanvasPage(page, (path) => {
      if (!path.startsWith('/i/')) return undefined
      asked.push(path)
      const id = path.slice(3, path.indexOf('.'))
      if (busyOnce.delete(id))
        return { status: 503, contentType: 'application/json', body: '{}', headers: { 'Retry-After': '0' } }
      return { status: 200, contentType: 'image/png', body: picture }
    })
  })

  async function fitAll() {
    await page.keyboard.down('Shift')
    await page.keyboard.press('Digit1')
    await page.keyboard.up('Shift')
  }

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

  it('shows every frame as its picture, mounting no document', async () => {
    await showCanvasPage(page, [...grid, deferred])
    await fitAll()
    await page.waitForFunction(
      (n) => {
        const imgs = [...document.querySelectorAll<HTMLImageElement>('[data-frame-image] img')]
        return imgs.filter((img) => img.complete && img.naturalWidth > 0).length >= n
      },
      {},
      grid.length + 1,
    )
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
    await page.waitForFunction(
      (n) =>
        [...document.querySelectorAll<HTMLImageElement>('[data-frame-image] img')].filter((img) => img.naturalWidth > 0)
          .length >= n,
      {},
      grid.length + 1,
    )
    await expect.poll(() => asked.some((path) => path.startsWith('/i/deferred.jpg?lod='))).toBe(true)
    const state = await page.evaluate(() => {
      const frame = window.canvasPageHarness.frames().find((f) => f.id === 'deferred')
      return { deferred: frame?.htmlDeferred, html: frame?.html }
    })
    expect(state).toEqual({ deferred: true, html: '' })
  })

  it('asks a busy renderer again and shows the picture when it comes', async () => {
    busyOnce = new Set(grid.slice(0, 3).map((f) => f.id))
    await showCanvasPage(page, grid)
    await fitAll()
    await page.waitForFunction(
      (n) =>
        [...document.querySelectorAll<HTMLImageElement>('[data-frame-image] img')].filter((img) => img.naturalWidth > 0)
          .length >= n,
      {},
      grid.length,
    )
    expect(busyOnce.size).toBe(0)
    expect(asked.filter((path) => path.startsWith('/i/s0.')).length).toBe(2)
  })

  it('keeps the pictures in memory: zooming back out asks for nothing', async () => {
    await showCanvasPage(page, grid)
    await fitAll()
    await page.waitForFunction(
      (n) =>
        [...document.querySelectorAll<HTMLImageElement>('[data-frame-image] img')].filter((img) => img.naturalWidth > 0)
          .length >= n,
      {},
      grid.length,
    )
    /* in on one frame (it goes live), then out again */
    await page.click('[data-frame-title]')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Digit2')
    await page.keyboard.up('Shift')
    await page.waitForSelector('iframe[data-doop-frame]')
    await page.keyboard.press('Escape')
    /* the sharper pictures the close-up asked for have landed */
    await new Promise((r) => setTimeout(r, 800))
    const before = asked.length
    await fitAll()
    await new Promise((r) => setTimeout(r, 800))
    expect(await shown()).toBe(grid.length)
    expect(asked.length).toBe(before)
  })
})
