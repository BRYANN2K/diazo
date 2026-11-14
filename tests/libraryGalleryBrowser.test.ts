import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'puppeteer-core'
import { findBrowserPath } from '../server/screenshot'
import { familyOf, itemSummary, type LibrarySearchHit } from '../shared/library'
import { fixtureUrl, openBrowser, type TestBrowser } from './browser'
import { syntheticItems } from './libraryFixtures'

/* The gallery in Chromium with 10,000 items behind its API: a windowed
   grid (never more than 120 tiles in the document) and no iframe until a
   tile is rested on, one at most after. */

const families: LibrarySearchHit[] = familyOf(syntheticItems(10_000)).map((f) => ({
  libraryId: 'lib1',
  libraryName: 'Design Library',
  item: itemSummary(f.family, '/i/none.jpg?preview'),
  variants: [],
  variantCount: f.variants.length,
  score: 0,
}))

describe.skipIf(!findBrowserPath())('the library gallery', () => {
  let browser: TestBrowser
  let page: Page

  beforeAll(async () => {
    browser = await openBrowser()
    page = await browser.newPage()
    page.setDefaultTimeout(10_000)
    await page.setViewport({ width: 1280, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      const url = new URL(req.url())
      if (url.pathname === '/api/libraries/lib1') {
        return void req.respond({
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'lib1',
            name: 'Design Library',
            role: 'read',
            library: {
              description: '',
              visibility: 'private',
              items: families.length,
              variants: 0,
              index: null,
              rulesVersion: 1,
            },
            workspaceId: null,
            listed: false,
            rules: {},
            rulesText: [],
            taxonomy: { kinds: [], sources: [], categories: [] },
          }),
        })
      }
      if (url.pathname === '/api/libraries/lib1/items') {
        const offset = Number(url.searchParams.get('cursor') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 60)
        const hits = families.slice(offset, offset + limit)
        return void req.respond({
          contentType: 'application/json',
          body: JSON.stringify({
            hits,
            total: families.length,
            facets: { kind: [], category: [], source: [], tag: [] },
            ...(offset + limit < families.length ? { cursor: String(offset + limit) } : {}),
          }),
        })
      }
      if (url.pathname.startsWith('/i/') || url.pathname.startsWith('/api/')) {
        return void req.respond({ status: 404, body: '' })
      }
      void req.continue()
    })
    await page.goto(fixtureUrl('libraryGallery.html'))
    await page.waitForSelector('[data-item-id]')
  }, 60_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
  })

  const tiles = () => page.$$eval('[data-item-id]', (els) => els.length)

  it('keeps under 120 tiles in the document while scrolling, and mounts no iframe', async () => {
    expect(await tiles()).toBeLessThan(120)
    for (let i = 0; i < 6; i++) {
      await page.$eval('[data-testid="library-grid"]', (el) => el.scrollBy(0, 3000))
      await new Promise((r) => setTimeout(r, 150))
      expect(await tiles()).toBeLessThan(120)
    }
    expect(await page.$('iframe')).toBeNull()
  })

  it('mounts one live preview for the tile the pointer rests on', async () => {
    const first = await page.$('[data-item-id]')
    const box = (await first!.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await new Promise((r) => setTimeout(r, 700))
    expect((await page.$$('iframe')).length).toBeLessThanOrEqual(1)
  })
})
