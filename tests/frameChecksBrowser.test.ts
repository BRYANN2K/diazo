import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { runChecksOnPage } from '../server/frameChecks'
import { pagePerTest } from './browser'

/* The collectors in a real Chromium: layout, computed styles and real Tab
   presses are what the checks are about, and none of them exist in a fake
   DOM. Skipped where no Chromium is installed. */

describe.skipIf(!findBrowserPath())('frame checks in Chromium', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
  })

  async function check(body: string, head = '') {
    const html = `<!doctype html><html><head>${head}</head><body style="margin:0;font:16px sans-serif">${body}</body></html>`
    await page.setContent(html)
    return runChecksOnPage(page, html)
  }

  it('passes a fluid, readable page with visible focus', async () => {
    const checks = await check(
      '<main style="max-width:100%;padding:16px"><p>Plain text</p><a href="#x" style="display:inline-block;padding:14px 16px">Next step</a></main>',
    )
    expect(checks.issues).toEqual([])
    expect(checks.focus).toEqual({ focusables: 1, reached: 1, withoutVisibleFocus: 0 })
  })

  it('finds overflow at phone width only', async () => {
    const checks = await check('<div data-doop-id="row" style="width:900px">wide row</div>')
    const overflow = checks.issues.find((i) => i.ruleId === 'FC-OVERFLOW')!
    expect(overflow.widths).toEqual([375, 768])
    expect(overflow.elementId).toBe('row')
  })

  it('finds clipped text and small tap targets', async () => {
    const checks = await check(
      '<p style="height:20px;overflow:hidden;width:120px">a long paragraph that wraps onto several lines</p>' +
        '<button style="width:24px;height:24px;padding:0">×</button>',
    )
    expect(checks.issues.map((i) => i.ruleId)).toEqual(expect.arrayContaining(['FC-CLIP', 'FC-TAP']))
  })

  it('finds low contrast', async () => {
    const checks = await check('<p style="color:#bbb">pale text</p>')
    expect(checks.issues.find((i) => i.ruleId === 'FC-CONTRAST')?.widths).toEqual([375, 768, 1440])
  })

  it('finds a control whose focus is invisible and a positive tabindex', async () => {
    const checks = await check(
      '<button style="outline:none">Silent</button><a href="#a" tabindex="2" style="display:inline-block;padding:14px">Jump</a>',
      '<style>*:focus{outline:none}</style>',
    )
    const rules = checks.issues.map((i) => i.ruleId)
    expect(rules).toContain('FC-FOCUS-VISIBLE')
    expect(rules).toContain('FC-TAB-ORDER')
  })
})
