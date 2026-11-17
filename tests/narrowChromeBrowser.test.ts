import { describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'

/* The canvas chrome where it is tightest: the Agents panel at its 260px
   minimum and the longer pt-BR labels. Nothing may leave its box. */
describe.skipIf(!findBrowserPath())('the canvas chrome at its narrowest, in pt-BR', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page

  async function open() {
    page = await pages.open()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 900, height: 800 })
    await page.goto(fixtureUrl('narrowChrome.html'))
  }

  it("keeps the plan card's actions inside the card at 260px", async () => {
    await open()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#panel button')].some((b) => b.textContent === 'Cancelar'),
    )
    const escaped = await page.evaluate(() => {
      const cancel = [...document.querySelectorAll('#panel button')].find((b) => b.textContent === 'Cancelar')
      const row = cancel?.parentElement
      const card = row?.closest('[data-slot="card"]')
      if (!row || !card) return ['no plan card']
      const box = card.getBoundingClientRect()
      return [...row.querySelectorAll('button')]
        .filter((b) => {
          const r = b.getBoundingClientRect()
          return r.left < box.left - 0.5 || r.right > box.right + 0.5
        })
        .map((b) => b.textContent ?? '')
    })
    expect(escaped).toEqual([])
  })

  it('lets the toast behind a two-line toast peek above it', async () => {
    await open()
    await page.waitForSelector('[data-slot="toast"][data-depth="1"]')
    /* the stack takes the front toast's height once it is measured */
    await page.waitForFunction(() => {
      const stack = document.querySelector<HTMLElement>('[data-slot="toast-stack"]')
      return !!stack?.style.getPropertyValue('--toast-front-h')
    })
    /* and the toasts have entered and settled into their places */
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished'))
    const boxes = await page.evaluate(() => {
      const top = (depth: number) =>
        document.querySelector(`[data-slot="toast"][data-depth="${depth}"]`)!.getBoundingClientRect().top
      const front = document.querySelector<HTMLElement>('[data-slot="toast"][data-depth="0"]')!
      return { front: top(0), behind: top(1), frontHeight: front.offsetHeight }
    })
    /* two lines: taller than the old one-line stack */
    expect(boxes.frontHeight).toBeGreaterThan(46)
    expect(boxes.behind).toBeLessThan(boxes.front)
  })
})
