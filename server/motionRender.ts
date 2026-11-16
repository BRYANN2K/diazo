/** server/motionRender.ts — the server render worker (phase 5).
 *  A `target: 'server'` job renders on the instance's own headless
 *  Chromium through the renderer gate, at background priority and under
 *  the phase-5 caps (enforced in motionJobs.createRenderJob): 60 s, 1080p,
 *  30 fps, one open server render per account. The worker mints a
 *  short-lived session for the requester so the app's own render harness
 *  (`/c/<id>/motion-render`) can read the canvas and the composition,
 *  drives its `__doopMotionSeek`/`__doopMotionCapture` contract, and lands
 *  the file as an /a/ asset — mp4/gif stay browser/desktop formats. */

import { sql } from 'drizzle-orm'
import { createHmac } from 'node:crypto'
import { nanoid } from 'nanoid'
import { db } from './db/index.ts'
import { env } from './env.ts'
import { openIsolatedPage } from './screenshot.ts'
import { finishRenderJob, patchRenderJob } from './motionJobs.ts'
import { storeAsset } from './assets.ts'
import { MOTION_LIMITS, type RenderJob } from '../shared/motion.ts'

/** the wall-clock budget on top of real-time rendering: startup + encode */
const OVERHEAD_MS = 120_000
/** the minted session lives at most this long; it is deleted after the run */
const SESSION_MS = 2 * 60 * 60_000
const CLAIMANT = 'server'

/* -- render-scoped sessions ---------------------------------------------
 *  The harness page calls the same session API routes a browser does; a
 *  row in better-auth's own session table is its cookie. Inserted
 *  directly because there is no password to sign in with — deleted on
 *  every path out of a render. */

async function mintRenderSession(userId: string): Promise<string> {
  const token = nanoid(48)
  const now = new Date()
  const expires = new Date(Date.now() + SESSION_MS)
  await db.execute(
    sql`insert into "session" (id, token, user_id, expires_at, created_at, updated_at)
        values (${nanoid(16)}, ${token}, ${userId}, ${expires}, ${now}, ${now})`,
  )
  return token
}

async function dropRenderSession(token: string): Promise<void> {
  try {
    await db.execute(sql`delete from "session" where token = ${token}`)
  } catch {
    /* a dead session is worth a log line, not a failed render */
  }
}

/** The browser cookie better-auth reads is the raw session token plus an
 *  HMAC signature of it under the instance secret — the same shape
 *  `setSignedCookie` writes at sign-in (better-call crypto). */
function signedSessionCookie(token: string): string {
  const signature = createHmac('sha256', env.BETTER_AUTH_SECRET).update(token).digest('base64')
  return encodeURIComponent(`${token}.${signature}`)
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

/** One capture step, evaluated inside the harness page. */
const SEEK_CAPTURE = `async (i) => {
  await window.__doopMotionSeek(i);
  return window.__doopMotionCapture();
}`

/** The realtime webm driver: seek each frame at wall-clock pace while a
 *  MediaRecorder tapes the canvas stream, then hand back a data URL. */
const RECORD_WEBM = `async ({ frames, fps }) => {
  const canvas = document.querySelector('canvas[data-slot="motion-render"]');
  if (!canvas) throw new Error('no motion render canvas');
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start();
  for (let i = 0; i < frames; i++) {
    await window.__doopMotionSeek(i / fps);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: 'video/webm' });
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}`

async function renderInPage(
  job: RenderJob,
  url: string,
  frames: number,
  sessionToken: string,
): Promise<{ buf: Buffer; mime: string; ext: string }> {
  const duration = job.range.end - job.range.start
  const budget = OVERHEAD_MS + Math.round(duration * 1000) * (job.format === 'webm' ? 2 : 1)
  const iso = await openIsolatedPage({ priority: 'background' })
  try {
    const page = iso.page
    const origin = new URL(url).origin
    await page.setCookie({ name: 'better-auth.session_token', value: signedSessionCookie(sessionToken), url: origin })
    await page.setViewport({ width: job.width, height: job.height })
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 })
    await page.waitForFunction(
      'typeof window.__doopMotionSeek === "function" && typeof window.__doopMotionCapture === "function"',
      { timeout: 60_000 },
    )
    if (job.format === 'webm') {
      const dataUrl = (await Promise.race([
        page.evaluate(`(${RECORD_WEBM})(${JSON.stringify({ frames, fps: job.fps })})`),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('render timed out')), budget)),
      ])) as string
      const b64 = dataUrl.split(',')[1] ?? ''
      const buf = Buffer.from(b64, 'base64')
      if (buf.length === 0 || buf.length > MOTION_LIMITS.RENDER_MAX_BYTES) {
        throw new Error('the webm is empty or over the upload limit')
      }
      return { buf, mime: 'video/webm', ext: 'webm' }
    }
    const entries: { name: string; data: Buffer }[] = []
    const pad = String(frames).length
    for (let i = 0; i < frames; i++) {
      const dataUrl = (await page.evaluate(`(${SEEK_CAPTURE})(${i})`)) as string
      entries.push({
        name: `frame-${String(i).padStart(pad, '0')}.png`,
        data: Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'),
      })
      if (i % 30 === 0) patchRenderJob(job, { progress: (i / frames) * 0.9 }, CLAIMANT)
    }
    const buf = zipStore(entries)
    if (buf.length > MOTION_LIMITS.RENDER_MAX_BYTES) throw new Error('the sequence is over the upload limit')
    return { buf, mime: 'application/zip', ext: 'zip' }
  } finally {
    await iso.close()
  }
}

/** Claim and render one queued server job; any failure ends it as failed. */
export async function runServerRender(job: RenderJob): Promise<void> {
  const fail = (error: string) => {
    patchRenderJob(job, { status: 'failed', error }, CLAIMANT)
  }
  try {
    const claimed = patchRenderJob(job, { status: 'rendering', progress: 0 }, CLAIMANT)
    if (!claimed.ok) return
    const token = await mintRenderSession(job.createdBy)
    try {
      const origin = env.BETTER_AUTH_URL
      const url = `${origin}/c/${job.canvasId}/motion-render?page=${job.pageId}&start=${job.range.start}`
      const frames = Math.max(1, Math.round((job.range.end - job.range.start) * job.fps))
      const out = await renderInPage(job, url, frames, token)
      patchRenderJob(job, { status: 'encoding', progress: 0.95 }, CLAIMANT)
      const asset = await storeAsset(
        out.buf,
        { mime: out.mime, ext: out.ext },
        {
          canvasId: job.canvasId,
          ownerId: job.createdBy,
          uploadedBy: job.createdByName,
        },
      )
      finishRenderJob(job, asset.id)
    } finally {
      await dropRenderSession(token)
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : 'server render failed')
  }
}
