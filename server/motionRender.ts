/** server/motionRender.ts — the server render worker (phase 5).
 *  A `target: 'server'` job renders on the instance's own headless
 *  Chromium through the renderer gate, at background priority and under
 *  the phase-5 caps (enforced in motionJobs.createRenderJob): 60 s, 1080p,
 *  30 fps, one open server render per account — and one running on the
 *  whole server at a time (the queue below). The worker mints a
 *  render-scoped read token — not a session — so the app's own render
 *  harness (`/c/<id>/motion-render`) can GET its canvas and composition
 *  and nothing else, drives the page under the same public-network guard
 *  every other render uses, seeks deterministically and encodes frame by
 *  frame, and lands the file as an /a/ asset — mp4/gif stay
 *  browser/desktop formats. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { env } from './env.ts'
import { openIsolatedPage } from './screenshot.ts'
import { guardPublicPageRequests } from './publicUrl.ts'
import { finishRenderJob, patchRenderJob } from './motionJobs.ts'
import { storeAsset, storeAssetFile } from './assets.ts'
import { muxWebm, type WebmChunk } from './webmMux.ts'
import { MOTION_LIMITS, type RenderJob } from '../shared/motion.ts'

/** the wall-clock budget on top of the film's duration: startup + encode */
const OVERHEAD_MS = 120_000
const CLAIMANT = 'server'

/* -- render-scoped read tokens ------------------------------------------
 *  The harness page reads the canvas and the composition over the app's
 *  own GET routes. A token here — not a session — is that read: minted
 *  for one job, bound to (canvasId, pageId), honoured only on GETs of
 *  exactly the two routes it calls, and dead the moment the render ends
 *  or its budget runs out. It never reaches the session middleware's
 *  other routes: the /api gate below admits it only where renderAccess
 *  says so. */

interface RenderGrant {
  canvasId: string
  pageId: string
  expiresAt: number
}
const renderGrants = new Map<string, RenderGrant>()

const RENDER_COOKIE = 'doop_render_token'

/** Chromium refuses a `__Secure-`-prefixed cookie that is not `Secure`
 *  over https, and better-auth itself names its cookie the same way:
 *  prefixed on https deployments, bare for local http installs. */
export function renderCookieName(): string {
  return env.BETTER_AUTH_URL.startsWith('https:') ? `__Secure-${RENDER_COOKIE}` : RENDER_COOKIE
}

/** Mint a token for one scope's reads; `ttlMs` is the work's own budget,
 *  so the credential can never outlive it. A render job passes itself, a
 *  snapshot/check pass its (canvasId, pageId). */
export function mintRenderToken(scope: { canvasId: string; pageId: string }, ttlMs: number): string {
  const token = nanoid(48)
  renderGrants.set(token, { canvasId: scope.canvasId, pageId: scope.pageId, expiresAt: Date.now() + ttlMs })
  return token
}

export function revokeRenderToken(token: string): void {
  renderGrants.delete(token)
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** The token stands in for a session only where it was minted to work:
 *  GETs of its own canvas and of its own page's composition — every
 *  other method or path returns null and the session gate answers 401.
 *  `path` is the mount-relative path the /api middleware sees. */
export function renderAccess(
  cookieHeader: string | undefined,
  method: string,
  path: string,
): { canvasId: string; pageId: string } | null {
  if (method !== 'GET') return null
  const token = cookieValue(cookieHeader, `__Secure-${RENDER_COOKIE}`) ?? cookieValue(cookieHeader, RENDER_COOKIE)
  const grant = token ? renderGrants.get(token) : undefined
  if (!grant) return null
  if (grant.expiresAt <= Date.now()) {
    renderGrants.delete(token!)
    return null
  }
  const whole = /^\/canvases\/([^/]+?)\/?$/.exec(path)
  const composition = /^\/canvases\/([^/]+)\/pages\/([^/]+)\/composition\/?$/.exec(path)
  if (whole) {
    return decodeURIComponent(whole[1]!) === grant.canvasId ? grant : null
  }
  if (composition) {
    return decodeURIComponent(composition[1]!) === grant.canvasId &&
      decodeURIComponent(composition[2]!) === grant.pageId
      ? grant
      : null
  }
  return null
}

/* -- a dependency-free stored ZIP (pngseq) ------------------------------- */

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
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A stored (uncompressed) zip written incrementally: each frame's bytes
 *  are appended as a local file entry the moment they are captured, so a
 *  long sequence holds only the current frame in memory — plus the central
 *  directory bookkeeping (tens of bytes per entry). */
export class ZipWriter {
  private central: Buffer[] = []
  private offset = 0
  private count = 0
  private constructor(
    private file: fs.promises.FileHandle,
    readonly path: string,
  ) {}

  static async create(path: string): Promise<ZipWriter> {
    return new ZipWriter(await fs.promises.open(path, 'w'), path)
  }

  private async writeAll(buf: Buffer): Promise<void> {
    for (let off = 0; off < buf.length;) {
      const { bytesWritten } = await this.file.write(buf, off)
      off += bytesWritten
    }
  }

  async add(name: string, data: Buffer): Promise<void> {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0, 22)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBuf.length, 26)
    await this.writeAll(Buffer.concat([head, nameBuf, data]))
    const cent = Buffer.alloc(46)
    cent.writeUInt32LE(0x02014b50, 0)
    cent.writeUInt16LE(20, 4)
    cent.writeUInt16LE(20, 6)
    cent.writeUInt32LE(crc, 16)
    cent.writeUInt32LE(data.length, 20)
    cent.writeUInt32LE(data.length, 24)
    cent.writeUInt16LE(nameBuf.length, 28)
    cent.writeUInt32LE(this.offset, 42)
    this.central.push(Buffer.concat([cent, nameBuf]))
    this.offset += 30 + nameBuf.length + data.length
    this.count++
  }

  /** close the handle without a central directory: the partial file is
   *  garbage the caller deletes. Never throws — a failed close on a dead
   *  render must not mask the error that killed it. */
  async abort(): Promise<void> {
    await this.file.close().catch(() => {})
  }

  async finish(): Promise<number> {
    try {
      const centBuf = Buffer.concat(this.central)
      const eocd = Buffer.alloc(22)
      eocd.writeUInt32LE(0x06054b50, 0)
      eocd.writeUInt16LE(this.count, 8)
      eocd.writeUInt16LE(this.count, 10)
      eocd.writeUInt32LE(centBuf.length, 12)
      eocd.writeUInt32LE(this.offset, 16)
      await this.writeAll(Buffer.concat([centBuf, eocd]))
      return this.offset + centBuf.length + eocd.length
    } finally {
      /* a write that dies halfway still owes the handle a close */
      await this.file.close().catch(() => {})
    }
  }
}

export function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0, 22)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBuf.length, 26)
    local.push(head, nameBuf, data)
    const cent = Buffer.alloc(46)
    cent.writeUInt32LE(0x02014b50, 0)
    cent.writeUInt16LE(20, 4)
    cent.writeUInt16LE(20, 6)
    cent.writeUInt32LE(crc, 16)
    cent.writeUInt32LE(data.length, 20)
    cent.writeUInt32LE(data.length, 24)
    cent.writeUInt16LE(nameBuf.length, 28)
    cent.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cent, nameBuf]))
    offset += 30 + nameBuf.length + data.length
  }
  const centBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centBuf, eocd])
}

/* -- the in-page driver -------------------------------------------------- */

/** One capture step, evaluated inside the harness page. `__doopMotionSeek`
 *  takes seconds (src/pages/MotionRenderHarness.tsx). */
const SEEK_CAPTURE = `async (t) => {
  await window.__doopMotionSeek(t);
  return window.__doopMotionCapture();
}`

/* The deterministic webm driver: WebCodecs encodes every seeked frame at
 * an explicit microsecond timestamp — nothing is paced by the wall clock
 * the way a MediaRecorder stream is. Chunks ride back to Node for muxing
 * (server/webmMux.ts) so the encode is also capped and checkable. */
const WEBM_OPEN = `async ({ fps, width, height }) => {
  const canvas = document.querySelector('canvas[data-slot="motion-render"]');
  if (!canvas) throw new Error('no motion render canvas');
  if (typeof VideoEncoder === 'undefined') throw new Error('this browser cannot encode webm');
  const pending = [];
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      let bin = '';
      for (const b of buf) bin += String.fromCharCode(b);
      pending.push({ type: chunk.type, ts: chunk.timestamp, data: btoa(bin) });
    },
    error: (e) => { window.__doopWebmError = String(e && e.message ? e.message : e); },
  });
  const config = { codec: 'vp8', width, height, framerate: fps, bitrate: 6_000_000 };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) config.codec = 'vp09.00.10.08';
  encoder.configure(config);
  window.__doopWebm = { encoder, pending, canvas, fps };
  return config.codec;
}`

const WEBM_FRAME = `async ({ t, ts, key }) => {
  const s = window.__doopWebm;
  await window.__doopMotionSeek(t);
  const frame = new VideoFrame(s.canvas, { timestamp: ts, duration: Math.round(1e6 / s.fps) });
  s.encoder.encode(frame, { keyFrame: key });
  frame.close();
  if (window.__doopWebmError) throw new Error(window.__doopWebmError);
  return s.pending.splice(0);
}`

const WEBM_FLUSH = `async () => {
  const s = window.__doopWebm;
  await s.encoder.flush();
  if (window.__doopWebmError) throw new Error(window.__doopWebmError);
  return s.pending.splice(0);
}`

/* seams so tests can drive renderInPage without a browser */
export const renderDeps = { openIsolatedPage }

const base64Bytes = (dataUrl: string) => Buffer.from(dataUrl.split(',')[1] ?? '', 'base64')

/** A render's output: a buffer (webm — muxing needs the whole byte stream
 *  anyway) or a file on disk (png sequences — the zip is appended frame by
 *  frame so the sequence never sits whole in memory). */
type RenderOutput = { buf: Buffer; mime: string; ext: string } | { file: string; mime: string; ext: string }

async function capturePngseq(
  page: { evaluate: (expr: string) => Promise<unknown> },
  job: RenderJob,
  frames: number,
): Promise<RenderOutput> {
  const file = path.join(os.tmpdir(), `doop-render-${nanoid(10)}.zip`)
  const zip = await ZipWriter.create(file)
  const pad = String(frames).length
  /* every frame's bytes are charged as it arrives and appended straight to
     the zip on disk: a page that starts emitting oversized captures fails
     the render immediately instead of building the whole sequence in
     memory first */
  let bytes = 0
  try {
    for (let i = 0; i < frames; i++) {
      const dataUrl = (await page.evaluate(`(${SEEK_CAPTURE})(${i / job.fps})`)) as string
      const data = base64Bytes(dataUrl)
      bytes += data.length
      if (bytes > MOTION_LIMITS.RENDER_MAX_BYTES) throw new Error('the sequence is over the upload limit')
      await zip.add(`frame-${String(i).padStart(pad, '0')}.png`, data)
      if (i % 30 === 0) patchRenderJob(job, { progress: (i / frames) * 0.9 }, CLAIMANT)
    }
    const size = await zip.finish()
    if (size > MOTION_LIMITS.RENDER_MAX_BYTES) throw new Error('the sequence is over the upload limit')
    return { file, mime: 'application/zip', ext: 'zip' }
  } catch (e) {
    /* close the writer first — deleting a file its handle still holds
     * leaks the descriptor (and keeps the bytes on windows) */
    await zip.abort()
    await fs.promises.rm(file, { force: true }).catch(() => {})
    throw e
  }
}

async function captureWebm(
  page: { evaluate: (expr: string) => Promise<unknown> },
  job: RenderJob,
  frames: number,
): Promise<RenderOutput> {
  const codec = (await page.evaluate(
    `(${WEBM_OPEN})(${JSON.stringify({ fps: job.fps, width: job.width, height: job.height })})`,
  )) as string
  const chunks: WebmChunk[] = []
  let bytes = 0
  const collect = (emitted: { type: 'key' | 'delta'; ts: number; data: string }[]) => {
    for (const c of emitted) {
      const data = Buffer.from(c.data, 'base64')
      bytes += data.length
      if (bytes > MOTION_LIMITS.RENDER_MAX_BYTES) throw new Error('the webm is over the upload limit')
      chunks.push({ type: c.type, timestampUs: c.ts, data })
    }
  }
  const frameUs = Math.round(1e6 / job.fps)
  /* a forced keyframe every two seconds keeps each cluster decodable */
  const keyEvery = Math.max(1, Math.round(job.fps * 2))
  for (let i = 0; i < frames; i++) {
    const emitted = (await page.evaluate(
      `(${WEBM_FRAME})(${JSON.stringify({ t: i / job.fps, ts: i * frameUs, key: i % keyEvery === 0 })})`,
    )) as { type: 'key' | 'delta'; ts: number; data: string }[]
    collect(emitted)
    if (i % 30 === 0) patchRenderJob(job, { progress: (i / frames) * 0.9 }, CLAIMANT)
  }
  collect((await page.evaluate(`(${WEBM_FLUSH})()`)) as { type: 'key' | 'delta'; ts: number; data: string }[])
  if (!chunks.length) throw new Error('the webm is empty')
  const buf = muxWebm(chunks, { codec, width: job.width, height: job.height, durationMs: (frames / job.fps) * 1000 })
  if (buf.length > MOTION_LIMITS.RENDER_MAX_BYTES) throw new Error('the webm is over the upload limit')
  return { buf, mime: 'video/webm', ext: 'webm' }
}

/** How long the harness gets to become ready after load — a failed one
 *  (a 401, a missing composition) never resolves `__doopMotionReady` and
 *  would hold the render slot for the whole budget otherwise. */
const HARNESS_READY_MS = 60_000

async function renderInPage(
  job: RenderJob,
  url: string,
  frames: number,
  renderToken: string,
  budget: number,
): Promise<RenderOutput> {
  /* the page keeps its render slot for the whole budget — the renderer's
     default 120 s lease would close a long render mid-capture */
  const iso = await renderDeps.openIsolatedPage({ priority: 'background', leaseMs: budget })
  try {
    const page = iso.page
    const origin = new URL(url).origin
    /* the same public-network guard every other render gets: only the app
       itself (the harness SPA, its /api and /a/) and the approved font
       origins go direct — canvas code cannot reach the VPS's network */
    await guardPublicPageRequests(page, {
      allowUrl: (u) =>
        u.origin === origin || u.origin === 'https://fonts.googleapis.com' || u.origin === 'https://fonts.gstatic.com',
    })
    const https = origin.startsWith('https:')
    await page.setCookie({
      name: renderCookieName(),
      value: renderToken,
      url: origin,
      path: '/',
      httpOnly: true,
      secure: https,
      sameSite: 'Strict',
      expires: Math.floor((Date.now() + budget) / 1000),
    })
    await page.setViewport({ width: job.width, height: job.height })
    await page.goto(url, { waitUntil: 'networkidle0', timeout: HARNESS_READY_MS })
    await page.waitForFunction(
      'typeof window.__doopMotionSeek === "function" && typeof window.__doopMotionCapture === "function"',
      { timeout: HARNESS_READY_MS },
    )
    /* the two hooks exist before the film loads — a harness that failed
       (a 401, a missing composition) leaves `__doopMotionReady` pending
       and the first seek would wait out the whole budget; race it and
       surface the error the harness renders */
    const ready = await page.evaluate(
      `Promise.race([window.__doopMotionReady.then(() => 'ready'), new Promise((r) => setTimeout(() => r('stalled'), ${HARNESS_READY_MS}))])`,
    )
    if (ready !== 'ready') {
      const hint = await page.evaluate(`document.querySelector('.text-danger')?.innerText ?? ''`)
      throw new Error(`the render harness did not become ready${typeof hint === 'string' && hint ? `: ${hint}` : ''}`)
    }
    /* one deadline around the whole capture, whatever the format */
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        job.format === 'webm' ? captureWebm(page, job, frames) : capturePngseq(page, job, frames),
        new Promise<never>((_r, rej) => {
          timer = setTimeout(() => rej(new Error('render timed out')), budget)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await iso.close()
  }
}

/* one server render at a time on the whole instance: renders are heavy
   and the job row is the queue — the per-account cap alone would let
   parallel renders from different accounts starve the renderer */
let serverRenderChain: Promise<unknown> = Promise.resolve()

/** Queue a queued server job; it renders when the instance's one server
 *  render slot reaches it. Any failure ends the job as failed. */
export function queueServerRender(job: RenderJob): void {
  serverRenderChain = serverRenderChain.then(() => runServerRender(job))
}

/** Claim and render one queued server job; any failure ends it as failed. */
export async function runServerRender(job: RenderJob): Promise<void> {
  const fail = (error: string) => {
    patchRenderJob(job, { status: 'failed', error }, CLAIMANT)
  }
  let token: string | undefined
  try {
    const claimed = patchRenderJob(job, { status: 'rendering', progress: 0 }, CLAIMANT)
    if (!claimed.ok) return
    const duration = job.range.end - job.range.start
    /* one budget for the page's slot and the render token's life */
    const budget = OVERHEAD_MS + Math.round(duration * 1000) * 2
    token = mintRenderToken(job, budget)
    const origin = env.BETTER_AUTH_URL
    const url = `${origin}/c/${job.canvasId}/motion-render?page=${job.pageId}&start=${job.range.start}`
    const frames = Math.max(1, Math.round(duration * job.fps))
    const out = await renderInPage(job, url, frames, token, budget)
    patchRenderJob(job, { status: 'encoding', progress: 0.95 }, CLAIMANT)
    const meta = { canvasId: job.canvasId, ownerId: job.createdBy, uploadedBy: job.createdByName }
    try {
      const asset =
        'file' in out
          ? await storeAssetFile(out.file, { mime: out.mime, ext: out.ext }, meta)
          : await storeAsset(out.buf, { mime: out.mime, ext: out.ext }, meta)
      finishRenderJob(job, asset.id)
    } finally {
      /* a failed store must not strand the temp sequence on disk */
      if ('file' in out) await fs.promises.rm(out.file, { force: true }).catch(() => {})
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : 'server render failed')
  } finally {
    if (token) revokeRenderToken(token)
  }
}
