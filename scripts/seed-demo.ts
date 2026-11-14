/**
 * A local demo of redoop with invented content ("Fieldnote", a made-up SaaS
 * for user-interview teams), for the README screenshots.
 *
 *   npx tsx scripts/seed-demo.ts        # boots a fresh demo, seeds it, keeps it running
 *
 * It starts, all on this machine: a scripted stand-in for the model API
 * (scripts/demo-model.ts), the server on a fresh PGlite in a temp folder
 * (:4400) with a demo Claude key routed to that stand-in, the Vite web app
 * (:4300), and a fake desktop device that serves a small demo repo, so the
 * repo features (token sync, frame → code) have a linked project. Then it
 * seeds through the REST API, the way the app and agents do. Nothing is
 * sent to a model provider and no real account or data is used.
 * Sign in at http://localhost:4300 with DEMO_EMAIL / DEMO_PASSWORD.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
  SKILL,
  TOKENS,
} from './demo-content.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const API = 'http://localhost:4400'
export const WEB = 'http://localhost:4300'
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

  /* frame checks on the mobile screen (it has small tap targets on purpose) */
  await c.json('POST', `/api/frames/${mobile.id}/checks`, { force: true }).catch((e: unknown) => {
    console.warn('[seed] frame checks:', e instanceof Error ? e.message : e)
  })

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
  await c.json('PUT', `/api/canvases/${app.id}/pages`, {
    pages: [{ ...appPages[0]!, name: 'Product' }, duelPage],
    expectedPages: appPages,
  })
  const duel = await c.json<{ id: string }>('POST', `/api/canvases/${app.id}/duels`, {
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

  /* a chat ask answered with a plan */
  await c.json('POST', `/api/canvases/${app.id}/chat`, {
    text: 'Plan a three-step onboarding for new teams, reusing our tokens and the UI kit.',
  })
  await new Promise((r) => setTimeout(r, 6000))

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

async function waitFor(url: string, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
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
  const dataDir = mkdtempSync(path.join(tmpdir(), 'redoop-demo-'))
  const model = await startDemoModel(writeFrame)
  const chrome = chromePath()
  const env = {
    ...process.env,
    PORT: '4400',
    VITE_PORT: '4300',
    BETTER_AUTH_URL: WEB,
    DATABASE_URL: '',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_BASE_URL: model.url,
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
    spawn(path.join(ROOT, 'node_modules/.bin/vite'), ['--port', '4300', '--strictPort'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'ignore', 'inherit'],
    }),
  ]
  const stopAll = () => {
    for (const child of children) child.kill()
    model.server.close()
  }
  try {
    await waitFor(`${API}/healthz`)
    await waitFor(WEB)
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
