import { afterAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import type { Frame } from '../shared/types'
import { findBrowserPath } from '../server/screenshot'
import { pagePerTest } from './browser'
import { prepareCanvasPage, showCanvasPage } from './canvasPageFixture'
import { Client, startServer, type Server } from './harness'

/** A repeatable observation, not a timing assertion on shared machines.
 * Production client bundle, real cold backend and renderer; the canvas room
 * and session are supplied by the fixture. All preview bytes are real. */
describe.skipIf(!findBrowserPath())('first zoom-out task measurement', () => {
  const pages = pagePerTest()
  let server: Server
  afterAll(() => server?.stop())

  it('records the longest task and tasks above 50ms while cold previews arrive', async () => {
    server = await startServer()
    const owner = await new Client(server).signUp('preview-perf@test.dev', 'Preview performance')
    const canvas = await (await owner.post('/api/canvases', { name: '200 frames' })).json()
    const frames: Frame[] = []
    for (let i = 0; i < 200; i++) {
      const sections = Array.from(
        { length: 6 },
        (_, row) =>
          `<section style="padding:40px;border-bottom:1px solid #ddd"><h2>Section ${row}</h2><p>Layout and typography for frame ${i}.</p><div style="height:80px;background:#eee"></div></section>`,
      ).join('')
      const res = await owner.post(`/api/canvases/${canvas.id}/frames`, {
        name: `Frame ${i}`,
        x: (i % 20) * 1400,
        y: Math.floor(i / 20) * 1000,
        width: 1280,
        height: 900,
        html: `<body style="margin:0;font:16px system-ui"><header style="height:220px;background:hsl(${i * 29} 70% 40%);color:white;font-size:56px">Frame ${i}</header>${sections}</body>`,
      })
      expect(res.status).toBe(200)
      frames.push({ ...(await res.json()), canvasId: 'c', pageId: undefined })
    }
    const page = await pages.open()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    let begin!: () => void
    const measuring = new Promise<void>((resolve) => {
      begin = resolve
    })
    let responses = 0
    const ids = new Set<string>()
    await prepareCanvasPage(page, async (path) => {
      if (!path.startsWith('/i/')) return undefined
      ids.add(path.split('.')[0]!)
      await measuring
      const res = await owner.get(path)
      const body = Buffer.from(await res.arrayBuffer())
      if (++responses === 1) await page.evaluate(() => performance.mark('preview-first-response'))
      return {
        status: res.status,
        body,
        contentType: res.headers.get('content-type') ?? 'image/jpeg',
        headers: { 'Cache-Control': 'no-store' },
      }
    })
    await showCanvasPage(page, frames)
    await page.tracing.start({
      categories: ['toplevel', 'devtools.timeline', 'blink.user_timing'],
      path: '/tmp/zoom-first-out-trace.json',
    })
    await page.evaluate(() => performance.mark('zoom-start'))
    begin()
    await page.keyboard.down('Shift')
    await page.keyboard.press('Digit1')
    await page.keyboard.up('Shift')
    await page.waitForFunction(
      () => {
        const pictures = document.querySelectorAll('[data-frame-image="ready"] img')
        return (
          pictures.length >= 125 &&
          !document.querySelector('[data-frame-image="loading"]') &&
          [...pictures].every((img) => (img as HTMLImageElement).complete)
        )
      },
      { timeout: 120_000, polling: 'mutation' },
    )
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    const traceBytes = await page.tracing.stop()
    interface TraceEvent {
      name: string
      ph: string
      ts: number
      dur?: number
      tid: number
      args?: { name?: string }
    }
    const events = (JSON.parse(Buffer.from(traceBytes!).toString()) as { traceEvents: TraceEvent[] }).traceEvents
    const main = events.find((event) => event.name === 'thread_name' && event.args?.name === 'CrRendererMain')!
    const start = events.find((event) => event.name === 'zoom-start')!.ts
    const first = events.find((event) => event.name === 'preview-first-response')?.ts ?? start
    const tasks = events
      .filter(
        (event) => event.tid === main.tid && event.ph === 'X' && event.name.endsWith('::RunTask') && event.ts >= start,
      )
      .map((event) => ({ at: event.ts, ms: event.dur! / 1000 }))
    expect(tasks.length).toBeGreaterThan(0)
    const arrivals = tasks.filter((task) => task.at >= first)
    const stats = (list: typeof tasks) => ({
      longestMs: Math.max(0, ...list.map((task) => task.ms)),
      over50ms: list.filter((task) => task.ms > 50).length,
      totalMs: list.reduce((sum, task) => sum + task.ms, 0),
    })
    const result = {
      frames: frames.length,
      viewport: '1440x900 dpr1',
      responses,
      uniqueImages: ids.size,
      firstZoomOut: stats(tasks),
      pictureArrivals: stats(arrivals),
      iframes: await page.$$eval('iframe[data-doop-frame]', (els) => els.length),
      pictured: await page.$$eval('[data-frame-image="ready"] img', (els) => els.length),
    }
    writeFileSync('/tmp/zoom-first-out-metrics.json', JSON.stringify(result, null, 2) + '\n')
    expect(result.iframes).toBe(0)
    expect(result.uniqueImages).toBeGreaterThanOrEqual(125)
  }, 150_000)
})
