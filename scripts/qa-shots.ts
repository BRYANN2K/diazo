/**
 * Visual-QA screenshots of a running demo (scripts/seed-demo.ts).
 *
 *   npx tsx scripts/qa-shots.ts /tmp/visual-qa/before          # every shot
 *   npx tsx scripts/qa-shots.ts /tmp/visual-qa/after --only canvas,memory
 *
 * Chrome for Testing at 1440×900 (light + dark) and 1280×800 (light, for
 * overflow). Attaches to the demo already running from seed-demo.ts.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { API, DEMO_EMAIL, DEMO_PASSWORD, WEB, chromePath } from './seed-demo.ts'

const OUT = process.argv[2] ?? '/tmp/visual-qa/shots'
/** the value after a `--flag`, or undefined when the flag is absent */
const flag = (name: string) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}
const onlyArg = flag('--only')
const only = onlyArg ? new Set(onlyArg.split(',')) : null
const THEMES = (flag('--theme') ?? 'light,dark').split(',')

interface Ids {
  app: string
  kit: string
  duelPage: string
  motionPage: string
  frames: Record<string, string>
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  const canvas = await get<{ frames: { id: string; name: string }[]; pages: { id: string; name: string }[] }>(
    `/api/canvases/${app}`,
  )
  const page = (name: string) => canvas.pages.find((p) => p.name === name)?.id ?? ''
  return {
    app,
    kit: byName('Fieldnote UI kit'),
    duelPage: page('Onboarding duel'),
    motionPage: page('Launch film'),
    frames: Object.fromEntries(canvas.frames.map((f) => [f.name, f.id])),
  }
}

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

async function tab(page: Page, name: string): Promise<void> {
  const direct = await page.$$('[role=tab]')
  for (const h of direct) {
    const t = ((await h.evaluate((e) => e.textContent)) ?? '').trim()
    if (t === name || t.startsWith(name)) {
      await h.click()
      await pause(1200)
      return
    }
  }
  /* tabs that do not fit live behind the agent panel's "More" button */
  await page.click('button[aria-label="More"], button[aria-label*="More"]')
  await pause(600)
  const items = await page.$$('[role=menuitem]')
  for (const h of items) {
    const t = ((await h.evaluate((e) => e.textContent)) ?? '').trim()
    if (t.startsWith(name)) {
      await h.click()
      await pause(1200)
      return
    }
  }
  throw new Error(`no More-menu item starting with ${name}`)
}

async function openCanvas(page: Page, ids: Ids, query = ''): Promise<void> {
  await page.goto(`${WEB}/c/${ids.app}${query}`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await pause(3000)
}

/** ⇧1 fit-all after a click on the bare stage. */
async function fit(page: Page): Promise<void> {
  await page.mouse.click(900, 700)
  await page.keyboard.down('Shift')
  await page.keyboard.press('Digit1')
  await page.keyboard.up('Shift')
  await pause(1600)
}

async function zoomIn(page: Page): Promise<void> {
  await page.click('button[aria-label="Zoom in"]')
  await pause(1400)
}

/** Select one frame by its Layers row. */
async function selectFrame(page: Page, name: string): Promise<void> {
  await clickText(page, '[role=treeitem] span, [role=treeitem]', name)
  await pause(700)
}

async function zoomSelection(page: Page): Promise<void> {
  await page.keyboard.down('Shift')
  await page.keyboard.press('Digit2')
  await page.keyboard.up('Shift')
  await pause(1600)
}

type Shot = (page: Page, ids: Ids) => Promise<void>

const SHOTS: Record<string, Shot> = {
  async canvas(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Agents')
    await fit(page)
    await zoomIn(page)
    await page.keyboard.press('Escape')
    await pause(800)
  },
  async selected(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Agents')
    await selectFrame(page, 'Landing — Hero')
    await zoomSelection(page)
  },
  async hover(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Agents')
    await selectFrame(page, 'Landing — Hero')
    await zoomSelection(page)
    /* hover the dashboard's title: its badges should appear, unselected */
    const el = await page.evaluateHandle(() => {
      const spans = [...document.querySelectorAll('span')]
      return spans.find((s) => s.textContent === 'Dashboard — Interviews') ?? null
    })
    const box = await el.asElement()?.boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await pause(1200)
  },
  async layers(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Agents')
    await selectFrame(page, 'Dashboard — Interviews')
    await pause(600)
  },
  async tokens(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Tokens')
    await pause(800)
  },
  async libraryPanel(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Library')
    await pause(1500)
  },
  async chat(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Chat')
    await pause(1500)
  },
  async agents(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Agents')
    await fit(page)
  },
  async activity(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Activity')
    await pause(800)
  },
  async comments(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Comments')
    await fit(page)
    await zoomIn(page)
  },
  async memory(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Memory')
    await pause(1200)
  },
  async usage(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Usage')
    await pause(1000)
  },
  async replay(page, ids) {
    await openCanvas(page, ids)
    await tab(page, 'Usage')
    const rows = await page.$$('[title="Open the run"]')
    await rows.at(-1)?.click()
    await pause(4000)
  },
  async inspector(page, ids) {
    await openCanvas(page, ids)
    await selectFrame(page, 'Pricing')
    await zoomSelection(page)
    /* the canvas rail's sliders control opens the Inspector */
    await page.click('[aria-label="Inspect frame"]')
    await pause(1500)
  },
  async duel(page, ids) {
    await openCanvas(page, ids, `?page=${encodeURIComponent(ids.duelPage)}`)
    await tab(page, 'Agents')
    await fit(page)
  },
  async motion(page, ids) {
    await openCanvas(page, ids, `?page=${encodeURIComponent(ids.motionPage)}`)
    await fit(page)
    await clickText(page, 'button', 'Motion')
    await pause(2500)
  },
  async find(page, ids) {
    await openCanvas(page, ids)
    await page.keyboard.down('Meta')
    await page.keyboard.press('KeyF')
    await page.keyboard.up('Meta')
    await pause(800)
    await page.keyboard.type('button', { delay: 40 })
    await pause(2000)
  },
  async home(page) {
    await page.goto(`${WEB}/`, { waitUntil: 'networkidle2', timeout: 60_000 })
    await pause(2000)
  },
  async libraries(page) {
    await page.goto(`${WEB}/libraries`, { waitUntil: 'networkidle2', timeout: 60_000 })
    await pause(1500)
  },
  async libraryItem(page, ids) {
    await page.goto(`${WEB}/l/${ids.kit}`, { waitUntil: 'networkidle2', timeout: 60_000 })
    await pause(2500)
    const tiles = await page.$$('[role=button], button')
    for (const h of tiles) {
      const t = (await h.evaluate((e) => e.textContent)) ?? ''
      if (/Buttons|Cards|Components/i.test(t)) {
        await h.click()
        await pause(1800)
        return
      }
    }
  },
  async settings(page) {
    await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle2', timeout: 60_000 })
    await pause(1800)
  },
  async share(page, ids) {
    await openCanvas(page, ids)
    await clickText(page, 'button', 'Share')
    await pause(1500)
  },
  async exportModal(page, ids) {
    await openCanvas(page, ids)
    await clickText(page, 'button', 'Export')
    await pause(1500)
  },
}

async function run(
  browser: Browser,
  ids: Ids,
  name: string,
  shot: Shot,
  theme: string,
  viewport: { width: number; height: number },
) {
  const page = await browser.newPage()
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument((th) => {
    localStorage.setItem('doop-theme', th)
    localStorage.setItem('doop:onboarding', JSON.stringify({ connected: true, tasked: true, dismissed: true }))
  }, theme)
  const suffix = `${name}-${theme}${viewport.width === 1280 ? '-narrow' : ''}`
  try {
    await shot(page, ids)
    await page.screenshot({ path: path.join(OUT, `${suffix}.png`) })
    console.log(`shot ${suffix}`)
  } catch (error) {
    console.error(`shot ${suffix} failed:`, error instanceof Error ? error.message : error)
    await page.screenshot({ path: path.join(OUT, `${suffix}.failed.png`) }).catch(() => {})
  } finally {
    await page.close()
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
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
      if (only && ![...only].some((o) => name === o)) continue
      for (const theme of THEMES) {
        await run(browser, ids, name, shot, theme, { width: 1440, height: 900 })
        if (theme === 'light') await run(browser, ids, name, shot, theme, { width: 1280, height: 800 })
      }
    }
    /* the signed-out screen, once — incognito, since the jar above is signed in */
    if (!only || only.has('auth')) {
      const ctx = await browser.createBrowserContext()
      const page = await ctx.newPage()
      await page.setViewport({ width: 1440, height: 900 })
      await page.goto(`${WEB}/`, { waitUntil: 'networkidle2', timeout: 60_000 })
      await pause(1500)
      await page.screenshot({ path: path.join(OUT, 'auth-light.png') })
      await ctx.close()
      console.log('shot auth-light')
    }
  } finally {
    await browser.close()
  }
}

await main()
