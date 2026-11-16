import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import type { Frame } from '../shared/types'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'

/* the harness is declared on Window in canvasClipboardBrowser.test.ts */

const FRAME: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Frame',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  html: `<!doctype html><html><body style="margin:0;padding:20px">
  <section id="card" style="width:200px;height:100px"><h1>Card</h1></section>
  <p id="other">Other element</p>
</body></html>`,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Tester',
}

/**
 * A pick is resolved by the frame's runtime (`doop:select`), whose answer
 * becomes the frame's probe; an effect then hands the probe to the store. A
 * pick that changes between that answer and the effect (a paste picking its
 * copies) must stand: the answer about the old pick is stale by then.
 */
describe.skipIf(!findBrowserPath())('a late answer about an element pick', { timeout: 20_000 }, () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    page.setDefaultTimeout(4_000)
    await page.setViewport({ width: 1200, height: 900 })
    // CanvasPage installs the real shortcuts; its live server connection is outside this test.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'WebSocket', {
        value: class {
          readyState = 0
          static OPEN = 1
          close() {}
        },
      })
    })
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const path = new URL(request.url()).pathname
      if (path === '/api/auth/get-session')
        await request.respond({ status: 200, contentType: 'application/json', body: 'null' })
      else if (path === '/api/canvases/c/fonts')
        await request.respond({ status: 200, contentType: 'application/json', body: '[]' })
      else if (path.startsWith('/api/'))
        await request.respond({ status: 200, contentType: 'application/json', body: '{}' })
      else await request.continue()
    })
    await page.goto(fixtureUrl('canvasClipboard.html'))
    await page.waitForFunction(() => !!window.canvasClipboardHarness && !!document.querySelector('.stage'))
    await page.evaluate((frame) => window.canvasClipboardHarness.seed([frame]), FRAME)
    const iframe = await page.waitForSelector('iframe[data-doop-frame]')
    const doc = await iframe?.contentFrame()
    if (!doc) throw new Error('The frame has no document')
    await doc.waitForSelector('#other')
  })

  it('keeps a pick made after the answer about the previous one', async () => {
    await page.evaluate(() => {
      const answers: string[] = []
      ;(window as unknown as { selectAnswers: string[] }).selectAnswers = answers
      /* registered after the frame's own listener, so it runs right after the
         frame has taken the answer and before React runs the frame's effects:
         the window a paste fell into */
      window.addEventListener('message', (ev: MessageEvent) => {
        const data = ev.data as { type?: string; hit?: { selector?: string } | null }
        if (data?.type !== 'doop:select-result') return
        answers.push(data.hit?.selector ?? '')
        if (answers.length === 1) window.canvasClipboardHarness.repick('#other', '#card')
      })
      window.canvasClipboardHarness.pick('#card', '#other')
    })
    /* the new pick's primary is resolved in turn, unless the stale answer
       took the pick back first */
    await page.waitForFunction(() => {
      const answers = (window as unknown as { selectAnswers: string[] }).selectAnswers
      return answers.includes('#card') || window.canvasClipboardHarness.picked().length === 1
    })
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    )
    expect(await page.evaluate(() => (window as unknown as { selectAnswers: string[] }).selectAnswers[0])).toBe(
      '#other',
    )
    expect(await page.evaluate(() => window.canvasClipboardHarness.picked())).toEqual(['#other', '#card'])
  })
})
