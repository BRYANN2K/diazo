import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { withFindPreviewScript, type LibrarySnapshot } from '../src/lib/findPreviewRuntime'
import { pagePerTest } from './browser'
import { fixture } from './libraryFixtures'

const SHEET = `<!doctype html><html class="dark"><head><style>
  :root{--brand:#0177d3;--unused:red}
  body{font-family:Georgia}
  .ex{padding:40px}
  .ex .content .btn{background:var(--brand);animation:pulse 1s infinite}
  .btn:hover{opacity:.8}
  .btn::after{content:'→'}
  .other{color:green}
  @media (min-width:1px){.btn{padding:8px}}
  @keyframes pulse{from{opacity:.5}}
  @keyframes unused{from{opacity:0}}
</style></head><body>
  <div class="ex"><div class="content" style="width:240px;height:140px"><button class="btn">cp.vui-button-primary</button></div></div>
  <p class="other">cp.other</p>
</body></html>`

describe.skipIf(!findBrowserPath())('⌘F snapshot', () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.setContent(withFindPreviewScript(SHEET, 't'), { waitUntil: 'load' })
  })

  it('takes the card content with the rules, keyframes and variables it uses', async () => {
    const snap = await page.evaluate(
      () =>
        new Promise<LibrarySnapshot>((resolve) => {
          window.addEventListener('message', (e) => {
            const d = e.data as { type: string; box?: unknown; snapshot?: LibrarySnapshot }
            if (d.type === 'box' && d.box) window.postMessage({ doopFindPreview: 't', snapshot: 'r1' }, '*')
            if (d.type === 'snapshot' && d.snapshot) resolve(d.snapshot)
          })
          window.postMessage({ doopFindPreview: 't', focus: 'cp.vui-button-primary' }, '*')
        }),
    )
    expect(snap.found).toBe(true)
    expect(snap.html).toMatch(/^<div class="content"/)
    expect(snap.html).not.toContain('outline')
    expect(snap.ancestors).toEqual([{ tag: 'div', attrs: [['class', 'ex']] }])
    const rules = snap.rules.join('\n')
    expect(rules).toContain('.ex .content .btn')
    expect(rules).toContain(':hover')
    expect(rules).toContain('::after')
    expect(rules).toContain('@media')
    expect(rules).not.toContain('.other')
    expect(snap.keyframes.join('')).toContain('pulse')
    expect(snap.keyframes.join('')).not.toContain('unused')
    expect(snap.vars).toEqual([['--brand', '#0177d3']])
    expect(snap.inherited).toContainEqual(['font-family', 'Georgia'])
    expect(snap.rootClasses).toEqual(['dark'])
  })

  it('copies the symbol a variant uses, drops handlers and unused rules', async () => {
    await page.setViewport({ width: 2040, height: 600 })
    await page.setContent(withFindPreviewScript(fixture('sheet-static'), 't'), { waitUntil: 'load' })
    const take = (id: string) =>
      page.evaluate(
        (text) =>
          new Promise<LibrarySnapshot>((resolve) => {
            window.addEventListener('message', (e) => {
              const d = e.data as { type: string; box?: unknown; snapshot?: LibrarySnapshot }
              if (d.type === 'box' && d.box) window.postMessage({ doopFindPreview: 't', snapshot: 'r' + text }, '*')
              if (d.type === 'snapshot' && d.snapshot) resolve(d.snapshot)
            })
            window.postMessage({ doopFindPreview: 't', focus: text, find: { text, anchor: true } }, '*')
          }),
        id,
      )
    const first = await take('bk.scb-login-minimal-email-password')
    expect(first.html).toMatch(/^<div class="v"/)
    expect(first.defs?.join('')).toContain('<symbol id="key"')
    expect(first.rules.join('\n')).not.toContain('.unused')
    const second = await take('bk.scb-login-social-with-email-option')
    expect(second.html).not.toContain('onclick')
  })
})
