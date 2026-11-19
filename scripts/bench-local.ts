/**
 * Benchmarks a Diazo install — the embedded server bundle and the container
 * image through the same harness — and prints median and p95 per metric.
 *
 *   # an install that is already running (no cold-start measurement):
 *   bun scripts/bench-local.ts http://127.0.0.1:4400
 *
 *   # the embedded bundle — spawn and kill are done here, so cold start and
 *   # RSS are measured too. The server's env is this process's env, inherited:
 *   DOOP_DATA_DIR=/tmp/bench-data DOOP_DIST_DIR=$PWD/out/embedded-server/dist \
 *   DOOP_MIGRATIONS_DIR=$PWD/out/embedded-server/migrations DOOP_LISTEN_HOST=127.0.0.1 \
 *   NODE_ENV=production BETTER_AUTH_URL=http://127.0.0.1:4455 PORT=4455 \
 *   BETTER_AUTH_SECRET=<secret> DOOP_UPDATE_CHECK=false CHROME_PATH=<chrome> \
 *   bun scripts/bench-local.ts http://127.0.0.1:4455 --spawn 'node out/embedded-server/server.mjs'
 *
 *   # the container image, created once up front:
 *   bun scripts/bench-local.ts http://127.0.0.1:4400 \
 *     --spawn 'container start diazo-bench' --stop 'container stop diazo-bench'
 *
 * Dataset: a fixed seed of 3 canvases, 200 frames and 300 assets, written once
 * through the REST API and recognised by name on later runs ("Bench — …").
 * Metrics: cold start to /healthz (10 runs), GET /api/canvases/:id and the
 * /ws room join on the 200-frame canvas (p50/p95), /i/<id>.png cold and warm
 * over 50 frames, 100 append chunks (the REST twin of append_frame_html), 50
 * asset uploads and idle RSS of the spawned process. No model is called.
 */
import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { deflateSync } from 'node:zlib'
import WebSocket from 'ws'

/* ------------------------------------------------------------------ */
/* arguments                                                           */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const VALUE_FLAGS = new Set(['--spawn', '--stop', '--runs', '--json', '--label'])
let BASE: string | undefined
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!
  if (arg.startsWith('--')) {
    if (VALUE_FLAGS.has(arg)) i++ /* its value is not a positional */
    continue
  }
  BASE = arg.replace(/\/+$/, '')
  break
}
if (!BASE) {
  console.error(
    'usage: bun scripts/bench-local.ts <baseUrl> [--spawn cmd] [--stop cmd] [--runs 10] [--json out.json] [--label name]',
  )
  process.exit(1)
}
const SPAWN = option('--spawn')
const STOP = option('--stop')
const RUNS = Math.max(1, Number(option('--runs') ?? 10) || 10)
const JSON_OUT = option('--json')
const LABEL = option('--label') ?? 'install'

const EMAIL = 'bench@local.invalid'
const PASSWORD = 'bench-local-pass-1'
const BIG_CANVAS = 'Bench — 200 frames'
const SEED_FRAMES = 200
const SEED_ASSETS = 300
const RENDER_FRAMES = 50
const APPEND_CHUNKS = 100
const UPLOADS = 50
const API_SAMPLES = 30

const now = () => performance.now()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* a cookie-jar client (better-auth runs on cookies)                   */
/* ------------------------------------------------------------------ */

class Client {
  cookies = new Map<string, string>()

  constructor(private base: string) {}

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async req(pathname: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.base + pathname, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Origin: this.base,
        Cookie: this.cookieHeader(),
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

/* ------------------------------------------------------------------ */
/* deterministic content: a PNG encoder and a frame template           */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** A small real PNG (the upload route sniffs bytes), deterministic per seed. */
function makePng(seed: number): Buffer {
  const width = 96 + (seed % 5) * 48
  const height = 64 + (seed % 7) * 32
  const rows = Buffer.alloc((width * 3 + 1) * height)
  let x = seed || 1
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    rows[row] = 0 /* filter: none */
    for (let px = 0; px < width * 3; px++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff /* a cheap LCG: noise compresses badly on purpose */
      rows[row + 1 + px] = x >>> 16
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 /* bit depth */
  ihdr[9] = 2 /* colour type: rgb */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** ~5 KB of representative frame HTML, unique per index. */
function frameHtml(i: number): string {
  const cards = Array.from(
    { length: 6 },
    (_, k) =>
      `<section class="card" data-doop-id="c${i}-${k}"><h3>Card ${i}.${k}</h3><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit — metric ${(i * 7 + k) % 100}% of target.</p><button>Open</button></section>`,
  ).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bench frame ${i}</title><style>
:root{--bg:#faf8f5;--ink:#1c1917;--accent:#7c3aed;--line:#e7e5e4}*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,system-ui,sans-serif;padding:32px}
header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:24px}
h1{font-size:22px}nav{color:#78716c;font-size:12px;display:flex;gap:16px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px}
.card h3{font-size:14px;margin-bottom:6px}.card p{color:#57534e;font-size:12px;margin-bottom:12px}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:6px 12px;font-size:12px}
</style></head><body><header><h1>Bench frame ${i}</h1><nav><span>Overview</span><span>Reports</span><span>Settings</span></nav></header><div class="grid">${cards}</div></body></html>`
}

/** ~2 KB of streamable markup for the append chunks. */
function appendChunk(i: number): string {
  return `<section class="stream-block" data-doop-id="s${i}"><h2>Streamed section ${i}</h2><p>${'chunk '.repeat(120)}</p></section>`
}

/* ------------------------------------------------------------------ */
/* the fixed dataset                                                   */
/* ------------------------------------------------------------------ */

interface Dataset {
  canvasId: string
  frameIds: string[]
}

async function signIn(c: Client): Promise<void> {
  const res = await c.req('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (res.ok) return
  await c.json('POST', '/api/auth/sign-up/email', { email: EMAIL, password: PASSWORD, name: 'Bench' })
}

async function ensureDataset(c: Client): Promise<Dataset> {
  await signIn(c)
  const listed = await c.json<{ id: string; name: string }[] | { canvases: { id: string; name: string }[] }>(
    'GET',
    '/api/canvases',
  )
  const canvases = Array.isArray(listed) ? listed : listed.canvases
  const existing = canvases.find((canvas) => canvas.name === BIG_CANVAS)
  if (existing) {
    const full = await c.json<{ frames: { id: string }[] }>('GET', `/api/canvases/${existing.id}`)
    return { canvasId: existing.id, frameIds: full.frames.map((f) => f.id) }
  }

  console.log(`[seed] ${BIG_CANVAS}: ${SEED_FRAMES} frames, ${SEED_ASSETS} assets, two small canvases`)
  const t0 = now()
  const big = await c.json<{ id: string }>('POST', '/api/canvases', { name: BIG_CANVAS })
  const frameIds: string[] = []
  for (let i = 0; i < SEED_FRAMES; i++) {
    const f = await c.json<{ id: string }>('POST', `/api/canvases/${big.id}/frames`, {
      name: `Bench frame ${i}`,
      x: (i % 10) * 1500,
      y: Math.floor(i / 10) * 960,
      width: 1440,
      height: 900,
      html: frameHtml(i),
    })
    frameIds.push(f.id)
  }
  for (const name of ['Bench — boards', 'Bench — archive']) {
    const small = await c.json<{ id: string }>('POST', '/api/canvases', { name })
    for (let i = 0; i < 3; i++) {
      await c.json('POST', `/api/canvases/${small.id}/frames`, {
        name: `${name} ${i}`,
        x: i * 1500,
        y: 0,
        width: 1440,
        height: 900,
        html: frameHtml(i),
      })
    }
  }
  for (let i = 0; i < SEED_ASSETS; i++) {
    const res = await c.req(`/api/canvases/${big.id}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: makePng(i),
    })
    if (!res.ok) throw new Error(`asset upload ${i} → ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
  console.log(`[seed] done in ${((now() - t0) / 1000).toFixed(1)} s`)
  return { canvasId: big.id, frameIds }
}

/* ------------------------------------------------------------------ */
/* process control                                                     */
/* ------------------------------------------------------------------ */

const serverLog = path.join(tmpdir(), `bench-server-${process.pid}.log`)
let server: ChildProcess | null = null
const coldStarts: number[] = []

async function waitHealthy(deadlineMs: number): Promise<number> {
  const t0 = now()
  for (;;) {
    try {
      if ((await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(2000) })).ok) return now() - t0
    } catch {
      /* not up yet */
    }
    /* a non-zero exit is the server dying; a clean exit is a one-shot spawn
       command (container start) that left the server behind — keep polling */
    if (server && server.exitCode !== null && server.exitCode !== 0)
      throw new Error(`the server exited (${server.exitCode}); see ${serverLog}`)
    if (now() - t0 > deadlineMs) throw new Error(`${BASE}/healthz did not answer in ${deadlineMs / 1000} s`)
    await sleep(50)
  }
}

async function startServer(record = true): Promise<number> {
  /* `exec` makes the spawned pid the server's own, so SIGTERM and `ps rss`
     reach it directly; `container start`-style commands exit on their own */
  const log = openSync(serverLog, 'a')
  server = spawn('sh', ['-c', `exec ${SPAWN}`], { stdio: ['ignore', log, log] })
  const ms = await waitHealthy(120_000)
  if (record) coldStarts.push(ms)
  return ms
}

async function stopServer(): Promise<void> {
  if (STOP) {
    execSync(STOP, { stdio: 'ignore' })
    return
  }
  const child = server
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const deadline = Date.now() + 15_000
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      break
    }
    await sleep(100)
  }
}

function rssKb(pid: number): number | null {
  try {
    return Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(pid)])
        .toString()
        .trim(),
    )
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* metrics                                                             */
/* ------------------------------------------------------------------ */

async function timed(label: string, fn: () => Promise<unknown>): Promise<number> {
  const t0 = now()
  await fn()
  const ms = now() - t0
  if (!Number.isFinite(ms)) throw new Error(`${label} returned no timing`)
  return ms
}

async function roomJoin(c: Client, canvasId: string): Promise<number> {
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/ws`
  const cookie = c.cookieHeader()
  const t0 = now()
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('room join timed out'))
    }, 60_000)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'join',
          canvasId,
          clientId: `bench-${createHash('sha1').update(String(t0)).digest('hex').slice(0, 8)}`,
          name: 'bench',
          kind: 'user',
        }),
      ),
    )
    ws.on('message', (data) => {
      try {
        if ((JSON.parse(String(data)) as { type?: string }).type === 'init') {
          clearTimeout(timer)
          /* resolve before close: under Bun, ws.close() emits 'close'
             synchronously and would win the race with reject below */
          resolve()
          ws.close()
        }
      } catch {
        /* a partial frame of protocol traffic — keep waiting for init */
      }
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    ws.on('close', (code) => {
      clearTimeout(timer)
      reject(new Error(`the room closed before init (${code})`))
    })
  })
  return now() - t0
}

function stats(samples: number[]): { n: number; median: number; p95: number; min: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]!
  return { n: sorted.length, median: at(0.5), p95: at(0.95), min: sorted[0]!, max: sorted[sorted.length - 1]! }
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`)

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

const series = new Map<string, number[]>()
const scalars = new Map<string, { value: number | null; unit: string; note?: string }>()
const c = new Client(BASE)

let firstBootMs: number | null = null
if (SPAWN) {
  /* the seed exists before the cold-start runs so every boot carries the
     dataset load it will have in real use; this first boot, which creates
     the data dir and migrates, is reported on its own */
  firstBootMs = await startServer(false)
} else {
  await waitHealthy(120_000)
}
const dataset = await ensureDataset(c)

if (SPAWN) {
  for (let i = 0; i < RUNS; i++) {
    await stopServer()
    await startServer()
  }
  await signIn(c)
}

/* API latency on the 200-frame canvas */
if (coldStarts.length) series.set('cold start → /healthz', coldStarts)
if (firstBootMs !== null) scalars.set('first boot (empty data dir)', { value: firstBootMs / 1000, unit: 's' })
const apiSamples: number[] = []
for (let i = 0; i < API_SAMPLES; i++) {
  apiSamples.push(
    await timed('api', async () => {
      await c.json('GET', `/api/canvases/${dataset.canvasId}`)
    }),
  )
}
series.set('GET /api/canvases/:id', apiSamples)

/* the room join carries every frame's HTML in init (deferHtml off) */
const joinSamples: number[] = []
for (let i = 0; i < RUNS; i++) joinSamples.push(await roomJoin(c, dataset.canvasId))
series.set('room join (200 frames)', joinSamples)

/* renders, cold then warm over the first RENDER_FRAMES frames — the session
   cookie rides along because anonymous renders are capped per IP/min and a
   desktop user is signed in anyway */
const renderIds = dataset.frameIds.slice(0, RENDER_FRAMES)
const coldRenders: number[] = []
let renderFailed = 0
for (const id of renderIds) {
  const t0 = now()
  const res = await fetch(`${BASE}/i/${id}.png`, { headers: { Cookie: c.cookieHeader() } })
  const ms = now() - t0
  await res.arrayBuffer()
  if (res.ok) coldRenders.push(ms)
  else renderFailed++
}
if (coldRenders.length) {
  series.set('render /i/*.png cold', coldRenders)
  const warmRenders: number[] = []
  for (const id of renderIds) {
    const t0 = now()
    const res = await fetch(`${BASE}/i/${id}.png`, { headers: { Cookie: c.cookieHeader() } })
    const ms = now() - t0
    await res.arrayBuffer()
    if (res.ok) warmRenders.push(ms)
  }
  series.set('render /i/*.png warm', warmRenders)
}
if (renderFailed)
  scalars.set('render /i/*.png', {
    value: null,
    unit: 'ms',
    note: `${renderFailed}/${RENDER_FRAMES} failed — no renderer?`,
  })

/* 100 streamed chunks through the REST twin of append_frame_html */
const appendFrame = await c.json<{ id: string }>('POST', `/api/canvases/${dataset.canvasId}/frames`, {
  name: 'Bench — append target',
  x: 0,
  y: 21 * 960,
  width: 1440,
  height: 900,
  html: '',
})
const appendSamples: number[] = []
for (let i = 0; i < APPEND_CHUNKS; i++) {
  appendSamples.push(
    await timed('append', async () => {
      await c.json('POST', `/api/frames/${appendFrame.id}/append`, {
        html_chunk: appendChunk(i),
        start: i === 0,
        done: i === APPEND_CHUNKS - 1,
      })
    }),
  )
}
series.set('append chunk (100)', appendSamples)

/* 50 uploads on top of the 300 seeded ones */
const uploadSamples: number[] = []
for (let i = 0; i < UPLOADS; i++) {
  uploadSamples.push(
    await timed('upload', async () => {
      const res = await c.req(`/api/canvases/${dataset.canvasId}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: makePng(SEED_ASSETS + i),
      })
      if (!res.ok) throw new Error(`upload → ${res.status}`)
    }),
  )
}
series.set('asset upload (50)', uploadSamples)

/* idle RSS of the spawned server (process-spawned installs only) */
if (server && server.exitCode === null && server.pid !== undefined) {
  await sleep(20_000)
  const samples: number[] = []
  for (let i = 0; i < 6; i++) {
    const kb = rssKb(server.pid)
    if (kb !== null) samples.push(kb)
    await sleep(5_000)
  }
  if (samples.length) scalars.set('idle RSS', { value: stats(samples).median / 1024, unit: 'MB' })
} else if (SPAWN) {
  scalars.set('idle RSS', {
    value: null,
    unit: 'MB',
    note: 'the spawn command exits — measure the runtime outside (container stats, docker stats)',
  })
}

/* report */
const pad = (s: string, n: number) => s.padEnd(n)
console.log(`\n# bench-local — ${LABEL} @ ${BASE}`)
console.log(
  `${pad('metric', 30)} ${'n'.padStart(4)} ${'median'.padStart(10)} ${'p95'.padStart(10)} ${'min'.padStart(10)} ${'max'.padStart(10)}`,
)
const json: Record<string, unknown> = { label: LABEL, base: BASE, at: new Date().toISOString(), metrics: {} }
const metrics = json.metrics as Record<string, unknown>
for (const [name, samples] of series) {
  const s = stats(samples)
  console.log(
    `${pad(name, 30)} ${String(s.n).padStart(4)} ${fmt(s.median).padStart(10)} ${fmt(s.p95).padStart(10)} ${fmt(s.min).padStart(10)} ${fmt(s.max).padStart(10)}`,
  )
  metrics[name] = { ...s, samples }
}
for (const [name, scalar] of scalars) {
  console.log(
    `${pad(name, 30)} ${''.padStart(4)} ${(scalar.value === null ? 'n/a' : `${scalar.value.toFixed(0)} ${scalar.unit}`).padStart(10)} ${scalar.note ?? ''}`,
  )
  metrics[name] = scalar
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(json, null, 2))
if (SPAWN) console.log(`server log: ${serverLog}`)

await stopServer()
process.exit(0)
