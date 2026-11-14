/**
 * The README screenshots, taken from a local demo with invented content.
 *
 *   npx tsx scripts/readme-shots.ts                  # boot + seed a demo (scripts/seed-demo.ts), shoot, stop
 *   npx tsx scripts/readme-shots.ts --attach         # shoot a demo already running from seed-demo.ts
 *   npx tsx scripts/readme-shots.ts --only find,duel # some shots only
 *
 * Headless Chrome (CHROME_PATH, else the tests' Chrome for Testing) at
 * 1600×1000, device scale 2, light theme. PNGs land in .github/assets/redoop/,
 * reduced to a palette with ffmpeg when it is installed (each under 400 KB).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer, { type Page } from 'puppeteer-core'
import { API, DEMO_EMAIL, DEMO_PASSWORD, WEB, chromePath, startDemo, type Demo } from './seed-demo.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '.github/assets/redoop')

const args = process.argv.slice(2)
const attach = args.includes('--attach')
const onlyArg = args[args.indexOf('--only') + 1]
const only = args.includes('--only') && onlyArg ? new Set(onlyArg.split(',')) : null

interface Ids {
  app: string
  kit: string
  frames: Record<string, string>
}

async function session(): Promise<{ cookies: { name: string; value: string }[]; get: <T>(p: string) => Promise<T> }> {
  const res = await fetch(`${API}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: WEB },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  })
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`)
  const cookies = res.headers.getSetCookie().map((c) => {
    const [pair = ''] = c.split(';')
    const at = pair.indexOf('=')
    return { name: pair.slice(0, at), value: pair.slice(at + 1) }
  })
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  const get = async <T>(p: string) => (await (await fetch(API + p, { headers: { Cookie: header } })).json()) as T
  return { cookies, get }
}

async function lookup(get: <T>(p: string) => Promise<T>): Promise<Ids> {
  const list = await get<{ id: string; name: string }[] | { canvases: { id: string; name: string }[] }>('/api/canvases')
  const canvases = Array.isArray(list) ? list : list.canvases
  const byName = (name: string) => canvases.find((c) => c.name === name)?.id ?? ''
  const app = byName('Fieldnote — Web app')
  const canvas = await get<{ frames: { id: string; name: string }[] }>(`/api/canvases/${app}`)
  return { app, kit: byName('Fieldnote UI kit'), frames: Object.fromEntries(canvas.frames.map((f) => [f.name, f.id])) }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Click the first element matching `selector` whose text is `text`. */
async function clickText(page: Page, selector: string, text: string | RegExp): Promise<void> {
  const handles = await page.$$(selector)
  for (const h of handles) {
    const t = ((await h.evaluate((e) => e.textContent)) ?? '').trim()
    if (typeof text === 'string' ? t === text : text.test(t)) {
      await h.click()
      return
    }
  }
  throw new Error(`no ${selector} with text ${String(text)}`)
}

async function openCanvas(page: Page, ids: Ids, query = ''): Promise<void> {
  await page.goto(`${WEB}/c/${ids.app}${query}`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await pause(2500)
}

async function tab(page: Page, name: string): Promise<void> {
  await clickText(page, '[role=tab]', name)
  await pause(1200)
}

/** Select frames by their Layers rows (⇧ adds to the selection). */
async function selectFrames(page: Page, ...names: string[]): Promise<void> {
  for (const [i, name] of names.entries()) {
    if (i > 0) await page.keyboard.down('Shift')
    await clickText(page, '[role=treeitem] span, [role=treeitem]', name)
    if (i > 0) await page.keyboard.up('Shift')
    await pause(300)
  }
  await pause(600)
}

/** Zoom onto the selection (⇧2). */
async function zoomSelection(page: Page): Promise<void> {
  await page.keyboard.down('Shift')
  await page.keyboard.press('Digit2')
  await page.keyboard.up('Shift')
  await pause(1800)
}

/** Zoom to fit every frame (⇧1), after a click on the bare stage. */
async function fit(page: Page): Promise<void> {
  await page.mouse.click(1000, 900)
  await page.keyboard.down('Shift')
  await page.keyboard.press('Digit1')
  await page.keyboard.up('Shift')
  await pause(1800)
}

/** Close the agents panel, then open the Inspector from the rail it leaves
 *  (its top button, the sliders). */
async function openInspector(page: Page): Promise<void> {
  await page.click('button[aria-label="Close panel"]')
  await pause(800)
  await page.mouse.click(1565, 78)
  await pause(1500)
}

/** Scroll the element whose own text is `text` to the top of its scroller. */
async function scrollTo(page: Page, text: string): Promise<void> {
  await page.evaluate((wanted) => {
    const el = [...document.querySelectorAll('div, span, h2, h3, p, button')].find(
      (e) => e.childElementCount === 0 && e.textContent?.trim() === wanted,
    )
    let scroller = el?.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    if (el && scroller) {
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
    }
  }, text)
  await pause(800)
}

/** One step of the zoom pill's +, so small frames are drawn live rather than as placeholders. */
async function zoomIn(page: Page): Promise<void> {
  await page.click('button[aria-label="Zoom in"]')
  await pause(1800)
}

type Shot = (page: Page, ids: Ids) => Promise<void>

const SHOTS: Record<string, Shot> = {
  async canvas(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Chat')
    await fit(page)
    await zoomIn(page)
    await page.keyboard.press('Escape')
    await pause(500)
    await pause(1500)
  },
  async duel(page, ids) {
    await openCanvas(page, ids, `?page=${encodeURIComponent(`${ids.app}:duel`)}`)
    await tab(page, 'Agents')
    await fit(page)
  },
  async skills(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Memory')
    await fit(page)
    await zoomIn(page)
    await clickText(page, 'button, [role=button]', /^\/pricing-page/)
    await pause(1500)
  },
  async checks(page, ids) {
    await openCanvas(page, ids)
    await selectFrames(page, 'Mobile — Interview notes')
    await zoomSelection(page)
    await openInspector(page)
    await scrollTo(page, 'Responsive and accessibility')
  },
  async code(page, ids) {
    await openCanvas(page, ids)
    await selectFrames(page, 'Pricing')
    await zoomSelection(page)
    await openInspector(page)
    await clickText(page, 'button', 'Export as code')
    await pause(4000)
  },
  async tokens(page, ids) {
    await openCanvas(page, ids)
    await page.click('button[aria-label="Close panel"]')
    await tab(page, 'Tokens')
    await page.click('button[title="Sync with repo"], button[aria-label="Sync with repo"]')
    await pause(4000)
  },
  async replay(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Usage')
    const rows = await page.$$('[title="Open the run"]')
    await rows.at(-1)?.click()
    await pause(4000)
  },
  async find(page, ids) {
    await openCanvas(page, ids)
    await selectFrames(page, 'Landing — Hero')
    await zoomSelection(page)
    await page.keyboard.down('Meta')
    await page.keyboard.press('KeyF')
    await page.keyboard.up('Meta')
    await pause(800)
    await page.keyboard.type('button', { delay: 40 })
    await pause(2500)
    /* unfold the family and point at a variant: the preview follows the pointer */
    await page.click('button[aria-label="Show what matched inside"]')
    await pause(800)
    const variants = await page.$$('ul[aria-label="Find in frames"] ul li button')
    await variants[2]?.hover()
    await pause(2500)
  },
  async gallery(page, ids) {
    await page.goto(`${WEB}/l/${ids.kit}`, { waitUntil: 'networkidle2', timeout: 60_000 })
    await pause(3000)
  },
  async curate(page) {
    await page.goto(`${WEB}/libraries`, { waitUntil: 'networkidle2', timeout: 60_000 })
    await pause(1000)
    await clickText(page, 'button', /Organise with AI/)
    await pause(3000)
    await clickText(
      page,
      '[role=dialog] button, [role=dialog] [role=treeitem], [role=dialog] li, [role=dialog] div',
      /^Heroes\s*\d*$/,
    )
    await pause(2500)
  },
}

/** A palette PNG of `file`, as small as needed to stay under 400 KB (skipped without ffmpeg). */
function shrink(file: string): void {
  for (const colors of [256, 128, 96, 64]) {
    const out = `${file}.tmp.png`
    try {
      execFileSync('ffmpeg', [
        '-loglevel',
        'error',
        '-y',
        '-i',
        file,
        '-vf',
        `split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full[p];[b][p]paletteuse=dither=none`,
        out,
      ])
    } catch {
      return
    }
    if (statSync(out).size < 400_000 || colors === 64) {
      renameSync(out, file)
      return
    }
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  let demo: Demo | null = null
  if (!attach) demo = await startDemo()
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--hide-scrollbars', '--font-render-hinting=none'],
  })
  try {
    const { cookies, get } = await session()
    const ids = await lookup(get)
    await browser.setCookie(...cookies.map((c) => ({ ...c, domain: 'localhost', path: '/' })))
    for (const [name, shot] of Object.entries(SHOTS)) {
      if (only && !only.has(name)) continue
      const page = await browser.newPage()
      await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 })
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('doop-theme', 'light')
        localStorage.setItem('doop:canvas-panel-widths', JSON.stringify({ layers: 264, agents: 340 }))
        localStorage.setItem('doop:onboarding', JSON.stringify({ connected: true, tasked: true, dismissed: true }))
      })
      try {
        await shot(page, ids)
        await page.screenshot({ path: path.join(OUT, `${name}.png`) })
        shrink(path.join(OUT, `${name}.png`))
        console.log(`shot ${name}`)
      } catch (error) {
        console.error(`shot ${name} failed:`, error instanceof Error ? error.message : error)
        await page.screenshot({ path: path.join(OUT, `${name}.failed.png`) }).catch(() => {})
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
    demo?.stop()
  }
}

await main()
