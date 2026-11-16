import { beforeEach, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { fixtureUrl, pagePerTest } from './browser'

/* useFitLevel folds a tab strip by measuring it, and jsdom has no layout: the
   Layers island's strip in a real Chromium, at the width it overflowed at
   (252px, the island at 1280 and 1440) and at roomier and tighter ones. Skipped where no Chromium is installed. */

const TABS = ['Layers', 'Assets', 'Tokens', 'Library']

interface StripState {
  compact: Record<string, boolean>
  overflow: boolean
}

describe.skipIf(!findBrowserPath())('useFitLevel in Chromium', { timeout: 30_000 }, () => {
  const pages = pagePerTest()
  let page: Page

  beforeEach(async () => {
    page = await pages.open()
    await page.goto(fixtureUrl('fitLevel.html'))
    await page.waitForFunction(() => 'renderStrip' in window)
  })

  async function strip(width: number, active = 'Layers', tabs = TABS): Promise<StripState> {
    await page.evaluate((props) => (window as unknown as { renderStrip(p: unknown): void }).renderStrip(props), {
      width,
      active,
      tabs,
    })
    /* the folds run in layout effects; give them a frame to settle */
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
    return page.evaluate(() => {
      const list = document.querySelector<HTMLElement>('[data-slot="panel-tabs"]')!
      const compact: Record<string, boolean> = {}
      for (const tab of document.querySelectorAll<HTMLElement>('[role="tab"]'))
        compact[tab.textContent ?? ''] = tab.hasAttribute('data-compact')
      const end = list.getBoundingClientRect().right
      const overflow =
        list.scrollWidth > list.clientWidth + 1 ||
        [...list.querySelectorAll('[role="tab"]')].some((tab) => tab.getBoundingClientRect().right > end + 0.5)
      return { compact, overflow }
    })
  }

  it('keeps every label when the strip has room', async () => {
    const state = await strip(480)
    expect(state.compact).toEqual({ Layers: false, Assets: false, Tokens: false, Library: false })
    expect(state.overflow).toBe(false)
  })

  it('folds the tabs not in view first at the island’s width, and nothing overflows', async () => {
    const state = await strip(252, 'Library')
    expect(state.compact).toEqual({ Layers: true, Assets: true, Tokens: true, Library: false })
    expect(state.overflow).toBe(false)
  })

  it('folds the open tab last, and unfolds when the strip widens again', async () => {
    const narrow = await strip(150, 'Assets')
    expect(Object.values(narrow.compact)).toEqual([true, true, true, true])
    expect(narrow.overflow).toBe(false)
    const wide = await strip(480, 'Assets')
    expect(Object.values(wide.compact)).toEqual([false, false, false, false])
  })

  it('keeps each label as the folded tab’s accessible name', async () => {
    await strip(252, 'Layers')
    const names = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[role="tab"][data-compact]')].map((tab) => tab.innerText.trim()),
    )
    /* innerText skips what is not rendered; an sr-only label still is */
    expect(names).toEqual(['Assets', 'Tokens', 'Library'])
  })
})
