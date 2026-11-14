import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { collectExpression, type CollectedFrame } from '../shared/libraryCollect'
import { fixture } from './libraryFixtures'

/* The in-page collector in Chromium: the scripted sheet's variants exist
   only once its script ran; the static sheet's boxes are its .v designs. */

import { pagePerTest } from './browser'

describe.skipIf(!findBrowserPath())('library collector', () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.setViewport({ width: 2040, height: 900 })
  })

  const collect = (familyId: string) =>
    page.evaluate(collectExpression({ mode: 'auto', familyId })) as Promise<CollectedFrame>

  it('reads the scripted sheet once its script ran', async () => {
    await page.setContent(fixture('sheet-scripted'), { waitUntil: 'load' })
    const out = await collect('cp.tuff-answers')
    expect(out.items.map((i) => i.id)).toEqual(['cp.tuff-chart-card', 'cp.tuff-dot-histogram', 'cp.tuff-json-viewer'])
    const cells = (await page.evaluate(() =>
      [...document.querySelectorAll('.d')].map((d) => {
        const r = d.getBoundingClientRect()
        return { x: r.left, y: r.top, w: r.width, h: r.height }
      }),
    )) as { x: number; y: number; w: number; h: number }[]
    out.items.forEach((item, i) => {
      const cell = cells[i]!
      expect(item.box.w).toBeGreaterThan(0)
      expect(item.box.h).toBeGreaterThan(0)
      expect(item.box.x).toBeGreaterThanOrEqual(Math.floor(cell.x))
      expect(item.box.x + item.box.w).toBeLessThanOrEqual(Math.ceil(cell.x + cell.w))
    })
  })

  it('boxes the static sheet on its designs', async () => {
    await page.setContent(fixture('sheet-static'), { waitUntil: 'load' })
    const out = await collect('bk.scb-login')
    expect(out.items.map((i) => [i.id, i.box.w, i.box.h])).toEqual([
      ['bk.scb-login-minimal-email-password', 490, 300],
      ['bk.scb-login-social-with-email-option', 490, 300],
    ])
  })

  it('stops at its own deadline on a huge document', async () => {
    /* a page script that never ends would block evaluate itself; the
       renderer's lease bounds that. What the collector bounds is its walk. */
    await page.setContent(
      '<!doctype html><html><body><div id="g"></div><script>' +
        "const g = document.getElementById('g'); let h = '';" +
        "for (let i = 0; i < 60000; i++) h += '<div><div class=\"v\">x</div><b>cp.big-item-' + i + '</b></div>';" +
        'g.innerHTML = h</script></body></html>',
      { waitUntil: 'load' },
    )
    const started = Date.now()
    const out = await collect('cp.big')
    expect(Date.now() - started).toBeLessThan(8000)
    expect(out.items.length).toBeGreaterThan(0)
  })
})
