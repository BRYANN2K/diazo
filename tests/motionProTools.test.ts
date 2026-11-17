import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The motion-pro tool surface against the in-memory store, same contract
   the resident agent and the MCP tools share: persist stubbed, every call
   through the exported functions execMotionPro dispatches on. */

const mocks = vi.hoisted(() => ({ saveFrameVersion: vi.fn(() => {}) }))

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveComposition: () => {},
  saveCompositionVersion: () => {},
  saveFrameVersion: mocks.saveFrameVersion,
  deleteComposition: () => {},
  saveRenderJob: () => {},
  deleteRenderJob: () => {},
  loadRenderJobs: async () => [],
  loadFrameHtml: async () => [],
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const pro = await import('../server/motionProTools.ts')
const { createRenderJob } = await import('../server/motionJobs.ts')
const { canvasPages } = await import('../shared/pages.ts')
const snapshot = await import('../server/motionSnapshot.ts')
const { readFileSync } = await import('node:fs')
const { CAMERA_PRESETS } = await import('../shared/motionPresets.ts')
const { MOTION_LOOKS } = await import('../shared/motionLooks.ts')
import type { Canvas } from '../shared/types.ts'
import type { MotionTrack } from '../shared/motion.ts'

const actor = () => actions.resolveActor({ name: 'Test Agent', kind: 'agent' })

let canvas: Canvas
let pageId: string
let frameId: string

const TEXT_HTML = `<!doctype html><html><body><h1 data-doop-id="hero">A $& B $$ C</h1><p data-doop-id="sub">some copy</p></body></html>`

const baseComp = (tracks: MotionTrack[] = []) => ({
  duration: 6,
  fps: 30,
  width: 1920,
  height: 1080,
  tracks,
})

beforeEach(() => {
  mocks.saveFrameVersion.mockReset()
  actions.wire(
    () => {},
    () => {},
  )
  canvas = store.createCanvas('fx', 'kevin')!
  pageId = canvasPages(canvas)[0]!.id
  frameId = actions.createFrame(
    canvas.id,
    { name: 'Shot', width: 800, height: 600, html: TEXT_HTML, x: 0, y: 0 },
    actor(),
    { reveal: false },
  )!.id
  actions.setComposition(canvas.id, baseComp(), pageId, actor())
})

const comp = () => store.getComposition(canvas.id, pageId)!

describe('director kit — direction, presets, transitions, shutter', () => {
  it('set_direction writes the treatment and get_direction reads it back', () => {
    const set = pro.setDirection(canvas, pageId, { treatment: 'Cold open, one hero beat.', passes: 4 }, actor())
    expect(set.ok).toBe(true)
    const got = pro.getDirection(canvas, pageId)
    expect(got.ok && (got.data as { direction: { treatment: string } }).direction.treatment).toContain('Cold open')
  })

  it('list_motion_presets names every camera preset, transition and animator', () => {
    const out = pro.listMotionPresets()
    const data = (
      out as { ok: true; data: { camera_presets: { id: string }[]; transitions: unknown[]; text_animators: string[] } }
    ).data
    expect(data.camera_presets.length).toBeGreaterThan(5)
    expect(data.transitions.length).toBeGreaterThan(0)
    expect(data.text_animators).toContain('rise-blur')
  })

  it('apply_camera_preset writes editable camera keyframes', () => {
    const out = pro.applyCameraPreset(canvas, pageId, { preset: CAMERA_PRESETS[0], t: 0, duration: 2 }, actor())
    expect(out.ok).toBe(true)
    const camera = comp().tracks.find((t) => t.kind === 'camera')
    expect(camera?.keyframes?.length).toBeGreaterThan(0)
    const bad = pro.applyCameraPreset(canvas, pageId, { preset: 'not-a-preset' }, actor())
    expect(bad.ok).toBe(false)
  })

  it('apply_transition hangs a transition on the named clip', () => {
    actions.setComposition(
      canvas.id,
      baseComp([
        {
          id: 'ct',
          kind: 'clip',
          name: 'Clips',
          clips: [{ id: 'c1', start: 0, duration: 3, source: { type: 'frame', frameId } }],
        },
      ]),
      pageId,
      actor(),
    )
    const out = pro.applyTransition(
      canvas,
      pageId,
      { track_id: 'ct', clip_id: 'c1', kind: 'dissolve', duration: 0.5 },
      actor(),
    )
    expect(out.ok).toBe(true)
    const clip = comp()
      .tracks.find((t) => t.id === 'ct')
      ?.clips?.find((c) => c.id === 'c1')
    expect(clip?.transition?.kind).toBe('dissolve')
    const bad = pro.applyTransition(canvas, pageId, { track_id: 'ct', clip_id: 'c1', kind: 'spin' }, actor())
    expect(bad.ok).toBe(false)
  })

  it('set_motion_blur writes and clears the shutter', () => {
    expect(pro.setMotionBlur(canvas, pageId, { shutter: 180, samples: 8 }, actor()).ok).toBe(true)
    expect(comp().motionBlur?.shutter).toBe(180)
    expect(pro.setMotionBlur(canvas, pageId, null, actor()).ok).toBe(true)
    expect(comp().motionBlur).toBeUndefined()
  })
})

describe('apply_text_animation', () => {
  it('writes the animator through the design path — a frame version is filed', async () => {
    const before = store.getFrame(frameId)!.html
    const out = await pro.applyTextAnimation(
      canvas,
      pageId,
      { frame_id: frameId, element_id: 'hero', preset: 'rise-blur' },
      actor(),
    )
    expect(out.ok).toBe(true)
    const html = store.getFrame(frameId)!.html
    expect(html).not.toBe(before)
    expect(html).toContain('data-doop-motion')
    expect(html).toContain('data-doop-split="word"')
    /* the ordinary design write files the prior html as a version — the old
       annotation path never did */
    expect(mocks.saveFrameVersion).toHaveBeenCalled()
  })

  it('keeps $ sequences in the markup byte-identical', async () => {
    const out = await pro.applyTextAnimation(
      canvas,
      pageId,
      { frame_id: frameId, element_id: 'hero', preset: 'scale-pop' },
      actor(),
    )
    expect(out.ok).toBe(true)
    /* `$&` and `$$` in the replacement string would expand to the matched
       text — function replacers keep them literal */
    const count = (store.getFrame(frameId)!.html.match(/\$&|\$\$/g) ?? []).length
    expect(count).toBe(2)
  })

  it('refuses a frame mid-stream', async () => {
    const stream = actions.appendFrameHtml(frameId, '<p>draft', actor(), { start: true })
    expect(stream).toBeTruthy()
    expect(actions.isFrameStreaming(frameId)).toBe(true)
    const out = await pro.applyTextAnimation(
      canvas,
      pageId,
      { frame_id: frameId, element_id: 'hero', preset: 'rise-blur' },
      actor(),
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/mid-stream/)
  })

  it('validates the animator spec the runtime parser would reject', async () => {
    for (const input of [{ start: -1 }, { duration: 0 }, { stagger: -0.5 }, { order: 'spiral' }, { seed: 1.5 }]) {
      const out = await pro.applyTextAnimation(
        canvas,
        pageId,
        { frame_id: frameId, element_id: 'hero', preset: 'rise-blur', ...input },
        actor(),
      )
      expect(out.ok, JSON.stringify(input)).toBe(false)
    }
    expect(store.getFrame(frameId)!.html).not.toContain('data-doop-motion')
  })
})

describe('check_scene and critique_scene', () => {
  it('check_scene reports lint, pacing and the effect bill headlessly', async () => {
    const out = await snapshot.checkScene(canvas, pageId, { pixels: false })
    expect(out.ok).toBe(true)
    const data = (
      out as {
        ok: true
        data: {
          lint: unknown
          pacing: { shots: number }
          effects: { cost_cap: number }
          safe_zones: { available: boolean }
        }
      }
    ).data
    expect(data.lint).toBeTruthy()
    expect(data.pacing.shots).toBeGreaterThanOrEqual(0)
    expect(data.effects.cost_cap).toBeGreaterThan(0)
    expect(data.safe_zones.available).toBe(false)
  })

  it('check_scene flags what the renderer cannot draw', async () => {
    /* legacy stacks the ops now refuse but old compositions may carry —
       a whole-film body keeps them, the ops refuse new ones, check flags them */
    actions.setComposition(
      canvas.id,
      baseComp([
        { id: 'el', kind: 'element', frameId, elementId: 'hero', effects: [{ id: 'e1', fx: 'vignette', params: {} }] },
        { id: 'cam', kind: 'camera', keyframes: [], blend: 'multiply' },
      ]),
      pageId,
      actor(),
    )
    /* an effect id the registry no longer ships — only injectable directly
       on the stored comp, the body parser rejects it */
    comp().tracks.find((t) => t.id === 'cam')!.effects = [{ id: 'm', fx: 'mystery-fx', params: {} }]
    const out = await snapshot.checkScene(canvas, pageId, { pixels: false })
    const data = (out as { ok: true; data: { effects: { not_drawn: { what: string }[]; unsupported: string[] } } }).data
    expect(data.effects.not_drawn.some((d) => d.what === 'vignette')).toBe(true)
    expect(data.effects.not_drawn.some((d) => d.what === 'blend:multiply')).toBe(true)
    expect(data.effects.unsupported).toContain('mystery-fx')
  })

  it('critique passes count new revisions and the budget resets on set_direction', async () => {
    const critic = () => snapshot.critiqueScene(canvas, pageId, { pixels: false })
    const first = (await critic()) as { ok: true; data: { pass: number; exhausted: boolean } }
    expect(first.data.pass).toBe(1)
    /* same revision: free re-read */
    const again = (await critic()) as { ok: true; data: { pass: number } }
    expect(again.data.pass).toBe(1)
    /* burn the remaining default budget (3 passes) */
    await actions.setComposition(canvas.id, baseComp(), pageId, actor())
    const second = (await critic()) as { ok: true; data: { pass: number } }
    expect(second.data.pass).toBe(2)
    await actions.setComposition(canvas.id, baseComp(), pageId, actor())
    const third = (await critic()) as { ok: true; data: { pass: number; exhausted: boolean } }
    expect(third.data.pass).toBe(3)
    expect(third.data.exhausted).toBe(true)
    /* a new direction is a new run: the budget restarts */
    pro.setDirection(canvas, pageId, { treatment: 'A second take.' }, actor())
    const fresh = (await critic()) as { ok: true; data: { pass: number; exhausted: boolean } }
    expect(fresh.data.pass).toBe(1)
    expect(fresh.data.exhausted).toBe(false)
  })
})

describe('effect stack tools', () => {
  const camTrack = () =>
    actions.setComposition(
      canvas.id,
      baseComp([
        { id: 'cam', kind: 'camera', keyframes: [] },
        { id: 'el', kind: 'element', frameId, elementId: 'hero' },
      ]),
      pageId,
      actor(),
    )

  it('add_effect draws only on camera/adjustment tracks — element tracks refuse', () => {
    camTrack()
    const okd = pro.addEffect(canvas, pageId, { track_id: 'cam', fx: 'vignette' }, actor())
    expect(okd.ok).toBe(true)
    expect(comp().tracks.find((t) => t.id === 'cam')?.effects?.[0]?.fx).toBe('vignette')
    const bad = pro.addEffect(canvas, pageId, { track_id: 'el', fx: 'vignette' }, actor())
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/never render|not drawn|camera and adjustment/)
  })

  it('update_effect refuses a per-effect blend it would silently drop', () => {
    camTrack()
    pro.addEffect(canvas, pageId, { track_id: 'cam', fx: 'vignette', id: 'fx1' }, actor())
    const bad = pro.updateEffect(canvas, pageId, { track_id: 'cam', effect_id: 'fx1', blend: 'multiply' }, actor())
    expect(bad.ok).toBe(false)
    /* mix is drawn — it stays writable */
    const okd = pro.updateEffect(canvas, pageId, { track_id: 'cam', effect_id: 'fx1', mix: 0.5 }, actor())
    expect(okd.ok).toBe(true)
  })

  it('set_effects rewrites the stack and remove_effect deletes', () => {
    camTrack()
    const set = pro.setEffects(
      canvas,
      pageId,
      {
        track_id: 'cam',
        effects: [
          { id: 'a', fx: 'invert', params: {} },
          { id: 'b', fx: 'pixelate', params: { size: 8 } },
        ],
      },
      actor(),
    )
    expect(set.ok).toBe(true)
    expect(
      comp()
        .tracks.find((t) => t.id === 'cam')
        ?.effects?.map((e) => e.id),
    ).toEqual(['a', 'b'])
    const rm = pro.removeEffect(canvas, pageId, { track_id: 'cam', effect_id: 'a' }, actor())
    expect(rm.ok).toBe(true)
    expect(
      comp()
        .tracks.find((t) => t.id === 'cam')
        ?.effects?.map((e) => e.id),
    ).toEqual(['b'])
  })

  it('apply_look lands an adjustment track; list_looks names the registry', () => {
    const looks = pro.listLooks()
    const ids = (looks as { ok: true; data: { looks: { id: string }[] } }).data.looks.map((l) => l.id)
    expect(ids).toEqual(MOTION_LOOKS.map((l) => l.id))
    const out = pro.applyLook(canvas, pageId, { look: ids[0]! }, actor())
    expect(out.ok).toBe(true)
    expect(comp().tracks.some((t) => t.kind === 'adjustment' && (t.effects?.length ?? 0) > 0)).toBe(true)
  })

  it('the ops themselves refuse undrawable stacks', () => {
    camTrack()
    const res = actions.patchComposition(
      canvas.id,
      pageId,
      [{ op: 'add_effect', trackId: 'el', effect: { id: 'x', fx: 'invert', params: {} } }],
      actor(),
    )
    expect(res.ok).toBe(false)
    const blend = actions.patchComposition(
      canvas.id,
      pageId,
      [{ op: 'set_blend', trackId: 'cam', blend: 'multiply' }],
      actor(),
    )
    expect(blend.ok).toBe(false)
  })
})

describe('server render cost cap (AC-17)', () => {
  it('refuses a server job whose effect bill is over the cap', () => {
    /* 10 × gaussian-blur (cost 4) = 40 > 36 */
    actions.setComposition(
      canvas.id,
      baseComp([
        {
          id: 'cam',
          kind: 'camera',
          keyframes: [],
          effects: Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, fx: 'gaussian-blur', params: {} })),
        },
      ]),
      pageId,
      actor(),
    )
    const created = createRenderJob({
      composition: comp(),
      format: 'webm',
      target: 'server',
      width: 1920,
      height: 1080,
      fps: 30,
      range: { start: 0, end: 4 },
      by: { id: 'u', name: 'test' },
    })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.error).toMatch(/cap|cost/i)
  })

  it('the same film renders fine on a browser target', () => {
    actions.setComposition(
      canvas.id,
      baseComp([
        {
          id: 'cam',
          kind: 'camera',
          keyframes: [],
          effects: Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, fx: 'gaussian-blur', params: {} })),
        },
      ]),
      pageId,
      actor(),
    )
    const created = createRenderJob({
      composition: comp(),
      format: 'mp4',
      target: 'browser',
      width: 1920,
      height: 1080,
      fps: 30,
      range: { start: 0, end: 4 },
      by: { id: 'u', name: 'test' },
    })
    expect(created.ok).toBe(true)
  })
})

describe('scene text checks — visibility, rotation and contrast', () => {
  const box = (over: Record<string, unknown> = {}) => ({
    frameId,
    elementId: 'hero',
    x: 100,
    y: 100,
    w: 200,
    h: 40,
    fontSize: 20,
    fontWeight: '400',
    color: 'rgb(0, 0, 0)',
    background: 'rgb(255, 255, 255)',
    text: 'hi',
    ...over,
  })

  const frameGeo = () => new Map([[frameId, { x: 0, y: 0, width: 800, height: 600 }]])

  const compWithCam = (kf: { property: string; t: number; value: number }[]) =>
    ({
      ...comp(),
      tracks: [{ id: 'cam', kind: 'camera', keyframes: kf.map((k, i) => ({ id: `k${i}`, ...k })) }],
    }) as ReturnType<typeof comp>

  it('off-screen text is another shot’s content — no violation, no legibility row', () => {
    /* camera parked far right of the page: the text is wholly off-raster */
    const c = compWithCam([
      { property: 'x', t: 0, value: 50000 },
      { property: 'y', t: 0, value: 50000 },
      { property: 'zoom', t: 0, value: 1 },
    ])
    const out = snapshot.measureChecks(c, [{ t: 0, duration: 2 }], [box()], frameGeo())
    expect(out.violations).toHaveLength(0)
    expect(out.legItems).toHaveLength(0)
  })

  it('text in view at the shot midpoint is checked and contrasted', () => {
    /* camera centred on the frame's middle */
    const c = compWithCam([
      { property: 'x', t: 0, value: 400 },
      { property: 'y', t: 0, value: 300 },
      { property: 'zoom', t: 0, value: 1 },
    ])
    const out = snapshot.measureChecks(c, [{ t: 0, duration: 2 }], [box()], frameGeo())
    expect(out.legItems).toHaveLength(1)
    expect(out.legItems[0]!.contrast).toBeCloseTo(21, 0) /* black on white */
    expect(out.legItems[0]!.low_contrast).toBe(false)
  })

  it('low contrast is flagged against the measured backdrop', () => {
    const c = compWithCam([
      { property: 'x', t: 0, value: 400 },
      { property: 'y', t: 0, value: 300 },
      { property: 'zoom', t: 0, value: 1 },
    ])
    const out = snapshot.measureChecks(
      c,
      [{ t: 0, duration: 2 }],
      [box({ color: 'rgb(250, 250, 250)', background: 'rgb(255, 255, 255)' })],
      frameGeo(),
    )
    expect(out.legItems[0]!.low_contrast).toBe(true)
    expect(out.legItems[0]!.contrast_min).toBe(4.5)
  })

  it('camera rotation moves the projected box', () => {
    /* a frame far left of the camera: flat, the box grazes the title-safe
       left edge; a 90° camera swings it off the bottom edge instead */
    const geo = new Map([[frameId, { x: -1200, y: 0, width: 800, height: 600 }]])
    const sideBox = { ...box(), x: 730, y: 280, w: 200, h: 40 }
    const base = compWithCam([
      { property: 'x', t: 0, value: 400 },
      { property: 'y', t: 0, value: 300 },
      { property: 'zoom', t: 0, value: 1 },
    ])
    const rotated = compWithCam([
      { property: 'x', t: 0, value: 400 },
      { property: 'y', t: 0, value: 300 },
      { property: 'zoom', t: 0, value: 1 },
      { property: 'rotation', t: 0, value: 90 },
    ])
    const flat = snapshot.measureChecks(base, [{ t: 0, duration: 2 }], [sideBox], geo)
    const spun = snapshot.measureChecks(rotated, [{ t: 0, duration: 2 }], [sideBox], geo)
    /* flat, the box grazes the title-safe edge → a violation; rotated 90°,
       the same box leaves the raster entirely → nothing to flag, and the
       visibility filter keeps it out of legibility too */
    expect(flat.violations).toHaveLength(1)
    expect(spun.violations).toHaveLength(0)
    expect(spun.legItems).toHaveLength(0)
  })

  it('contrastRatio grades alpha-composited text on its backdrop', () => {
    expect(snapshot.contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(snapshot.contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 0)
    expect(snapshot.contrastRatio('rgba(0,0,0,0.5)', 'rgb(255,255,255)')).toBeGreaterThan(3)
    expect(snapshot.contrastRatio('nonsense', '#fff')).toBeUndefined()
  })
})

describe('the deterministic hash (no GPU sin())', () => {
  it('the shader sources carry no fract(sin()) hash', () => {
    const src = readFileSync(new URL('../src/lib/motion/gl.ts', import.meta.url), 'utf8')
    expect(src).not.toContain('fract(sin(')
    expect(src).toContain('doopHash')
    expect(src).toContain('u_fps')
  })
})
