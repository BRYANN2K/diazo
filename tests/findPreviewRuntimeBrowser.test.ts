import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { withFindPreviewScript } from '../src/lib/findPreviewRuntime'
import { pagePerTest } from './browser'
import { fixture } from './libraryFixtures'

/* A library sheet: two cards, the second rendered by a script after load.
   The page is its own parent here: the script posts to itself, and the
   sheet's first script keeps the boxes it posts. (An init script would not
   see them: setContent writes into the page's open document, and
   evaluateOnNewDocument only runs in a new one.) */
const SHEET = `<!doctype html><html><head><style>
  .card{width:240px;height:140px;margin:20px;display:block}
</style><script>
  window.boxes = []
  addEventListener('message', function (e) { if (e.data && e.data.type === 'box') window.boxes.push(e.data) })
</script></head><body>
  <div class="card" id="a"><span>cp.vui-button-primary</span></div>
  <div id="later"></div>
  <script>setTimeout(function(){document.getElementById('later').innerHTML='<div class="card" id="b"><span>cp.vui-badge</span></div>'},200)</script>
</body></html>`

describe.skipIf(!findBrowserPath())('⌘F preview runtime', () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.setContent(withFindPreviewScript(SHEET, 't1'), { waitUntil: 'load' })
    /* a reload would start a new window, without this mark */
    await page.evaluate(() => {
      ;(window as unknown as { kept: boolean }).kept = true
    })
  })

  const send = (focus: string) =>
    page.evaluate((f) => window.postMessage({ doopFindPreview: 't1', focus: f }, '*'), focus)
  const outlined = () =>
    page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[style*="outline"]')].map((el) => el.id))

  it('moves the outline to the new focus without reloading the document', async () => {
    await send('cp.vui-button-primary')
    await page.waitForFunction(() => (window as unknown as { boxes: unknown[] }).boxes.length >= 1)
    expect(await outlined()).toEqual(['a'])

    await send('cp.vui-badge')
    await page.waitForFunction(() =>
      (window as unknown as { boxes: { focus: string; box: unknown }[] }).boxes.some(
        (b) => b.focus === 'cp.vui-badge' && b.box,
      ),
    )
    expect(await outlined()).toEqual(['b'])
    /* the previous element's inline style is back as it was */
    expect(await page.evaluate(() => document.getElementById('a')!.getAttribute('style'))).toBeFalsy()
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true)
  })

  it('ignores messages carrying another token', async () => {
    await page.evaluate(() => window.postMessage({ doopFindPreview: 'other', focus: 'cp.vui-button-primary' }, '*'))
    await new Promise((r) => setTimeout(r, 100))
    expect(await outlined()).toEqual([])
  })

  describe('by locator', () => {
    const boxFor = (focus: string, find: Record<string, unknown>) =>
      page.evaluate(
        (f, how) =>
          new Promise<{ w: number; h: number } | null>((resolve) => {
            window.addEventListener('message', (e) => {
              const d = e.data as { type?: string; focus?: string; box?: { w: number; h: number } | null }
              if (d.type === 'box' && d.focus === f) resolve(d.box ?? null)
            })
            window.postMessage({ doopFindPreview: 't2', focus: f, find: how }, '*')
          }),
        focus,
        find,
      )

    it('frames the design of a static variant, not the wrapper around its caption', async () => {
      await page.setViewport({ width: 2040, height: 600 })
      await page.setContent(withFindPreviewScript(fixture('sheet-static'), 't2'), { waitUntil: 'load' })
      const id = 'bk.scb-login-social-with-email-option'
      const byAnchor = await boxFor(id, { text: id, anchor: true })
      const byText = await boxFor(`${id} `, { text: id })
      expect(byAnchor).toMatchObject({ w: 490, h: 300 })
      /* the old text focus climbed to the cell, caption included: taller */
      expect(byText!.h).toBeGreaterThan(300)
    })

    it('takes a selector first', async () => {
      const html = fixture('sheet-static').replace('<div class="v dk">', '<div class="v dk" data-doop-id="dk1">')
      await page.setContent(withFindPreviewScript(html, 't2'), { waitUntil: 'load' })
      expect(await boxFor('k', { text: 'nothing', selector: '[data-doop-id="dk1"]' })).toMatchObject({ w: 490, h: 300 })
    })

    it('finds a scripted variant by its anchor once the script ran', async () => {
      await page.setViewport({ width: 2040, height: 800 })
      await page.setContent(withFindPreviewScript(fixture('sheet-scripted'), 't2'), { waitUntil: 'load' })
      const box = await boxFor('cp.tuff-json-viewer', { text: 'cp.tuff-json-viewer', anchor: true })
      const d = (await page.evaluate(() => {
        const r = document.querySelectorAll('.d')[2]!.getBoundingClientRect()
        return { w: r.width, h: r.height }
      })) as { w: number; h: number }
      expect(box).toMatchObject({ w: Math.round(d.w), h: Math.round(d.h) })
    })
  })

  describe('motion', () => {
    const MOVING = `<!doctype html><html><head><style>
      @keyframes slide{to{transform:translateX(100px)}}
      .m{width:40px;height:40px;animation:slide 2s linear infinite}
      .h{width:40px;height:40px;background:rgb(0,0,0);transition:background-color 1ms}
      .h:hover{background:rgb(255,0,0)}
    </style></head><body><div class="m" id="m"></div><div class="h" id="h"></div>
    <script>document.getElementById('h').addEventListener('pointerenter', function () { document.body.dataset.hovered = '1' })</script>
    </body></html>`

    const time = () => page.evaluate(() => Number(document.getAnimations()[0]?.currentTime ?? 0))

    it('lets CSS animations run, pauses them on { play: false } and plays them on { play: true }', async () => {
      await page.setContent(withFindPreviewScript(MOVING, 't3'), { waitUntil: 'load' })
      const first = await time()
      await new Promise((r) => setTimeout(r, 150))
      expect(await time()).toBeGreaterThan(first)
      await page.evaluate(() => window.postMessage({ doopFindPreview: 't3', play: false }, '*'))
      await page.waitForFunction(() => document.getAnimations()[0]?.playState === 'paused')
      const held = await time()
      await new Promise((r) => setTimeout(r, 150))
      expect(await time()).toBe(held)
      await page.evaluate(() => window.postMessage({ doopFindPreview: 't3', play: true }, '*'))
      await page.waitForFunction(() => document.getAnimations()[0]?.playState === 'running')
    })

    it('lets a hover demo react to the pointer, its own script included', async () => {
      await page.setContent(withFindPreviewScript(MOVING, 't3'), { waitUntil: 'load' })
      await page.hover('#h')
      await page.waitForFunction(() => document.body.dataset.hovered === '1')
      await page.waitForFunction(
        () => getComputedStyle(document.getElementById('h')!).backgroundColor === 'rgb(255, 0, 0)',
      )
    })
  })
})
