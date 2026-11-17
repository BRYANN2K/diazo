import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderJob } from '../shared/motion.ts'

vi.mock('../server/motionJobs.ts', () => ({
  patchRenderJob: vi.fn(() => ({ ok: true })),
  finishRenderJob: vi.fn(),
}))
const stored = vi.hoisted(() => ({ zip: undefined as Buffer | undefined }))
vi.mock('../server/assets.ts', () => ({
  storeAsset: vi.fn(async () => ({ id: 'a1' })),
  /* png sequences now arrive as a file on disk, not a buffer: the mock
     reads it back (the worker unlinks it once it is stored) */
  storeAssetFile: vi.fn(async (file: string) => {
    stored.zip = (await import('node:fs')).readFileSync(file)
    return { id: 'a1' }
  }),
}))

const { patchRenderJob, finishRenderJob } = await import('../server/motionJobs.ts')
const { storeAsset, storeAssetFile } = await import('../server/assets.ts')
const { MOTION_LIMITS } = await import('../shared/motion.ts')
const { mintRenderToken, revokeRenderToken, renderAccess, renderCookieName, renderDeps, runServerRender, zipStore } =
  await import('../server/motionRender.ts')
const { muxWebm } = await import('../server/webmMux.ts')

afterEach(() => vi.restoreAllMocks())

const JOB: RenderJob = {
  id: 'j1',
  canvasId: 'c1',
  pageId: 'p1',
  compositionId: 'comp1',
  format: 'pngseq',
  target: 'server',
  width: 64,
  height: 64,
  fps: 2,
  range: { start: 0, end: 2 },
  status: 'queued',
  progress: 0,
  createdBy: 'u1',
  createdByName: 'U',
  createdAt: 0,
  updatedAt: 0,
}

describe('render-scoped tokens', () => {
  it('grants exactly the two harness GETs, nothing else', () => {
    const token = mintRenderToken(JOB, 60_000)
    const cookie = `doop_render_token=${token}`
    expect(renderAccess(cookie, 'GET', '/canvases/c1')?.canvasId).toBe('c1')
    expect(renderAccess(cookie, 'GET', '/canvases/c1/pages/p1/composition')?.pageId).toBe('p1')
    /* another page of the same canvas, another canvas, other paths */
    expect(renderAccess(cookie, 'GET', '/canvases/c1/pages/p2/composition')).toBeNull()
    expect(renderAccess(cookie, 'GET', '/canvases/c2')).toBeNull()
    expect(renderAccess(cookie, 'GET', '/canvases/c1/pages/p1/composition/renders')).toBeNull()
    expect(renderAccess(cookie, 'GET', '/renders/j1/upload')).toBeNull()
    /* a write is never a render read, even on an allowed path */
    expect(renderAccess(cookie, 'PATCH', '/canvases/c1/pages/p1/composition')).toBeNull()
    expect(renderAccess(cookie, 'DELETE', '/canvases/c1')).toBeNull()
    revokeRenderToken(token)
  })

  it('dies with the render and on its own expiry', () => {
    const token = mintRenderToken(JOB, 60_000)
    revokeRenderToken(token)
    expect(renderAccess(`doop_render_token=${token}`, 'GET', '/canvases/c1')).toBeNull()
    const stale = mintRenderToken(JOB, -1)
    expect(renderAccess(`doop_render_token=${stale}`, 'GET', '/canvases/c1')).toBeNull()
  })

  it('reads the __Secure- name an https deploy sets', () => {
    const token = mintRenderToken(JOB, 60_000)
    expect(renderAccess(`__Secure-doop_render_token=${token}`, 'GET', '/canvases/c1')?.canvasId).toBe('c1')
    revokeRenderToken(token)
  })
})

/* a page stub shaped like what renderInPage touches: the network guard's
   plumbing calls, the cookie/viewport/goto setup, then evaluate() doing
   the harness's seek/capture (or WebCodecs encode) work. `ready` is what
   the harness readiness race resolves — 'ready' unless the test fails it */
function stubPage(evaluate: (expr: string) => unknown, ready: unknown = 'ready', fx: unknown = []) {
  const calls = {
    seeks: [] as number[],
    cookie: undefined as Record<string, unknown> | undefined,
    intercepted: false,
    closed: false,
    requestHandler: undefined as ((request: unknown) => void) | undefined,
  }
  const page = {
    setBypassServiceWorker: async () => {},
    createCDPSession: async () => ({ send: async () => {} }),
    setRequestInterception: async (on: boolean) => {
      calls.intercepted = on
    },
    on: (event: string, handler: (request: unknown) => void) => {
      if (event === 'request') calls.requestHandler = handler
      return page
    },
    setCookie: async (cookie: Record<string, unknown>) => {
      calls.cookie = cookie
    },
    setViewport: async () => {},
    goto: async () => {},
    waitForFunction: async () => {},
    evaluate: async (expr: string) => {
      const seek = /\((-?[\d.]+)\)\s*$/.exec(expr)
      if (seek && expr.includes('__doopMotionSeek') && !expr.includes('__doopWebm')) {
        calls.seeks.push(Number(seek[1]))
      }
      if (expr.includes('__doopMotionReady')) return ready
      const out = evaluate(expr)
      /* the captures answer {png, fx} / {pending, fx} — the undrawn-effect
         report rides every seek — so the stub wraps its own answer in the
         same envelope */
      if (expr.includes('__doopMotionCapture')) return { png: out, fx }
      if (expr.includes('__doopWebm') && expr.includes('__doopMotionSeek')) return { pending: out, fx }
      return out
    },
  }
  return { page, calls }
}

function openStub(evaluate: (expr: string) => unknown, ready: unknown = 'ready', fx: unknown = []) {
  const { page, calls } = stubPage(evaluate, ready, fx)
  vi.spyOn(renderDeps, 'openIsolatedPage').mockResolvedValue({
    page: page as never,
    close: async () => {
      calls.closed = true
    },
  })
  return calls
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

describe('the render worker', () => {
  it('seeks png frames in seconds and stores a real zip', async () => {
    const calls = openStub(() => PNG)
    await runServerRender(JOB)
    /* 4 frames at 2 fps: t = 0, .5, 1, 1.5 — never a frame index */
    expect(calls.seeks).toEqual([0, 0.5, 1, 1.5])
    const storedCall = vi.mocked(storeAssetFile).mock.calls[0]!
    expect(storedCall[0]).toMatch(/\.zip$/)
    expect(stored.zip!.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    /* a real zip on disk: local headers then the end-of-central record */
    expect(stored.zip!.subarray(-22, -18)).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    expect(storedCall[1]).toMatchObject({ mime: 'application/zip', ext: 'zip' })
    expect(calls.closed).toBe(true)
    expect(vi.mocked(finishRenderJob)).toHaveBeenCalledWith(JOB, 'a1')
  })

  it('keeps the renderer under the request guard and a scoped cookie', async () => {
    const calls = openStub(() => PNG)
    await runServerRender(JOB)
    /* the guard set request interception up — nothing goes out raw */
    expect(calls.intercepted).toBe(true)
    expect(calls.requestHandler).toBeTypeOf('function')
    expect(calls.cookie).toMatchObject({
      name: renderCookieName(),
      httpOnly: true,
      sameSite: 'Strict',
      path: '/',
    })
    /* the token died with the render: replaying the cookie grants nothing */
    expect(renderAccess(`doop_render_token=${calls.cookie!.value}`, 'GET', '/canvases/c1')).toBeNull()
  })

  it('lets the app origin through and drops private-network fetches', async () => {
    const calls = openStub(() => PNG)
    await runServerRender(JOB)
    const handle = calls.requestHandler!

    const continued = { n: 0 }
    await new Promise<void>((resolve) => {
      handle({
        url: () => 'http://localhost:4300/api/canvases/c1',
        method: () => 'GET',
        headers: () => ({}),
        hasPostData: () => false,
        continue: async () => {
          continued.n++
          resolve()
        },
        abort: async () => {},
        respond: async () => {},
        resourceType: () => 'xhr',
      })
    })
    expect(continued.n).toBe(1)

    const aborted = { n: 0 }
    await new Promise<void>((resolve) => {
      handle({
        url: () => 'http://169.254.169.254/latest/meta-data',
        method: () => 'GET',
        headers: () => ({}),
        hasPostData: () => false,
        continue: async () => {},
        abort: async () => {
          aborted.n++
          resolve()
        },
        respond: async () => {},
        resourceType: () => 'xhr',
      })
    })
    expect(aborted.n).toBe(1)
  })

  it('encodes webm frame by frame at explicit timestamps', async () => {
    const job: RenderJob = { ...JOB, format: 'webm' }
    const frames: { t: number; ts: number; key: boolean }[] = []
    openStub((expr) => {
      if (expr.includes('VideoEncoder.isConfigSupported')) return 'vp8'
      if (expr.includes('encoder.flush')) return []
      const args = /\(\{"t":(-?[\d.]+),"ts":(\d+),"key":(true|false)\}\)\s*$/.exec(expr)
      if (args && expr.includes('VideoFrame')) {
        const ts = Number(args[2])
        frames.push({ t: Number(args[1]), ts, key: args[3] === 'true' })
        return [{ type: ts === 0 ? 'key' : 'delta', ts, data: Buffer.from([ts % 251]).toString('base64') }]
      }
      return PNG
    })
    await runServerRender(job)
    /* 2 s at 2 fps: four seeks in seconds and a microsecond timestamp on
       each VideoFrame — the clock is the job's, never the wall's */
    expect(frames).toEqual([
      { t: 0, ts: 0, key: true },
      { t: 0.5, ts: 500_000, key: false },
      { t: 1, ts: 1_000_000, key: false },
      { t: 1.5, ts: 1_500_000, key: false },
    ])
    const stored = vi.mocked(storeAsset).mock.calls[0]!
    /* EBML magic: the file was muxed server-side from encoded chunks */
    expect(stored[0].subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    expect(stored[1]).toMatchObject({ mime: 'video/webm', ext: 'webm' })
    expect(stored[0].includes(Buffer.from('V_VP8'))).toBe(true)
  })

  it('fails fast and surfaces the error when the harness never readies', async () => {
    openStub((expr) => (expr.includes('.text-danger') ? 'this page has no film' : PNG), 'stalled')
    await runServerRender(JOB)
    expect(vi.mocked(patchRenderJob)).toHaveBeenCalledWith(
      JOB,
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('did not become ready: this page has no film'),
      }),
      'server',
    )
    expect(vi.mocked(storeAsset)).not.toHaveBeenCalled()
  })

  it('fails the render when a captured frame reports an undrawn effect', async () => {
    /* the harness leaves the drop list on the page; the first frame that
       arrives without its look fails the job — nothing ships degraded */
    openStub(() => PNG, 'ready', [{ fx: 'vignette', reason: 'no WebGL2 context' }])
    await runServerRender(JOB)
    expect(vi.mocked(patchRenderJob)).toHaveBeenCalledWith(
      JOB,
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('vignette (no WebGL2 context)'),
      }),
      'server',
    )
    expect(vi.mocked(storeAsset)).not.toHaveBeenCalled()
    expect(vi.mocked(storeAssetFile)).not.toHaveBeenCalled()
  })

  it('fails a render whose frames pass the upload cap mid-sequence', async () => {
    const cap = MOTION_LIMITS.RENDER_MAX_BYTES
    Object.assign(MOTION_LIMITS, { RENDER_MAX_BYTES: 128 })
    try {
      openStub(() => 'data:image/png;base64,' + Buffer.alloc(100).toString('base64'))
      await runServerRender(JOB)
      expect(vi.mocked(storeAsset)).not.toHaveBeenCalled()
      expect(vi.mocked(storeAssetFile)).not.toHaveBeenCalled()
      expect(vi.mocked(patchRenderJob)).toHaveBeenCalledWith(
        JOB,
        expect.objectContaining({ status: 'failed', error: expect.stringContaining('upload limit') }),
        'server',
      )
    } finally {
      Object.assign(MOTION_LIMITS, { RENDER_MAX_BYTES: cap })
    }
  })

  const strayZips = (seen: Set<string>) =>
    readdirSync(tmpdir()).filter((f) => f.startsWith('doop-render-') && !seen.has(f))

  it('closes and deletes the temp zip when a sequence capture fails', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('doop-render-')))
    let n = 0
    openStub(() => {
      if (++n === 3) throw new Error('capture died')
      return PNG
    })
    await runServerRender(JOB)
    /* the failed writer was closed then unlinked: nothing left behind */
    expect(strayZips(before)).toEqual([])
    expect(vi.mocked(patchRenderJob)).toHaveBeenCalledWith(
      JOB,
      expect.objectContaining({ status: 'failed', error: 'capture died' }),
      'server',
    )
  })

  it('deletes the temp zip when the asset store fails', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('doop-render-')))
    vi.mocked(storeAssetFile).mockRejectedValueOnce(new Error('disk full'))
    openStub(() => PNG)
    await runServerRender(JOB)
    expect(strayZips(before)).toEqual([])
    expect(vi.mocked(patchRenderJob)).toHaveBeenCalledWith(
      JOB,
      expect.objectContaining({ status: 'failed', error: 'disk full' }),
      'server',
    )
  })
})

describe('webm muxing', () => {
  it('writes a webm container players can open', () => {
    const buf = muxWebm(
      [
        { type: 'key', timestampUs: 0, data: Buffer.from('frame0') },
        { type: 'delta', timestampUs: 33_333, data: Buffer.from('frame1') },
      ],
      { codec: 'vp8', width: 64, height: 64, durationMs: 66 },
    )
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    expect(buf.includes(Buffer.from('webm'))).toBe(true)
    expect(buf.includes(Buffer.from('V_VP8'))).toBe(true)
    expect(buf.includes(Buffer.from('frame1'))).toBe(true)
  })

  it('opens a new cluster before a block timestamp outgrows int16', () => {
    const chunks = Array.from({ length: 4 }, (_, i) => ({
      type: (i === 0 ? 'key' : 'delta') as 'key' | 'delta',
      timestampUs: i * 20_000_000,
      data: Buffer.from(`f${i}`),
    }))
    const buf = muxWebm(chunks, { codec: 'vp09.00.10.08', width: 8, height: 8, durationMs: 80_000 })
    expect(buf.includes(Buffer.from('V_VP9'))).toBe(true)
    /* 0s, 20s, 40s, 60s at 1ms scale: two clusters (0/20 then 40/60) */
    const clusterId = Buffer.from([0x1f, 0x43, 0xb6, 0x75])
    let count = 0
    for (let i = 0; i + 4 <= buf.length; i++) if (buf.subarray(i, i + 4).equals(clusterId)) count++
    expect(count).toBe(2)
  })

  it('refuses an empty stream', () => {
    expect(() => muxWebm([], { codec: 'vp8', width: 8, height: 8, durationMs: 0 })).toThrow('no encoded chunks')
  })

  it('produces a container ffprobe accepts at every vint size boundary', () => {
    /* a SimpleBlock's payload is 4 header bytes + the frame, so a
     * 123-byte frame sizes its block at exactly 127 — the value an old
     * 32-bit vint wrote as 0xff, the 'unknown size' marker, which
     * corrupted every element after it. 16379 lands a block on the
     * 2-byte reserved value 16383 for the same reason. */
    const sizes = [1, 100, 122, 123, 124, 1000, 16_378, 16_379, 16_380, 60_000]
    const probe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' })
    for (const n of sizes) {
      const buf = muxWebm(
        [
          { type: 'key', timestampUs: 0, data: Buffer.alloc(n, 0x11) },
          { type: 'delta', timestampUs: 33_333, data: Buffer.alloc(10, 0x22) },
        ],
        { codec: 'vp8', width: 64, height: 64, durationMs: 66 },
      )
      if (probe.error) {
        /* no ffprobe on this machine: walk the EBML instead and require
         * every element to end inside its parent, flush to the byte */
        expect(walkEbml(buf)).toContain(0x1f43b675)
        continue
      }
      const dir = mkdtempSync(join(tmpdir(), 'webm-'))
      try {
        writeFileSync(join(dir, 'f.webm'), buf)
        const r = spawnSync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=format_name',
          '-of',
          'default=nw=1',
          join(dir, 'f.webm'),
        ])
        expect(r.status).toBe(0)
        expect(r.stdout.toString()).toContain('matroska,webm')
        expect(r.stderr.toString()).not.toMatch(/unknown-sized|invalid ebml|truncat/i)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})

/* walks the element tree and returns the ids seen; throws via expect if
 * a declared size overruns its parent or elements do not pack flush */
function walkEbml(buf: Buffer): number[] {
  const masters = new Set([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0x1f43b675])
  const widthOf = (b: number) => {
    for (let w = 1; w <= 8; w++) if (b & (1 << (8 - w))) return w
    throw new Error('bad vint')
  }
  const ids: number[] = []
  const walk = (start: number, end: number) => {
    let pos = start
    while (pos < end) {
      const iw = widthOf(buf.readUInt8(pos))
      const id = buf.readUIntBE(pos, iw)
      pos += iw
      const sw = widthOf(buf.readUInt8(pos))
      let size = buf.readUInt8(pos) & (sw >= 8 ? 0 : 0xff >>> sw)
      for (let i = 1; i < sw; i++) size = size * 256 + buf.readUInt8(pos + i)
      pos += sw
      const elemEnd = size === 2 ** (7 * sw) - 1 ? end : pos + size
      expect(elemEnd).toBeLessThanOrEqual(end)
      ids.push(id)
      if (masters.has(id)) walk(pos, elemEnd)
      pos = elemEnd
    }
    expect(pos).toBe(end)
  }
  walk(0, buf.length)
  return ids
}

describe('zipStore', () => {
  it('round-trips through a real zip reader shape', () => {
    const buf = zipStore([{ name: 'a.png', data: Buffer.from('PNG') }])
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(buf.subarray(-22, -18)).toEqual(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  })
})
