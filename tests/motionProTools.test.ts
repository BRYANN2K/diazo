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
    /* legacy stacks the ops and the body parser now refuse but old
       compositions may carry — the store keeps them, new writes refuse
       them, check flags them. Effects on element tracks draw now, so the
       undrawable stack sits on a caption lane. */
    actions.setComposition(
      canvas.id,
      baseComp([
        { id: 'cap', kind: 'caption' },
        { id: 'cam', kind: 'camera', keyframes: [] },
      ]),
      pageId,
      actor(),
    )
    /* legacy stacks the body parser refuses — only injectable directly on
       the stored comp */
    comp().tracks.find((t) => t.id === 'cap')!.effects = [{ id: 'e1', fx: 'vignette', params: {} }]
    comp().tracks.find((t) => t.id === 'cam')!.blend = 'multiply'
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

  it('add_effect draws on element/camera/adjustment tracks — element tracks accept', async () => {
    camTrack()
    const okd = await pro.addEffect(canvas, pageId, { track_id: 'cam', fx: 'vignette' }, actor())
    expect(okd.ok).toBe(true)
    expect(comp().tracks.find((t) => t.id === 'cam')?.effects?.[0]?.fx).toBe('vignette')
    const el = await pro.addEffect(canvas, pageId, { track_id: 'el', fx: 'vignette' }, actor())
    expect(el.ok).toBe(true)
    expect(comp().tracks.find((t) => t.id === 'el')?.effects?.[0]?.fx).toBe('vignette')
  })

  it('add_effect by frame_id + element_id creates the element track', async () => {
    camTrack()
    const out = await pro.addEffect(canvas, pageId, { frame_id: frameId, element_id: 'sub', fx: 'glow' }, actor())
    expect(out.ok).toBe(true)
    const track = comp().tracks.find((t) => t.kind === 'element' && t.elementId === 'sub')
    expect(track).toBeTruthy()
    expect(track?.effects?.[0]?.fx).toBe('glow')
    /* a second call rides the same track */
    const again = await pro.addEffect(canvas, pageId, { frame_id: frameId, element_id: 'sub', fx: 'invert' }, actor())
    expect(again.ok).toBe(true)
    expect(comp().tracks.filter((t) => t.kind === 'element' && t.elementId === 'sub')).toHaveLength(1)
    const bad = await pro.addEffect(canvas, pageId, { frame_id: frameId, element_id: 'missing', fx: 'glow' }, actor())
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/no element/)
  })

  it('update_effect refuses a per-effect blend it would silently drop', async () => {
    camTrack()
    await pro.addEffect(canvas, pageId, { track_id: 'cam', fx: 'vignette', id: 'fx1' }, actor())
    const bad = await pro.updateEffect(
      canvas,
      pageId,
      { track_id: 'cam', effect_id: 'fx1', blend: 'multiply' },
      actor(),
    )
    expect(bad.ok).toBe(false)
    /* mix is drawn — it stays writable */
    const okd = await pro.updateEffect(canvas, pageId, { track_id: 'cam', effect_id: 'fx1', mix: 0.5 }, actor())
    expect(okd.ok).toBe(true)
  })

  it('set_effects rewrites the stack and remove_effect deletes', async () => {
    camTrack()
    const set = await pro.setEffects(
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
    const rm = await pro.removeEffect(canvas, pageId, { track_id: 'cam', effect_id: 'a' }, actor())
    expect(rm.ok).toBe(true)
    expect(
      comp()
        .tracks.find((t) => t.id === 'cam')
        ?.effects?.map((e) => e.id),
    ).toEqual(['b'])
  })

  it('set_effects on an untracked element makes its track', async () => {
    camTrack()
    const set = await pro.setEffects(
      canvas,
      pageId,
      {
        frame_id: frameId,
        element_id: 'sub',
        effects: [{ id: 'a', fx: 'glow', params: {} }],
      },
      actor(),
    )
    expect(set.ok).toBe(true)
    const track = comp().tracks.find((t) => t.kind === 'element' && t.elementId === 'sub')
    expect(track?.effects?.map((e) => e.id)).toEqual(['a'])
    /* and by id it rides the track it already has */
    const again = await pro.setEffects(
      canvas,
      pageId,
      { frame_id: frameId, element_id: 'hero', effects: [{ id: 'b', fx: 'invert', params: {} }] },
      actor(),
    )
    expect(again.ok).toBe(true)
    expect(
      comp()
        .tracks.find((t) => t.id === 'el')
        ?.effects?.map((e) => e.id),
    ).toEqual(['b'])
  })

  it('set_layer writes the layer contract on an element', async () => {
    camTrack()
    const out = await pro.setLayer(
      canvas,
      pageId,
      { frame_id: frameId, element_id: 'hero', layer: { mode: 'on', pad: 24 }, blend: 'screen' },
      actor(),
    )
    expect(out.ok).toBe(true)
    const track = comp().tracks.find((t) => t.kind === 'element' && t.elementId === 'hero')
    expect(track?.layer?.mode).toBe('on')
    expect(track?.blend).toBe('screen')
    const bad = await pro.setLayer(canvas, pageId, { track_id: 'cam', layer: { mode: 'on' } }, actor())
    expect(bad.ok).toBe(false)
  })

  it('get_layer_plan reports the promoted element', async () => {
    camTrack()
    await pro.addEffect(canvas, pageId, { track_id: 'el', fx: 'glow' }, actor())
    const out = await pro.getLayerPlan(canvas, pageId, { frame_id: frameId })
    expect(out.ok).toBe(true)
    const data = (
      out as { ok: true; data: { frames: { frameId: string; layers: { elementId: string; geometry: string }[] }[] } }
    ).data
    const plan = data.frames.find((f) => f.frameId === frameId)
    expect(plan?.layers.map((l) => l.elementId)).toContain('hero')
    expect(plan?.layers[0]?.geometry).toBe('unavailable')
  })

  it('apply_look lands an adjustment track; list_looks names the registry', () => {
    const looks = pro.listLooks()
    const ids = (looks as { ok: true; data: { looks: { id: string }[] } }).data.looks.map((l) => l.id)
    expect(ids).toEqual(MOTION_LOOKS.map((l) => l.id))
    const out = pro.applyLook(canvas, pageId, { look: ids[0]! }, actor())
    expect(out.ok).toBe(true)
    expect(comp().tracks.some((t) => t.kind === 'adjustment' && (t.effects?.length ?? 0) > 0)).toBe(true)
  })

  it('list_motion_effects marks the self-mapped effects', () => {
    /* luma matte and displacement map read u_tex2, which is the layer's own
       picture until instances bind another element's texture — the catalog
       says so, or an agent plans a matte from a layer it cannot have */
    const out = pro.listMotionEffects()
    const effects = (
      out as { ok: true; data: { effects: { id: string; needs_input?: boolean; self_mapped?: boolean }[] } }
    ).data.effects
    for (const id of ['luma-matte', 'displacement-map']) {
      const fx = effects.find((e) => e.id === id)
      expect(fx?.needs_input).toBe(true)
      expect(fx?.self_mapped).toBe(true)
    }
    expect(effects.every((e) => e.needs_input === undefined || e.self_mapped === true)).toBe(true)
  })

  it('the ops themselves refuse undrawable stacks', () => {
    camTrack()
    /* a clip track can never draw an effect — the op refuses it */
    actions.setComposition(canvas.id, baseComp([{ id: 'ct', kind: 'clip', name: 'Clips', clips: [] }]), pageId, actor())
    const res = actions.patchComposition(
      canvas.id,
      pageId,
      [{ op: 'add_effect', trackId: 'ct', effect: { id: 'x', fx: 'invert', params: {} } }],
      actor(),
    )
    expect(res.ok).toBe(false)
    const blend = actions.patchComposition(
      canvas.id,
      pageId,
      [{ op: 'set_blend', trackId: 'ct', blend: 'multiply' }],
      actor(),
    )
    expect(blend.ok).toBe(false)
  })

  it('set_layer takes the documented flat fields and rejects conflicting duplicates', async () => {
    camTrack()
    const flat = await pro.setLayer(
      canvas,
      pageId,
      { frame_id: frameId, element_id: 'hero', mode: 'on', pad: 24, motion_blur: true },
      actor(),
    )
    expect(flat.ok).toBe(true)
    const track = comp().tracks.find((t) => t.kind === 'element' && t.elementId === 'hero')
    expect(track?.layer).toMatchObject({ mode: 'on', pad: 24, motionBlur: true })
    /* flat and nested at once with different values is a conflict */
    const clash = await pro.setLayer(
      canvas,
      pageId,
      { track_id: track!.id, mode: 'off', layer: { mode: 'on' } },
      actor(),
    )
    expect(clash.ok).toBe(false)
    /* layer: null clears — a flat field beside it is ambiguous */
    const ambiguous = await pro.setLayer(canvas, pageId, { track_id: track!.id, layer: null, visible: false }, actor())
    expect(ambiguous.ok).toBe(false)
    /* and masks replace atomically via set_masks */
    const masked = await pro.setLayer(
      canvas,
      pageId,
      {
        track_id: track!.id,
        masks: [{ id: 'm1', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } }],
      },
      actor(),
    )
    expect(masked.ok).toBe(true)
    expect(track && comp().tracks.find((t) => t.id === track.id)?.masks?.[0]?.id).toBe('m1')
  })

  it('list_motion_effects reports alpha, grow and scopes', () => {
    const out = pro.listMotionEffects()
    const effects = (out as { ok: true; data: { effects: Record<string, unknown>[] } }).data.effects
    const blur = effects.find((e) => e.id === 'gaussian-blur')!
    expect(blur.grow).toBeGreaterThan(0)
    expect(blur.scopes).toBeTruthy()
    for (const e of effects) {
      expect(e).toHaveProperty('alpha')
      expect(e).toHaveProperty('grow')
      expect(e).toHaveProperty('scopes')
    }
  })

  it('a render job over the layer budget is refused at creation (AC-9)', () => {
    /* 25 glowing elements on one frame > MAX_LAYERS_PER_FRAME (24) */
    const tracks = Array.from({ length: 25 }, (_, i) => ({
      id: `el${i}`,
      kind: 'element' as const,
      frameId,
      elementId: `el${i}`,
      effects: [{ id: 'g', fx: 'glow', params: {} }],
    }))
    actions.setComposition(canvas.id, baseComp(tracks), pageId, actor())
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
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.error).toMatch(/layer|budget/i)
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

describe('apply_element_preset — atomic batches', () => {
  const SIX_HTML = `<!doctype html><html><body>${Array.from(
    { length: 6 },
    (_, i) => `<p data-doop-id="el${i}">line ${i}</p>`,
  ).join('')}</body></html>`

  const sixFrame = () =>
    actions.createFrame(canvas.id, { name: 'Six', width: 800, height: 600, html: SIX_HTML, x: 900, y: 0 }, actor(), {
      reveal: false,
    })!.id

  it('a staggered preset on six untracked elements lands six tracks, atomically', async () => {
    const fid = sixFrame()
    const out = await pro.applyElementPreset(
      canvas,
      pageId,
      {
        frame_id: fid,
        element_ids: ['el0', 'el1', 'el2', 'el3', 'el4', 'el5'],
        preset: 'rise',
        stagger: { each: 0.1, from: 'start' },
      },
      actor(),
    )
    expect(out.ok).toBe(true)
    const tracks = comp().tracks.filter((t) => t.kind === 'element' && t.frameId === fid)
    expect(tracks).toHaveLength(6)
    for (const t of tracks) {
      /* every track carries its keyframes — no empty shells from a
         half-applied batch */
      expect(t.keyframes?.length ?? 0).toBeGreaterThan(0)
    }
    const report = (out as { ok: true; data: { elements: { offset: number }[] } }).data
    expect(report.elements).toHaveLength(6)
    expect(Math.max(...report.elements.map((e) => e.offset))).toBeCloseTo(0.5)
  })

  it('a rejected batch leaves no tracks — empty or otherwise', async () => {
    const fid = sixFrame()
    /* one element does not exist: the whole batch refuses */
    const missing = await pro.applyElementPreset(
      canvas,
      pageId,
      { frame_id: fid, element_ids: ['el0', 'el1', 'nope'], preset: 'rise' },
      actor(),
    )
    expect(missing.ok).toBe(false)
    expect(comp().tracks.filter((t) => t.frameId === fid)).toHaveLength(0)
    /* a stagger that ends past the film refuses the same way */
    const late = await pro.applyElementPreset(
      canvas,
      pageId,
      {
        frame_id: fid,
        element_ids: ['el0', 'el1'],
        preset: 'rise',
        at: 5.5,
        stagger: { each: 0.4 },
      },
      actor(),
    )
    expect(late.ok).toBe(false)
    expect(comp().tracks.filter((t) => t.frameId === fid)).toHaveLength(0)
    /* and a nonsensical duration never reaches generation */
    const bad = await pro.applyElementPreset(
      canvas,
      pageId,
      { frame_id: fid, element_ids: ['el0'], preset: 'rise', duration: NaN },
      actor(),
    )
    expect(bad.ok).toBe(false)
    expect(comp().tracks.filter((t) => t.frameId === fid)).toHaveLength(0)
  })

  it('retries when a peer creates the element track mid-flight', async () => {
    const real = pro.presetDeps.patchComposition
    let raced = false
    pro.presetDeps.patchComposition = ((...args: Parameters<typeof real>) => {
      if (!raced) {
        raced = true
        /* the peer wins: it creates hero's element track first */
        real(
          args[0],
          args[1],
          [
            {
              op: 'add_track',
              track: {
                id: 'peer-t',
                kind: 'element',
                frameId: args[1] === pageId ? frameId : frameId,
                elementId: 'hero',
              },
            },
          ] as never,
          args[3],
        )
        return { ok: false, error: 'track already exists' } as ReturnType<typeof real>
      }
      return real(...args)
    }) as typeof real
    try {
      const out = await pro.applyElementPreset(
        canvas,
        pageId,
        { frame_id: frameId, element_ids: ['hero', 'sub'], preset: 'rise' },
        actor(),
      )
      expect(out.ok).toBe(true)
      const hero = comp().tracks.find((t) => t.elementId === 'hero')
      expect(hero?.id).toBe('peer-t')
      expect(hero?.keyframes?.length ?? 0).toBeGreaterThan(0)
      expect(comp().tracks.filter((t) => t.elementId === 'hero')).toHaveLength(1)
    } finally {
      pro.presetDeps.patchComposition = real
    }
  })
})

describe('render job validation — range, rule, bill', () => {
  const job = (over: Record<string, unknown> = {}) =>
    createRenderJob({
      composition: comp(),
      format: 'mp4',
      target: 'browser',
      width: 1920,
      height: 1080,
      fps: 30,
      range: { start: 0, end: 4 },
      by: { id: 'u', name: 'test' },
      ...over,
    } as never)

  it('refuses a broken range and clamps an end past the film', () => {
    actions.setComposition(canvas.id, baseComp(), pageId, actor())
    for (const range of [
      { start: -1, end: 4 },
      { start: 4, end: 4 },
      { start: 5, end: 2 },
      { start: 0, end: 601 },
      { start: NaN, end: 4 },
    ]) {
      const created = job({ range })
      expect(created.ok, JSON.stringify(range)).toBe(false)
      if (!created.ok) expect(created.error).toMatch(/range|duration/i)
    }
    expect(job({ range: { start: 0, end: 6 } }).ok).toBe(true)
    /* an end past the film seeks to the duration — it is not refused */
    const over = job({ range: { start: 0, end: 6.5 } })
    expect(over.ok).toBe(true)
    if (over.ok) expect(over.job.range.end).toBe(6)
  })

  it('keeps the MO-15 rule id on the refusal', () => {
    const tracks = Array.from({ length: 25 }, (_, i) => ({
      id: `el${i}`,
      kind: 'element' as const,
      frameId,
      elementId: `el${i}`,
      effects: [{ id: 'g', fx: 'glow', params: {} }],
    }))
    actions.setComposition(canvas.id, baseComp(tracks), pageId, actor())
    const created = job()
    expect(created.ok).toBe(false)
    if (!created.ok) {
      expect(created.error).toMatch(/layer|budget/i)
      expect((created as { rule?: string }).rule).toBe('MO-15')
    }
  })

  it('a muted layer’s stack does not sink the render bill', () => {
    /* 10 × gaussian-blur on the camera busts the cap alone (AC-17 covers
       that); the same stack on a muted element must not add to it */
    const stack = Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, fx: 'gaussian-blur', params: {} }))
    actions.setComposition(
      canvas.id,
      baseComp([
        { id: 'cam', kind: 'camera', keyframes: [] },
        { id: 'el1', kind: 'element', frameId, elementId: 'hero', muted: true, effects: stack },
        { id: 'el2', kind: 'element', frameId, elementId: 'sub', layer: { mode: 'off' }, effects: stack },
      ]),
      pageId,
      actor(),
    )
    const created = job({ format: 'webm', target: 'server' })
    expect(created.ok).toBe(true)
  })
})
