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
const { effectCost } = await import('../shared/motionFx.ts')
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
    expect(data.camera_presets).toHaveLength(CAMERA_PRESETS.length)
    expect(data.transitions.length).toBeGreaterThan(0)
    expect(data.text_animators).toContain('rise-blur')
  })

  it('apply_camera_preset writes editable camera keyframes — every one of the 13', () => {
    /* the registry row count is the contract: a renamed or dropped preset
       fails here, and each must still apply through the same write path */
    for (const [i, preset] of CAMERA_PRESETS.entries()) {
      const out = pro.applyCameraPreset(canvas, pageId, { preset, t: i * 0.4, duration: 1 }, actor())
      expect(out.ok, `preset ${preset}`).toBe(true)
      const wrote = (out as { ok: true; data: { keyframes: number } }).data.keyframes
      expect(wrote, `preset ${preset} wrote no keyframes`).toBeGreaterThan(0)
    }
    const camera = comp().tracks.find((t) => t.kind === 'camera')
    expect(camera?.keyframes?.length).toBeGreaterThanOrEqual(CAMERA_PRESETS.length)
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
       them, check flags them */
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

  it('check_scene runs a candidate stack read-only — diagnostics, cost, no write', async () => {
    actions.setComposition(
      canvas.id,
      baseComp([{ id: 'cam', kind: 'camera', keyframes: [], effects: [{ id: 's', fx: 'vignette', params: {} }] }]),
      pageId,
      actor(),
    )
    const revision = comp().revision
    const out = await snapshot.checkScene(canvas, pageId, {
      pixels: false,
      candidate_stack: {
        track_id: 'cam',
        effects: [
          { id: 'a', fx: 'invert', params: {} },
          { id: 'b', fx: 'pixelate', params: { size: 8 } },
        ],
      },
    })
    expect(out.ok).toBe(true)
    const data = (
      out as {
        ok: true
        data: {
          effects: { total_cost: number }
          candidate: { ok: boolean; cost: number; projected_total_cost: number; diagnostics: unknown[] }
        }
      }
    ).data
    /* the stored stack (vignette = 1) stays the report's bill; the
       candidate's own cost and the projection land in its section */
    expect(data.effects.total_cost).toBe(1)
    expect(data.candidate.ok).toBe(true)
    expect(data.candidate.cost).toBe(2)
    expect(data.candidate.projected_total_cost).toBe(2)
    expect(data.candidate.diagnostics).toEqual([])
    /* read-only: no write, no revision bump */
    expect(comp().revision).toBe(revision)
    expect(
      comp()
        .tracks.find((t) => t.id === 'cam')
        ?.effects?.map((e) => e.id),
    ).toEqual(['s'])
  })

  it('an ordinary check_scene without candidate_stack reports no candidate section', async () => {
    const out = await snapshot.checkScene(canvas, pageId, { pixels: false })
    expect(out.ok).toBe(true)
    expect('candidate' in (out as { data: object }).data).toBe(false)
  })

  it('candidate_stack names its errors: missing track, over-limit stack, wrong track kind', async () => {
    actions.setComposition(
      canvas.id,
      baseComp([
        { id: 'cam', kind: 'camera', keyframes: [] },
        { id: 'el', kind: 'element', frameId, elementId: 'hero' },
      ]),
      pageId,
      actor(),
    )
    const missing = await snapshot.checkScene(canvas, pageId, {
      pixels: false,
      candidate_stack: { track_id: 'ghost', effects: [] },
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toMatch(/no track ghost/)
    const overLimit = await snapshot.checkScene(canvas, pageId, {
      pixels: false,
      candidate_stack: {
        track_id: 'cam',
        effects: Array.from({ length: 21 }, (_, i) => ({ id: `e${i}`, fx: 'invert', params: {} })),
      },
    })
    expect(overLimit.ok).toBe(false)
    if (!overLimit.ok) expect(overLimit.error).toMatch(/at most 20/)
    const wrongKind = await snapshot.checkScene(canvas, pageId, {
      pixels: false,
      candidate_stack: { track_id: 'el', effects: [{ id: 'e', fx: 'invert', params: {} }] },
    })
    expect(wrongKind.ok).toBe(false)
    if (!wrongKind.ok) expect(wrongKind.error).toMatch(/camera and adjustment/)
  })

  it('candidate diagnostics flag unknown_fx as MO-13 and invalid_param as MO-14', async () => {
    actions.setComposition(canvas.id, baseComp([{ id: 'cam', kind: 'camera', keyframes: [] }]), pageId, actor())
    const out = await snapshot.checkScene(canvas, pageId, {
      pixels: false,
      candidate_stack: {
        track_id: 'cam',
        effects: [
          { id: 'a', fx: 'gaussin-blur', params: {} },
          { id: 'b', fx: 'gaussian-blur', params: { radius: 999, angle: 1 } },
        ],
      },
    })
    expect(out.ok).toBe(true)
    const candidate = (
      out as {
        ok: true
        data: {
          candidate: {
            ok: boolean
            diagnostics: { rule: string; kind: string; severity: string; instance: string; parameter?: string }[]
          }
        }
      }
    ).data.candidate
    expect(candidate.ok).toBe(false)
    const unknown = candidate.diagnostics.find((d) => d.kind === 'unknown_fx')
    expect(unknown?.rule).toBe('MO-13')
    expect(unknown?.severity).toBe('error')
    expect(unknown?.instance).toBe('a')
    /* the bad radius is named; angle (a param gaussian-blur does not carry)
       reports as its own invalid_param */
    const invalid = candidate.diagnostics.filter((d) => d.kind === 'invalid_param')
    expect(invalid.map((d) => d.parameter).sort()).toEqual(['angle', 'radius'])
    expect(invalid.every((d) => d.rule === 'MO-14' && d.severity === 'error' && d.instance === 'b')).toBe(true)
  })

  it('the exact param boundary passes the candidate check', async () => {
    actions.setComposition(canvas.id, baseComp([{ id: 'cam', kind: 'camera', keyframes: [] }]), pageId, actor())
    const out = await snapshot.checkScene(canvas, pageId, {
      pixels: false,
      candidate_stack: {
        track_id: 'cam',
        effects: [{ id: 'a', fx: 'gaussian-blur', params: { radius: 200 } }],
      },
    })
    expect(out.ok).toBe(true)
    const candidate = (out as { ok: true; data: { candidate: { ok: boolean; diagnostics: unknown[] } } }).data.candidate
    expect(candidate.ok).toBe(true)
    expect(candidate.diagnostics).toEqual([])
  })

  it('a candidate over the cost cap projects over_budget without touching the stored report', async () => {
    actions.setComposition(canvas.id, baseComp([{ id: 'cam', kind: 'camera', keyframes: [] }]), pageId, actor())
    const out = await snapshot.checkScene(canvas, pageId, {
      pixels: false,
      candidate_stack: {
        track_id: 'cam',
        effects: Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, fx: 'gaussian-blur', params: {} })),
      },
    })
    expect(out.ok).toBe(true)
    const data = (
      out as {
        ok: true
        data: {
          effects: { total_cost: number; over_budget: boolean }
          candidate: { cost: number; projected_over_budget: boolean }
        }
      }
    ).data
    /* 10 × gaussian-blur (4) = 40 > 36 — the projection trips while the
       stored film stays under */
    expect(data.candidate.cost).toBe(40)
    expect(data.candidate.projected_over_budget).toBe(true)
    expect(data.effects.total_cost).toBe(0)
    expect(data.effects.over_budget).toBe(false)
  })

  it('bills a reused disabled instance without `enabled` exactly like the write — cost and budget decision', async () => {
    /* set_effects merges: a reused id that omits `enabled` keeps its stored
       flag. The candidate must bill it the same way or the rehearsal lies —
       here the stack sits at 33 of 36, so misreading parked `a` (4) flips
       over_budget and the two paths would disagree */
    const enabledStack = [
      { id: 'e1', fx: 'bloom', params: {} },
      { id: 'e2', fx: 'lens-blur', params: {} },
      { id: 'e3', fx: 'god-rays', params: {} },
      { id: 'e4', fx: 'glow', params: {} },
      { id: 'e5', fx: 'radial-blur', params: {} },
      { id: 'e6', fx: 'directional-blur', params: {} },
      { id: 'e7', fx: 'whip-blur', params: {} },
      { id: 'e8', fx: 'lens-flare', params: {} },
      { id: 'e9', fx: 'light-leak', params: {} },
    ]
    const bareResubmit = { id: 'a', fx: 'gaussian-blur', params: { radius: 20 } }
    actions.setComposition(
      canvas.id,
      baseComp([
        {
          id: 'cam',
          kind: 'camera',
          keyframes: [],
          effects: [...enabledStack, { id: 'a', fx: 'gaussian-blur', params: { radius: 8 }, enabled: false }],
        },
      ]),
      pageId,
      actor(),
    )
    const track = () => comp().tracks.find((t) => t.id === 'cam')!
    expect(effectCost(track())).toBe(33)

    /* the simulation — `a` arrives bare, its parked flag must carry */
    const sim = (await snapshot.checkScene(canvas, pageId, {
      pixels: false,
      candidate_stack: { track_id: 'cam', effects: [...enabledStack, bareResubmit] },
    })) as {
      ok: true
      data: { candidate: { cost: number; projected_total_cost: number; projected_over_budget: boolean } }
    }
    expect(sim.data.candidate.cost).toBe(33)
    expect(sim.data.candidate.projected_total_cost).toBe(33)
    expect(sim.data.candidate.projected_over_budget).toBe(false)

    /* the write itself — same list, same bill, same decision */
    const write = pro.setEffects(canvas, pageId, { track_id: 'cam', effects: [...enabledStack, bareResubmit] }, actor())
    expect(write.ok).toBe(true)
    expect(track().effects?.find((e) => e.id === 'a')?.enabled).toBe(false)
    expect(effectCost(track())).toBe(33)
    const written = (await snapshot.checkScene(canvas, pageId, { pixels: false })) as {
      ok: true
      data: { effects: { total_cost: number; over_budget: boolean } }
    }
    expect(written.data.effects.total_cost).toBe(33)
    expect(written.data.effects.over_budget).toBe(false)

    /* and the explicit branch: `enabled: true` flips both paths together */
    const explicit = { ...bareResubmit, enabled: true }
    const sim2 = (await snapshot.checkScene(canvas, pageId, {
      pixels: false,
      candidate_stack: { track_id: 'cam', effects: [...enabledStack, explicit] },
    })) as { ok: true; data: { candidate: { cost: number; projected_over_budget: boolean } } }
    expect(sim2.data.candidate.cost).toBe(37)
    expect(sim2.data.candidate.projected_over_budget).toBe(true)
    const write2 = pro.setEffects(canvas, pageId, { track_id: 'cam', effects: [...enabledStack, explicit] }, actor())
    expect(write2.ok).toBe(true)
    expect(track().effects?.find((e) => e.id === 'a')?.enabled).toBe(true)
    expect(effectCost(track())).toBe(37)
    const written2 = (await snapshot.checkScene(canvas, pageId, { pixels: false })) as {
      ok: true
      data: { effects: { over_budget: boolean } }
    }
    expect(written2.data.effects.over_budget).toBe(true)
  })

  it('refuses a reused id carrying a different fx in simulation and write alike', async () => {
    /* an instance's fx is its identity — update_effect carries no fx field,
       so the write can only keep the stored one. Submitting a different fx
       on a stored id must refuse identically on both paths, whether or not
       `enabled` is given — otherwise the simulation rehearses a stack the
       write silently re-types */
    actions.setComposition(
      canvas.id,
      baseComp([
        {
          id: 'cam',
          kind: 'camera',
          keyframes: [],
          effects: [
            { id: 'a', fx: 'gaussian-blur', params: { radius: 8 }, enabled: false },
            { id: 'v', fx: 'vignette', params: {} },
          ],
        },
      ]),
      pageId,
      actor(),
    )
    const track = () => comp().tracks.find((t) => t.id === 'cam')!

    /* two effects of different costs: gaussian-blur bills 4, bloom 5 —
       a silent swap would also move the bill */
    for (const enabled of [undefined, true]) {
      const submitted = {
        id: 'a',
        fx: 'bloom',
        params: {},
        ...(enabled !== undefined ? { enabled } : {}),
      }
      const sim = (await snapshot.checkScene(canvas, pageId, {
        pixels: false,
        candidate_stack: { track_id: 'cam', effects: [submitted, { id: 'v', fx: 'vignette', params: {} }] },
      })) as {
        ok: true
        data: {
          candidate: { ok: boolean; diagnostics: { rule: string; kind: string; severity: string; instance: string }[] }
        }
      }
      const mismatch = sim.data.candidate.diagnostics.find((d) => d.kind === 'fx_mismatch')
      expect(mismatch, `candidate (enabled ${enabled})`).toMatchObject({
        rule: 'MO-13',
        severity: 'error',
        instance: 'a',
      })
      expect(sim.data.candidate.ok).toBe(false)

      const write = pro.setEffects(
        canvas,
        pageId,
        { track_id: 'cam', effects: [submitted, { id: 'v', fx: 'vignette', params: {} }] },
        actor(),
      )
      expect(write.ok, `write (enabled ${enabled})`).toBe(false)
      expect((write as { ok: false; error: string }).error).toContain('keeps its fx')
      /* nothing moved: the stored instance keeps its fx, its flag, its bill */
      expect(track().effects?.find((e) => e.id === 'a')).toMatchObject({
        fx: 'gaussian-blur',
        enabled: false,
        params: { radius: 8 },
      })
      expect(effectCost(track())).toBe(1)
    }

    /* the documented escape: remove the id, then the new fx lands as a
       fresh instance */
    const swapped = pro.setEffects(
      canvas,
      pageId,
      {
        track_id: 'cam',
        effects: [
          { id: 'b', fx: 'bloom', params: {} },
          { id: 'v', fx: 'vignette', params: {} },
        ],
      },
      actor(),
    )
    expect(swapped.ok).toBe(true)
    expect(track().effects?.map((e) => `${e.id}:${e.fx}`)).toEqual(['b:bloom', 'v:vignette'])
    expect(effectCost(track())).toBe(6)
  })

  it('stored MO-13/MO-14 issues carry their kinds, distinct from the candidate kinds', async () => {
    actions.setComposition(
      canvas.id,
      baseComp([
        {
          id: 'cam',
          kind: 'camera',
          keyframes: [{ id: 'k1', t: 0, property: 'fx:ghost.amount', value: 1, easing: { type: 'linear' } }],
        },
      ]),
      pageId,
      actor(),
    )
    comp().tracks.find((t) => t.id === 'cam')!.effects = [{ id: 'm', fx: 'mystery-fx', params: {} }]
    const out = await snapshot.checkScene(canvas, pageId, { pixels: false })
    const issues = (out as { ok: true; data: { lint: { issues: { rule: string; kind?: string }[] } } }).data.lint.issues
    expect(issues.find((i) => i.rule === 'MO-13')?.kind).toBe('dangling_lane')
    expect(issues.find((i) => i.rule === 'MO-14')?.kind).toBe('undrawn_effect')
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
    /* the hard cap: a direction may ask for 5 passes and the fifth ends it */
    pro.setDirection(canvas, pageId, { treatment: 'Final pass.', passes: 5 }, actor())
    const opening = (await critic()) as { ok: true; data: { pass: number } }
    expect(opening.data.pass).toBe(1)
    for (let i = 2; i <= 5; i++) {
      await actions.setComposition(canvas.id, baseComp(), pageId, actor())
      const r = (await critic()) as { ok: true; data: { pass: number; exhausted: boolean; stop: boolean } }
      expect(r.data.pass).toBe(i)
      if (i === 5) {
        expect(r.data.exhausted).toBe(true)
        expect(r.data.stop).toBe(true)
      }
    }
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
