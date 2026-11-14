import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { withFindPreviewScript } from '../src/lib/findPreviewRuntime'
import { pagePerTest } from './browser'

/* A library sheet: two cards, the second rendered by a script after load. */
const SHEET = `<!doctype html><html><head><style>
  .card{width:240px;height:140px;margin:20px;display:block}
</style></head><body>
  <div class="card" id="a"><span>cp.vui-button-primary</span></div>
  <div id="later"></div>
  <script>setTimeout(function(){document.getElementById('later').innerHTML='<div class="card" id="b"><span>cp.vui-badge</span></div>'},200)</script>
</body></html>`

describe.skipIf(!findBrowserPath())('⌘F preview runtime', () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    /* the page is its own parent here: the script posts to itself */
    await page.evaluateOnNewDocument(() => {
      const w = window as unknown as { boxes: unknown[]; loads: number }
      w.boxes = []
      w.loads = (w.loads ?? 0) + 1
      window.addEventListener('message', (e) => {
        const data = e.data as { type?: string }
        if (data?.type === 'box') w.boxes.push(data)
      })
    })
    await page.setContent(withFindPreviewScript(SHEET, 't1'), { waitUntil: 'load' })
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
    expect(await page.evaluate(() => (window as unknown as { loads: number }).loads)).toBe(1)
  })

  it('ignores messages carrying another token', async () => {
    await page.evaluate(() => window.postMessage({ doopFindPreview: 'other', focus: 'cp.vui-button-primary' }, '*'))
    await new Promise((r) => setTimeout(r, 100))
    expect(await outlined()).toEqual([])
  })
})
