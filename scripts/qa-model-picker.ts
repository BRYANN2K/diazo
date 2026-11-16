/**
 * Visual QA for the model-picker rework: boots the README demo on a fresh
 * PGlite (the model API is the scripted stand-in — nothing leaves the
 * machine), connects several fake connections so the menu groups, then shoots
 * the composer's pills, the model menu, the effort popover and the duel
 * dialog in light and dark with the tests' Chrome for Testing.
 *
 *   npx tsx scripts/qa-model-picker.ts --out /tmp/visual-qa/model-picker --prefix before
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'
import { WEB, chromePath, startDemo, type Client } from './seed-demo.ts'

const args = process.argv.slice(2)
const out = args[args.indexOf('--out') + 1] ?? '/tmp/visual-qa/model-picker'
const prefix = args[args.indexOf('--prefix') + 1] ?? 'shot'
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* several connections beyond the seeded Claude key: the Plan, the two
   desktop agents and two more keys, so the menu shows every kind of group */
async function seedConnections(c: Client): Promise<void> {
  await c.json('PUT', '/api/local-agent', { enabled: true, model: 'sonnet' })
  await c.json('PUT', '/api/local-agent/acp/grok', { enabled: true, model: 'grok-4.7', effort: 'high' })
  await c.json('PUT', '/api/local-agent/acp/devin', { enabled: true, model: 'swe-2' })
  await c.json('POST', '/api/model-account/openai-key', { apiKey: 'sk-qa-visual-only' })
  await c.json('POST', '/api/model-account/openrouter-key', { apiKey: 'sk-or-qa-visual-only' })
  await c.json('PATCH', '/api/model-account/openai-key', { model: 'gpt-6.1-sol' })
  await c.json('PATCH', '/api/model-account/openai-key', { effort: 'medium' })
}

/* a "desktop" is a poll every 30s at most; the catalog is what the CLI lists */
function startPollers(c: Client): () => void {
  const devices = { claude: randomUUID(), grok: randomUUID(), devin: randomUUID() }
  const fail = (e: unknown) => console.warn('poll failed:', e instanceof Error ? e.message : e)
  const poll = async () => {
    await c.json('POST', '/api/local-agent/poll', { deviceId: devices.claude }).catch(fail)
    await c
      .json('POST', '/api/local-agent/acp/grok/poll', {
        deviceId: devices.grok,
        catalog: [
          { id: 'grok-4.7', name: 'Grok 4.7' },
          { id: 'grok-4.6', name: 'Grok 4.6' },
          { id: 'grok-4.5', name: 'Grok 4.5' },
        ],
      })
      .catch(fail)
    await c
      .json('POST', '/api/local-agent/acp/devin/poll', {
        deviceId: devices.devin,
        catalog: [
          { id: 'swe-2', name: 'SWE-2' },
          { id: 'swe-1.6', name: 'SWE-1.6' },
        ],
      })
      .catch(fail)
  }
  const timer = setInterval(() => void poll(), 8_000)
  void poll()
  return () => clearInterval(timer)
}

const MODEL_PILL = 'button[aria-label^="Model:"]'
const EFFORT_PILL = 'button[aria-label^="Reasoning effort:"]'

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(out, `${prefix}-${name}.png`) })
  console.log(`shot ${prefix}-${name}`)
}

/** the composer's foot strip, whatever is on it */
async function shotFoot(page: Page, name: string): Promise<void> {
  const h = page.viewport()!.height
  await page.screenshot({
    path: path.join(out, `${prefix}-${name}.png`),
    clip: { x: 0, y: h - 150, width: 1600, height: 150 },
  })
  console.log(`shot ${prefix}-${name}`)
}

async function clickText(page: Page, selector: string, re: RegExp): Promise<boolean> {
  for (const h of await page.$$(selector)) {
    const t = ((await h.evaluate((e) => e.textContent)) ?? '').trim()
    if (re.test(t)) {
      await h.click()
      return true
    }
  }
  return false
}

async function run(page: Page, canvasId: string, theme: 'light' | 'dark'): Promise<void> {
  await page.goto(`${WEB}/c/${canvasId}`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await pause(3500)
  if (!(await page.$(MODEL_PILL))) throw new Error('no model pill')
  await shotFoot(page, `foot-${theme}`)

  /* the model menu */
  await page.click(MODEL_PILL)
  await pause(700)
  await shot(page, `menu-${theme}`)
  /* the first "Older" fold, expanded in place (one click: a second closes it) */
  if (!(await clickText(page, '[role="menuitem"]', /Older/))) throw new Error('no Older fold')
  await pause(500)
  const expanded = await page.$eval('[role="menuitem"][aria-expanded]', (e) => e.getAttribute('aria-expanded'))
  if (expanded !== 'true') throw new Error('the fold did not open')
  await shot(page, `menu-fold-${theme}`)
  /* the search keeps the keyboard: focus is on the fold row, and what is typed
     there still lands in the field */
  await page.keyboard.type('opus', { delay: 20 })
  await pause(400)
  const query = await page.$eval('input[aria-label="Search models"]', (e) => (e as HTMLInputElement).value)
  if (query !== 'opus') throw new Error(`the search holds "${query}", not "opus"`)
  await shot(page, `menu-search-${theme}`)
  /* and a query nothing matches */
  await page.click('input[aria-label="Search models"]', { count: 3 })
  await page.keyboard.type('zzz', { delay: 20 })
  await pause(300)
  await shot(page, `menu-nomatch-${theme}`)
  await page.keyboard.press('Escape')
  await pause(400)

  /* the effort popover (absent in the old UI) */
  if (await page.$(EFFORT_PILL)) {
    await page.click(EFFORT_PILL)
    await pause(700)
    await shot(page, `effort-${theme}`)
    await page.keyboard.press('Escape')
    await pause(400)
  }

  /* the duel slots: empty, then filled so a slot shows its two buttons */
  if (await clickText(page, 'button', /^Duel$/)) {
    await pause(800)
    await shot(page, `duel-${theme}`)
    const fillSlot = async (n: number, model: RegExp) => {
      const slot = await page.$(`button[data-slot-index="${n}"]`)
      if (!slot) return false
      await slot.click()
      await pause(600)
      const pickedIt = await clickText(page, '[role="menuitemradio"]', model)
      await pause(500)
      return pickedIt
    }
    if ((await fillSlot(1, /^Latest Opus/)) && (await fillSlot(2, /^Grok 4.7/))) {
      await shot(page, `duel-filled-${theme}`)
      /* the same model and effort twice: the slot warns and Start holds back */
      if (await fillSlot(3, /^Grok 4.7/)) await shot(page, `duel-repeat-${theme}`)
    }
    await page.keyboard.press('Escape')
    await pause(400)
  }
}

async function main(): Promise<void> {
  mkdirSync(out, { recursive: true })
  const demo = await startDemo()
  const stopPollers = startPollers(demo.client)
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--hide-scrollbars', '--font-render-hinting=none'],
  })
  try {
    await seedConnections(demo.client)
    await pause(9000)
    const local = await demo.client.json('GET', '/api/local-agent')
    console.log('local-agent:', JSON.stringify(local))
    const listed = await demo.client.json<{ runners: { provider: string; name: string; online?: boolean }[] }>(
      'GET',
      '/api/agent-runners',
    )
    console.log(
      'runners:',
      listed.runners.map((r) => `${r.provider}${r.online === false ? '(offline)' : ''}`).join(', '),
    )
    await browser.setCookie(
      ...[...demo.client.cookies].map(([name, value]) => ({ name, value, domain: 'localhost', path: '/' })),
    )
    const open = async (theme: 'light' | 'dark', locale: string, agents: number) => {
      const page = await browser.newPage()
      await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 })
      await page.evaluateOnNewDocument(
        (t, l, w) => {
          localStorage.setItem('doop-theme', t)
          localStorage.setItem('doop-locale', l)
          localStorage.setItem('doop:canvas-panel-widths', JSON.stringify({ layers: 264, agents: w }))
          localStorage.setItem('doop:onboarding', JSON.stringify({ connected: true, tasked: true, dismissed: true }))
        },
        theme,
        locale,
        agents,
      )
      return page
    }
    for (const theme of ['light', 'dark'] as const) {
      const page = await open(theme, 'en', 340)
      await run(page, demo.app.canvasId, theme)
      await page.close()
    }
    /* the narrowest Agents panel, and pt-BR's longer labels and blurbs */
    for (const [name, locale, agents] of [
      ['narrow', 'en', 300],
      ['pt-BR', 'pt-BR', 340],
    ] as const) {
      const page = await open('light', locale, agents)
      await page.goto(`${WEB}/c/${demo.app.canvasId}`, { waitUntil: 'networkidle2', timeout: 60_000 })
      await pause(3500)
      await shotFoot(page, `foot-${name}`)
      /* the composer's effort pill, in either language */
      const effort = await page.$(
        'button[aria-label^="Reasoning effort:"], button[aria-label^="Esforço de raciocínio:"]',
      )
      if (!effort) throw new Error(`no effort pill (${name})`)
      await effort.click()
      await pause(700)
      await shot(page, `effort-${name}`)
      await page.keyboard.press('Escape')
      await page.close()
    }
  } finally {
    stopPollers()
    await browser.close()
    demo.stop()
  }
}

await main()
