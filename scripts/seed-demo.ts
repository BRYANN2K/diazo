/**
 * A local demo of redoop with invented content ("Fieldnote", a made-up SaaS
 * for user-interview teams), for the README screenshots.
 *
 *   npx tsx scripts/seed-demo.ts        # boots a fresh demo, seeds it, keeps it running
 *
 * It starts, all on this machine: a scripted stand-in for the model APIs
 * (scripts/demo-model.ts), the server on a fresh PGlite in a temp folder
 * (DEMO_API_PORT, default 4410) with demo Claude, OpenAI and OpenRouter keys
 * routed to that stand-in, the Vite web app (DEMO_WEB_PORT, default 4310),
 * and a fake desktop device that serves a small demo repo, so the repo
 * features (token sync, frame → code) have a linked project. Then it seeds
 * through the REST API, the way the app and agents do. Nothing is sent to a
 * model provider and no real account or data is used. The ports are not
 * 4400 / 4300, where a local Diazo or `bun run dev` answers, and the seed
 * refuses to start when either already answers, so it never writes into an
 * instance it did not start.
 * Sign in at http://localhost:<DEMO_WEB_PORT> with DEMO_EMAIL / DEMO_PASSWORD.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintDocKey, type LintDocument } from '../shared/lintDocument.ts'
import { startDemoModel } from './demo-model.ts'
import {
  DASHBOARD,
  KIT,
  LANDING,
  MOBILE,
  OLD_KITS,
  ONBOARDING_CENTERED,
  ONBOARDING_SPLIT,
  PRICING,
  PRICING_V2,
  REPO_FILES,
  SCENE,
  SKILL,
  TOKENS,
} from './demo-content.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} is not a port: ${value}`)
  return value
}
export const API_PORT = port('DEMO_API_PORT', 4410)
export const WEB_PORT = port('DEMO_WEB_PORT', 4310)
export const API = `http://localhost:${API_PORT}`
export const WEB = `http://localhost:${WEB_PORT}`
export const DEMO_EMAIL = 'maya@fieldnote.example'
export const DEMO_PASSWORD = 'fieldnote-demo-only'

/* ------------------------------------------------------------------ */
/* a cookie-jar client (better-auth runs on cookies)                   */
/* ------------------------------------------------------------------ */

export class Client {
  cookies = new Map<string, string>()

  async req(pathname: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(API + pathname, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Origin: WEB,
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...init.headers,
      },
      redirect: 'manual',
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';')
      const at = pair.indexOf('=')
      this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
    return res
  }

  async json<T = Record<string, unknown>>(method: string, pathname: string, body?: unknown): Promise<T> {
    const res = await this.req(pathname, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${text.slice(0, 300)}`)
    return (text ? JSON.parse(text) : {}) as T
  }
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 600)}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

/* ------------------------------------------------------------------ */
/* the fake desktop device: answers list / read / search over a folder */
/* ------------------------------------------------------------------ */

function walk(dir: string, base = ''): { path: string; kind: 'file' | 'dir'; size?: number }[] {
  return readdirSync(path.join(dir, base)).flatMap((name) => {
    const rel = base ? `${base}/${name}` : name
    const stat = statSync(path.join(dir, rel))
    return stat.isDirectory()
      ? [{ path: rel, kind: 'dir' as const }, ...walk(dir, rel)]
      : [{ path: rel, kind: 'file' as const, size: stat.size }]
  })
}

function inside(dir: string, rel: string): string | null {
  const full = path.resolve(dir, rel)
  return full.startsWith(dir + path.sep) ? full : null
}

type RepoArgs = { paths?: string[]; query?: string; limit?: number }

function answerRepo(dir: string, op: string, args: RepoArgs): { ok: boolean; result?: unknown; error?: string } {
  if (op === 'list') return { ok: true, result: { entries: walk(dir), truncated: false } }
  if (op === 'read') {
    const files = (args.paths ?? []).map((p) => {
      const full = inside(dir, p)
      try {
        return full ? { path: p, text: readFileSync(full, 'utf8') } : { path: p, error: 'denied' }
      } catch {
        return { path: p, error: 'missing' }
      }
    })
    return { ok: true, result: { files, truncated: false } }
  }
  if (op === 'search') {
    const q = (args.query ?? '').toLowerCase()
    const matches = walk(dir)
      .filter((e) => e.kind === 'file')
      .flatMap((e) =>
        readFileSync(path.join(dir, e.path), 'utf8')
          .split('\n')
          .flatMap((text, i) => (text.toLowerCase().includes(q) ? [{ path: e.path, line: i + 1, text }] : [])),
      )
      .slice(0, args.limit ?? 50)
    return { ok: true, result: { matches, truncated: false } }
  }
  return { ok: false, error: 'the demo device only reads' }
}

/** Poll the bridge as the desktop app would, until `stop()` is called. */
function startDevice(client: Client, dir: string, linkId: string, deviceId: string): () => void {
  let running = true
  void (async () => {
    while (running) {
      try {
        const { request } = await client.json<{ request: { id: string; op: string; args: RepoArgs } | null }>(
          'POST',
          '/api/local-repo/poll',
          { deviceId, grants: [linkId] },
        )
        if (request) {
          const answer = answerRepo(dir, request.op, request.args)
          await client.json('POST', `/api/local-repo/finish/${request.id}`, { deviceId, ...answer })
        }
      } catch {
        if (running) await new Promise((r) => setTimeout(r, 1000))
      }
    }
  })()
  return () => {
    running = false
  }
}

/* ------------------------------------------------------------------ */
/* the seed                                                            */
/* ------------------------------------------------------------------ */

type Frame = { id: string; name: string }
type Canvas = { id: string; pages?: { id: string; name: string }[] }

async function frame(
  c: Client,
  canvasId: string,
  f: { name: string; x: number; y: number; width: number; height: number; html: string; pageId?: string },
): Promise<Frame> {
  return c.json<Frame>('POST', `/api/canvases/${canvasId}/frames`, f)
}

export interface Seeded {
  client: Client
  app: { canvasId: string; landing: string; pricing: string; dashboard: string; mobile: string }
  kitId: string
  curationId: string
  duelId: string
  runId: string | null
  stopDevice: () => void
}

export async function seedDemo(dataDir: string): Promise<Seeded> {
  const c = new Client()
  await c.json('POST', '/api/auth/sign-up/email', {
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    name: 'Maya Lindqvist',
  })
  await c.json('POST', '/api/model-account/anthropic-key', { apiKey: 'sk-ant-demo-local-stand-in-only' })
  /* two more connections, so Settings shows a row per provider */
  await c.json('POST', '/api/model-account/openai-key', { apiKey: 'sk-demo-openai-local-stand-in-only' })
  await c.json('POST', '/api/model-account/openrouter-key', { apiKey: 'sk-or-demo-local-stand-in-only' })
  /* the welcome canvas every new account gets: not part of the demo */
  const listed = await c.json<{ id: string }[] | { canvases: { id: string }[] }>('GET', '/api/canvases')
  for (const old of Array.isArray(listed) ? listed : listed.canvases) await c.json('DELETE', `/api/canvases/${old.id}`)

  /* the product canvas */
  const app = await c.json<Canvas>('POST', '/api/canvases', { name: 'Fieldnote — Web app' })
  const landing = await frame(c, app.id, {
    name: 'Landing — Hero',
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    html: LANDING,
  })
  const pricing = await frame(c, app.id, { name: 'Pricing', x: 1560, y: 0, width: 1440, height: 900, html: PRICING })
  const dashboard = await frame(c, app.id, {
    name: 'Dashboard — Interviews',
    x: 0,
    y: 1020,
    width: 1440,
    height: 900,
    html: DASHBOARD,
  })
  const mobile = await frame(c, app.id, {
    name: 'Mobile — Interview notes',
    x: 1560,
    y: 1020,
    width: 390,
    height: 844,
    html: MOBILE,
  })
  await c.json('POST', `/api/canvases/${app.id}/tokens`, { tokens: TOKENS })
  await c.json('PUT', `/api/canvases/${app.id}/skills/${SKILL.name}`, {
    description: SKILL.description,
    markdown: SKILL.markdown,
  })
  await c.json('PUT', `/api/canvases/${app.id}/skills/onboarding-flow`, {
    description: 'Use when a brief asks for onboarding, sign-up or first-run screens.',
    markdown:
      '# Onboarding at Fieldnote\n\n- Three steps at most, a step counter on each.\n- One question per screen.\n- Always a way to skip inviting the team.',
  })

  /* the UI kit, turned into a library */
  const kit = await c.json<Canvas>('POST', '/api/canvases', { name: 'Fieldnote UI kit' })
  let y = 0
  for (const k of KIT) {
    await frame(c, kit.id, { name: k.name, x: 0, y, width: k.width, height: k.height, html: k.html })
    y += k.height + 80
  }
  await c.json('POST', '/api/libraries', { canvasId: kit.id, preset: 'sheets' })

  /* two older kits for "Organise with AI" */
  const sources: string[] = []
  for (const old of OLD_KITS) {
    const canvas = await c.json<Canvas>('POST', '/api/canvases', { name: old.canvas })
    const pages = canvas.pages ?? [{ id: `${canvas.id}:page1`, name: 'Page 1' }]
    await c.json('PUT', `/api/canvases/${canvas.id}/pages`, {
      pages: [{ id: pages[0]!.id, name: old.page }],
      expectedPages: pages,
    })
    let i = 0
    for (const f of old.frames) {
      await frame(c, canvas.id, {
        name: f.name,
        x: (i % 4) * 880,
        y: Math.floor(i / 4) * 480,
        width: 800,
        height: 400,
        html: f.html,
      })
      i++
    }
    sources.push(canvas.id)
  }
  const curation = await c.json<{ id: string }>('POST', '/api/library-curations', {
    sourceIds: sources,
    name: 'Fieldnote design library',
  })
  await until(
    () => c.json<{ status: string }>('GET', `/api/library-curations/${curation.id}`),
    (j) => ['ready', 'failed'].includes(j.status),
    'the curation to reach review',
  )

  /* a linked project on this "computer", served by the fake device */
  const repoDir = path.join(dataDir, 'fieldnote-web')
  for (const [rel, text] of Object.entries(REPO_FILES)) {
    mkdirSync(path.dirname(path.join(repoDir, rel)), { recursive: true })
    writeFileSync(path.join(repoDir, rel), text)
  }
  const linkId = randomUUID()
  const deviceId = randomUUID()
  await c.json('POST', `/api/canvases/${app.id}/repo`, { linkId, name: 'fieldnote-web', deviceId })
  const stopDevice = startDevice(c, repoDir, linkId, deviceId)

  /* frame checks on the mobile screen (it has small tap targets on purpose),
     and on the landing, so the "A11y" badge has verdicts to show */
  for (const id of [mobile.id, landing.id]) {
    await c.json('POST', `/api/frames/${id}/checks`, { force: true }).catch((e: unknown) => {
      console.warn('[seed] frame checks:', e instanceof Error ? e.message : e)
    })
  }

  /* two open threads (one with a reply) and a resolved one: the Comments tab
     and the canvas pins all have something to draw */
  const productPage = (app.pages ?? [{ id: `${app.id}:page1`, name: 'Page 1' }])[0]!
  const heroNote = await c.json<{ id: string }>('POST', `/api/frames/${landing.id}/comments`, {
    text: 'The hero type still feels a size too loud next to the nav — can we try 56?',
    x: 430,
    y: 340,
    snippet: '',
  })
  await c.json('POST', `/api/comments/${heroNote.id}/replies`, {
    text: 'Trying it — the measure stays under 60 characters either way.',
  })
  await c.json('POST', `/api/canvases/${app.id}/comments`, {
    pageId: productPage.id,
    x: 760,
    y: 470,
    text: 'This spread is the shape for the next sprint.',
  })
  const resolved = await c.json<{ id: string }>('POST', `/api/frames/${pricing.id}/comments`, {
    text: 'Yearly price first, monthly behind the toggle.',
    x: 210,
    y: 300,
    snippet: '',
  })
  await c.json('POST', `/api/comments/${resolved.id}/resolve`)

  /* a scoped card: the agent reworks the pricing page (a run to replay) */
  await c.json('POST', `/api/canvases/${app.id}/cards`, {
    title: 'Add a monthly / yearly toggle above the pricing cards',
    scope: { frameId: pricing.id },
  })
  const runs = await until(
    () => c.json<{ runs?: { id: string; outcome: string; kind: string }[] }>('GET', `/api/canvases/${app.id}/usage`),
    (u) => (u.runs ?? []).some((r) => r.outcome === 'done'),
    'the pricing run',
  )

  /* a duel: one onboarding brief, two models, on a page of its own */
  const appPages = app.pages ?? [{ id: `${app.id}:page1`, name: 'Page 1' }]
  const duelPage = { id: `${app.id}:duel`, name: 'Onboarding duel' }
  const motionPage = { id: `${app.id}:motion`, name: 'Launch film' }
  await c.json('PUT', `/api/canvases/${app.id}/pages`, {
    pages: [{ ...appPages[0]!, name: 'Product' }, duelPage, motionPage],
    expectedPages: appPages,
  })
  const duel = await c.json<{ id: string; entries: { frameId: string }[] }>('POST', `/api/canvases/${app.id}/duels`, {
    pageId: duelPage.id,
    brief: 'Onboarding step 1 for new Fieldnote teams: name the workspace and pick the team size.',
    picks: [
      { provider: 'anthropic-key', model: 'claude-sonnet-5' },
      { provider: 'anthropic-key', model: 'claude-opus-5' },
    ],
  })
  await until(
    () => c.json<{ runs?: { outcome: string }[] }>('GET', `/api/canvases/${app.id}/usage`),
    (u) => (u.runs ?? []).filter((r) => r.outcome === 'done').length >= 3,
    'the duel runs',
  )

  /* Motion Studio on its own page: one scene frame and a small timeline —
     camera drift, a title fading up, a caption clip */
  const scene = await frame(c, app.id, {
    name: 'Scene — Intro',
    x: 0,
    y: 0,
    width: 1280,
    height: 720,
    html: SCENE,
    pageId: motionPage.id,
  })
  await c.json('PUT', `/api/canvases/${app.id}/pages/${motionPage.id}/composition`, {
    duration: 8,
    fps: 30,
    width: 1280,
    height: 720,
    tracks: [
      {
        id: 'camera',
        kind: 'camera',
        keyframes: [
          { id: 'cam-a', property: 'zoom', t: 0, value: 1, easing: 'linear' },
          { id: 'cam-b', property: 'zoom', t: 8, value: 1.12, easing: 'ease-in-out' },
        ],
      },
      {
        id: 'title',
        kind: 'element',
        name: 'Title fade up',
        frameId: scene.id,
        elementId: 'title',
        keyframes: [
          { id: 't-op-0', property: 'opacity', t: 0, value: 0, easing: 'linear' },
          { id: 't-op-1', property: 'opacity', t: 1, value: 1, easing: 'linear' },
          { id: 't-y-0', property: 'y', t: 0, value: 24, easing: 'ease-out' },
          { id: 't-y-1', property: 'y', t: 1, value: 0, easing: 'linear' },
        ],
      },
      {
        id: 'sub',
        kind: 'element',
        name: 'Sub fade in',
        frameId: scene.id,
        elementId: 'sub',
        keyframes: [
          { id: 's-op-0', property: 'opacity', t: 0.8, value: 0, easing: 'linear' },
          { id: 's-op-1', property: 'opacity', t: 1.8, value: 1, easing: 'linear' },
        ],
      },
      {
        id: 'captions',
        kind: 'caption',
        name: 'Captions',
        clips: [
          {
            id: 'cap-1',
            start: 2.2,
            duration: 2.8,
            source: { type: 'caption', text: 'Every interview, searchable.' },
          },
          { id: 'cap-2', start: 5.4, duration: 2.2, source: { type: 'caption', text: 'Fieldnote' } },
        ],
      },
    ],
  })

  /* a second duel, left undecided beside the settled one */
  await c.json('POST', `/api/canvases/${app.id}/duels`, {
    pageId: duelPage.id,
    brief: 'Empty state for a workspace with no interviews yet.',
    picks: [
      { provider: 'anthropic-key', model: 'claude-sonnet-5' },
      { provider: 'anthropic-key', model: 'claude-haiku-4-5-20251001' },
    ],
  })
  await until(
    () => c.json<{ runs?: { outcome: string }[] }>('GET', `/api/canvases/${app.id}/usage`),
    (u) => (u.runs ?? []).filter((r) => r.outcome === 'done').length >= 5,
    'the second duel runs',
  )

  /* settling the first duel is a design decision — the distiller turns it
     into the pending rule card the Memory panel shows */
  await c
    .json('POST', `/api/canvases/${app.id}/duels/${duel.id}/pick`, { frameId: duel.entries[0]!.frameId })
    .catch((e: unknown) => console.warn('[seed] duel pick:', e instanceof Error ? e.message : e))

  /* a chat ask answered with a plan */
  await c.json('POST', `/api/canvases/${app.id}/chat`, {
    text: 'Plan a three-step onboarding for new teams, reusing our tokens and the UI kit.',
  })
  await new Promise((r) => setTimeout(r, 6000))

  /* the anti-slop lint a client computes inside the iframe, written straight
     for the demo: the landing trips errors, the dashboard warnings only, the
     pricing is clean — one badge of each tone. Written last, after every run
     that rewrites a frame, as passes with computed styles of the document
     each frame shows now (`doc`): a client keeps such a verdict
     (lintIsCurrent) instead of scoring it again */
  const checkedAt = Date.now()
  const docOf = async (frameId: string) => lintDocKey(await c.json<LintDocument>('GET', `/api/frames/${frameId}`))
  await c.json('PUT', `/api/frames/${landing.id}/lint`, {
    lint: {
      score: 52,
      errors: 3,
      warnings: 4,
      issues: [
        { ruleId: 'AS-TYP-01', severity: 'error', message: 'Heading skips a level', detail: 'h1 after h3' },
        { ruleId: 'AS-COL-02', severity: 'error', message: 'Text contrast below AA', detail: '2.7:1' },
        { ruleId: 'AS-GRD-01', severity: 'error', message: 'Gradient behind a button', detail: 'linear-gradient' },
        { ruleId: 'AS-SPC-03', severity: 'warning', message: 'Off-grid spacing', detail: '13px' },
        { ruleId: 'AS-ICO-02', severity: 'warning', message: 'Emoji in chrome', detail: 'fire icon' },
        { ruleId: 'AS-TYP-02', severity: 'warning', message: 'A third typeface appears once', detail: 'Poppins' },
        { ruleId: 'AS-SPC-01', severity: 'warning', message: 'Dense paragraph', detail: '92 words' },
      ],
      checkedAt,
      version: 1,
      engine: 'dom',
      doc: await docOf(landing.id),
    },
  })
  await c.json('PUT', `/api/frames/${dashboard.id}/lint`, {
    lint: {
      score: 84,
      errors: 0,
      warnings: 3,
      issues: [
        { ruleId: 'AS-SPC-03', severity: 'warning', message: 'Off-grid spacing', detail: '13px' },
        { ruleId: 'AS-TYP-03', severity: 'warning', message: 'Label set in all caps', detail: 'RECENT' },
        { ruleId: 'AS-COL-04', severity: 'warning', message: 'Two accent hues compete', detail: 'amber + green' },
      ],
      checkedAt,
      version: 1,
      engine: 'dom',
      doc: await docOf(dashboard.id),
    },
  })
  await c.json('PUT', `/api/frames/${pricing.id}/lint`, {
    lint: {
      score: 100,
      errors: 0,
      warnings: 0,
      issues: [],
      checkedAt,
      version: 1,
      engine: 'dom',
      doc: await docOf(pricing.id),
    },
  })

  return {
    client: c,
    app: { canvasId: app.id, landing: landing.id, pricing: pricing.id, dashboard: dashboard.id, mobile: mobile.id },
    kitId: kit.id,
    curationId: curation.id,
    duelId: duel.id,
    runId: runs.runs?.find((r) => r.outcome === 'done')?.id ?? null,
    stopDevice,
  }
}

/** What the stand-in writes into the frame a run is scoped to. */
function writeFrame(frameName: string, model: string): string | null {
  if (frameName.toLowerCase().includes('pricing')) return PRICING_V2
  return model.includes('opus') ? ONBOARDING_CENTERED : ONBOARDING_SPLIT
}

/* ------------------------------------------------------------------ */
/* booting the demo                                                    */
/* ------------------------------------------------------------------ */

/** The Chrome the server renders with: CHROME_PATH, else the tests' cached Chrome for Testing. */
export function chromePath(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const version = readFileSync(path.join(ROOT, '.chrome-version'), 'utf8').trim()
  const home = process.env.HOME ?? ''
  const mac = path.join(
    home,
    `.cache/doop-chrome/chrome/mac_arm-${version}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  )
  try {
    statSync(mac)
    return mac
  } catch {
    return undefined
  }
}

/* a listener may bind IPv4 or IPv6 alone (Vite on macOS takes ::1 only) */
const LOOPBACKS = ['127.0.0.1', '[::1]', 'localhost']

/** Whether anything answers HTTP on a local port, on any loopback address. */
async function answers(port: number): Promise<boolean> {
  const probes = LOOPBACKS.map(async (host) => {
    try {
      await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1500) })
      return true
    } catch {
      return false
    }
  })
  return (await Promise.all(probes)).some(Boolean)
}

async function waitFor(url: string, ms = 90_000, exited?: () => string | null): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    const gone = exited?.()
    if (gone) throw new Error(`${gone} exited before ${url} answered`)
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

export interface Demo extends Seeded {
  stop(): void
}

export async function startDemo(): Promise<Demo> {
  /* never seed into an instance this script did not start */
  for (const taken of [API_PORT, WEB_PORT]) {
    if (await answers(taken))
      throw new Error(`port ${taken} already answers; stop what runs there or set DEMO_API_PORT / DEMO_WEB_PORT`)
  }
  const dataDir = mkdtempSync(path.join(tmpdir(), 'redoop-demo-'))
  const model = await startDemoModel(writeFrame)
  const chrome = chromePath()
  /* every provider URL the server could call points at the stand-in, and
     every other provider key is blank: the fake keys never leave this machine */
  const env = {
    ...process.env,
    PORT: String(API_PORT),
    VITE_PORT: String(WEB_PORT),
    BETTER_AUTH_URL: WEB,
    DATABASE_URL: '',
    /* the distiller reads env.ANTHROPIC_API_KEY, not the model account: a
       demo key routed to the stand-in turns Memory proposals on */
    ANTHROPIC_API_KEY: 'sk-ant-demo-local-stand-in-only',
    ANTHROPIC_BASE_URL: model.url,
    OPENAI_API_KEY: '',
    OPENAI_MODELS_URL: `${model.url}/openai/v1/models`,
    OPENAI_RESPONSES_URL: `${model.url}/openai/v1/responses`,
    OPENROUTER_CHAT_URL: `${model.url}/openrouter/v1/chat/completions`,
    AZURE_OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    ARK_API_KEY: '',
    PEXELS_API_KEY: '',
    REMOTE_BROWSER_URL: '',
    REMOTE_BROWSER_TOKEN: '',
    DOOP_UPDATE_CHECK: 'false',
    POSTHOG_KEY: '',
    VITE_POSTHOG_KEY: '',
    SMTP_HOST: '',
    ONEPAGELOVE_API_KEY: '',
    ...(chrome ? { CHROME_PATH: chrome } : {}),
  }
  /* the server's log, for when a seed step times out */
  const log = openSync(path.join(tmpdir(), 'redoop-demo-server.log'), 'w')
  const children: ChildProcess[] = [
    spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'server/index.ts')], {
      cwd: dataDir,
      env,
      stdio: ['ignore', log, log],
    }),
    spawn(path.join(ROOT, 'node_modules/.bin/vite'), ['--port', String(WEB_PORT), '--strictPort'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
    }),
  ]
  const stopAll = () => {
    for (const child of children) child.kill()
    model.server.close()
  }
  const names = ['the demo server', 'the web app']
  const exited = () => {
    const at = children.findIndex((child) => child.exitCode !== null || child.signalCode !== null)
    return at < 0 ? null : (names[at] ?? 'a child process')
  }
  try {
    await waitFor(`${API}/healthz`, 90_000, exited)
    await waitFor(WEB, 90_000, exited)
    const seeded = await seedDemo(dataDir)
    return {
      ...seeded,
      stop() {
        seeded.stopDevice()
        stopAll()
        rmSync(dataDir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    stopAll()
    rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startDemo()
  console.log(`demo ready: ${WEB}  (${DEMO_EMAIL} / ${DEMO_PASSWORD})  Ctrl-C stops it`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      demo.stop()
      process.exit(0)
    })
  }
}
