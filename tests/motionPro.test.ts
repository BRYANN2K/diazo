/**
 * Motion Studio pro: the Direction model, the effect-stack ops, the fx:
 * keyframe namespace, looks, the graph model and the direction-aware
 * storyboard — the contracts P0/P1 land on, tested at the pure-function
 * level (server transport surfaces dispatch into the same code).
 */
import { describe, expect, it } from 'vitest'
import {
  applyCompositionOps,
  buildStoryboard,
  CRITIQUE_PASS_DEFAULT,
  CRITIQUE_PASS_MAX,
  fxPropertyParts,
  isFxProperty,
  newComposition,
  parseCompositionBody,
  parseOps,
  type Composition,
  type CompositionBody,
  type CompositionOp,
  type Direction,
  type StoryboardFrame,
} from '../shared/motion.ts'
import {
  GL_EFFECT_IDS,
  MOTION_EFFECTS,
  effectCost,
  effectSeed,
  effectSpec,
  enabledEffects,
  normalizeParams,
} from '../shared/motionFx.ts'
import { lintComposition } from '../shared/motionLint.ts'
import { glslBodies } from '../src/lib/motion/gl.ts'
import { MOTION_LOOKS, lookEffects } from '../shared/motionLooks.ts'
import { curveEasing, laneSegments, trackLanes } from '../shared/motionGraph.ts'
import { elementText, splitUnitsForFrame } from '../shared/motionText.ts'

const body = (over: Partial<CompositionBody> = {}): CompositionBody => ({
  duration: 10,
  fps: 30,
  width: 1920,
  height: 1080,
  tracks: [],
  ...over,
})

const comp = (over: Partial<Composition> = {}): Composition => ({
  ...newComposition({ canvasId: 'c1', pageId: 'p1', body: body(), updatedBy: 'test', now: 1000 }),
  ...over,
})

const apply = (c: Composition, op: CompositionOp) => {
  const out = applyCompositionOps(c, [op])
  if (!out.ok) throw new Error(`op rejected: ${out.error}`)
  return out.value
}

describe('direction', () => {
  it('round-trips on the composition body and clamps the pass budget', () => {
    const direction: Direction = {
      treatment: 'Slow tension, one hero moment.',
      beats: [
        { seconds: 4, note: 'cold open', transition: 'cut' },
        { seconds: 2, transition: 'whip' },
      ],
      look: 'noir',
      passes: 99,
    }
    const parsed = parseCompositionBody({ ...body(), direction })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.direction?.treatment).toBe('Slow tension, one hero moment.')
    expect(parsed.value.direction?.beats).toHaveLength(2)
    expect(parsed.value.direction?.passes).toBe(CRITIQUE_PASS_MAX)
  })

  it('rejects malformed directions', () => {
    const bad = parseCompositionBody({ ...body(), direction: { beats: 'soon' } })
    expect(bad.ok).toBe(false)
    const badPasses = parseCompositionBody({ ...body(), direction: { passes: -2 } })
    expect(badPasses.ok).toBe(false)
  })

  it('set_direction writes and clears through ops', () => {
    const c = comp()
    const set = apply(c, { op: 'set_direction', direction: { treatment: 't', passes: CRITIQUE_PASS_DEFAULT } })
    expect(set.direction?.treatment).toBe('t')
    const cleared = apply(set, { op: 'set_direction', direction: null })
    expect(cleared.direction).toBeUndefined()
    const parsed = parseOps([{ op: 'set_direction', direction: { passes: 7 } }], 10)
    expect(parsed.ok).toBe(true)
    if (parsed.ok && parsed.value[0]?.op === 'set_direction') {
      expect(parsed.value[0].direction?.passes).toBe(CRITIQUE_PASS_MAX)
    }
  })
})

describe('storyboard consumes direction', () => {
  const frames: StoryboardFrame[] = [
    { id: 'a', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', x: 200, y: 0, width: 100, height: 100 },
    { id: 'c', x: 0, y: 200, width: 100, height: 100 },
  ]
  const opts = { frames, width: 1920, height: 1080, fps: 30 }

  it('beats tile the timeline with per-shot seconds', () => {
    const { body: b, shots } = buildStoryboard({
      ...opts,
      direction: { beats: [{ seconds: 5 }, { seconds: 1 }, { seconds: 3 }] },
    })
    expect(shots.map((s) => s.duration)).toEqual([5, 1, 3])
    expect(shots[0]?.t).toBe(0)
    expect(shots[1]?.t).toBe(5)
    expect(shots[2]?.t).toBe(6)
    expect(b.duration).toBe(9)
    expect(b.direction?.beats).toHaveLength(3)
  })

  it('unknown beat transitions cut — no invented motion', () => {
    const cut = buildStoryboard({ ...opts, direction: { beats: [{ seconds: 3, transition: 'spiral' }] } })
    const plain = buildStoryboard(opts)
    expect(cut.shots[0]?.transition).toBeUndefined()
    /* same keyframes as no direction at all (ids minted fresh each call) */
    const strip = (k: { id: string }) => {
      const { id: _, ...rest } = k
      return rest
    }
    expect((cut.body.tracks[0]?.keyframes ?? []).map(strip)).toEqual((plain.body.tracks[0]?.keyframes ?? []).map(strip))
  })

  it('a move beat eases the camera into the next pose before the cut', () => {
    const { body: b } = buildStoryboard({
      ...opts,
      direction: { beats: [{ seconds: 4, transition: 'move' }, { seconds: 2 }] },
    })
    const xs = (b.tracks[0]?.keyframes ?? []).filter((k) => k.property === 'x').map((k) => k.t)
    /* more camera poses than plain hold-per-shot: the travel pose landed */
    const plain = buildStoryboard({ ...opts })
    expect(xs.length).toBeGreaterThan((plain.body.tracks[0]?.keyframes ?? []).filter((k) => k.property === 'x').length)
  })
})

describe('motion blur', () => {
  it('set_motion_blur writes, bounds and clears the shutter', () => {
    const c = comp()
    const set = apply(c, { op: 'set_motion_blur', motionBlur: { shutter: 180, samples: 8 } })
    expect(set.motionBlur).toEqual({ shutter: 180, samples: 8 })
    const cleared = apply(set, { op: 'set_motion_blur', motionBlur: null })
    expect(cleared.motionBlur).toBeUndefined()
    const bad = parseOps([{ op: 'set_motion_blur', motionBlur: { shutter: 720 } }], 10)
    expect(bad.ok).toBe(false)
    const badK = parseOps([{ op: 'set_motion_blur', motionBlur: { shutter: 90, samples: 1 } }], 10)
    expect(badK.ok).toBe(false)
  })
})

describe('effect stack', () => {
  const track = () => ({ id: 'cam', kind: 'camera' as const, keyframes: [] })

  it('registers at least 25 effects with unique ids and working validators', () => {
    expect(MOTION_EFFECTS.length).toBeGreaterThanOrEqual(25)
    const ids = new Set(MOTION_EFFECTS.map((e) => e.id))
    expect(ids.size).toBe(MOTION_EFFECTS.length)
    for (const spec of MOTION_EFFECTS) {
      expect(spec.validate(spec.defaults())).toBeNull()
      expect(spec.validate({ nope: 1 })).toBeTruthy()
    }
  })

  it('normalizeParams coerces point arrays to "u,v" and keeps typed values', () => {
    const radial = effectSpec('radial-blur')
    expect(radial).toBeTruthy()
    const pointParam = radial!.params.find((p) => p.kind === 'point')
    if (pointParam) {
      const n = normalizeParams(radial!, { [pointParam.id]: [0.25, 0.75], junk: Symbol('x') as never })
      expect(n[pointParam.id]).toBe('0.25,0.75')
      expect('junk' in n).toBe(false)
    }
    const glow = effectSpec('glow')
    const n = normalizeParams(glow!, { intensity: 2 })
    expect(n.intensity).toBe(2)
  })

  it('add/update/remove/reorder ops keep the stack atomic and typed', () => {
    let c = comp({ tracks: [track()] })
    c = apply(c, { op: 'add_effect', trackId: 'cam', effect: { id: 'v1', fx: 'vignette', params: {} } })
    const added = c.tracks[0]!.effects!
    expect(added).toHaveLength(1)
    expect(added[0]!.fx).toBe('vignette')
    expect(added[0]!.id).toBeTruthy()
    c = apply(c, { op: 'add_effect', trackId: 'cam', effect: { id: 'gr', fx: 'film-grain', params: { amount: 0.2 } } })
    expect(c.tracks[0]!.effects).toHaveLength(2)
    c = apply(c, { op: 'update_effect', trackId: 'cam', effectId: 'gr', enabled: false })
    expect(c.tracks[0]!.effects![1]).toMatchObject({ enabled: false })
    /* per-effect blend is not drawn — writing one refuses loudly instead
       of storing a field nothing renders; clearing one stays legal */
    const blended = applyCompositionOps(c, [{ op: 'update_effect', trackId: 'cam', effectId: 'gr', blend: 'add' }])
    expect(blended.ok).toBe(false)
    c = apply(c, { op: 'update_effect', trackId: 'cam', effectId: 'gr', blend: null })
    expect(c.tracks[0]!.effects![1]!.blend).toBeUndefined()
    c = apply(c, { op: 'reorder_effects', trackId: 'cam', effectIds: ['gr', c.tracks[0]!.effects![0]!.id] })
    expect(c.tracks[0]!.effects![0]!.id).toBe('gr')
    c = apply(c, { op: 'remove_effect', trackId: 'cam', effectId: 'gr' })
    expect(c.tracks[0]!.effects).toHaveLength(1)
  })

  it('rejects unknown effects, bad params and a reorder that drops ids', () => {
    const c = comp({ tracks: [track()] })
    expect(
      applyCompositionOps(c, [{ op: 'add_effect', trackId: 'cam', effect: { id: 'x', fx: 'nope' } as never }]).ok,
    ).toBe(false)
    expect(
      applyCompositionOps(c, [
        { op: 'add_effect', trackId: 'cam', effect: { id: 'x', fx: 'vignette', params: { bogus: 1 } } as never },
      ]).ok,
    ).toBe(false)
    const withTwo = apply(
      apply(c, { op: 'add_effect', trackId: 'cam', effect: { id: 'a', fx: 'vignette', params: {} } }),
      { op: 'add_effect', trackId: 'cam', effect: { id: 'b', fx: 'tint', params: {} } },
    )
    expect(applyCompositionOps(withTwo, [{ op: 'reorder_effects', trackId: 'cam', effectIds: ['a'] }]).ok).toBe(false)
  })

  it('set_blend refuses a mode no renderer draws, but clears a stored one', () => {
    /* a blend on a track composites nowhere — the write fails loudly
       rather than sitting in the model as a no-op; a blend already stored
       (legacy film) can still be cleared */
    const c = comp({ tracks: [{ ...track(), blend: 'overlay' as const }] })
    const written = applyCompositionOps(c, [{ op: 'set_blend', trackId: 'cam', blend: 'multiply' }])
    expect(written.ok).toBe(false)
    const cleared = apply(c, { op: 'set_blend', trackId: 'cam', blend: null })
    expect(cleared.tracks[0]!.blend).toBeUndefined()
    expect(applyCompositionOps(c, [{ op: 'set_blend', trackId: 'cam', blend: 'wobbly' as never }]).ok).toBe(false)
  })

  it('effectSeed is deterministic and enabledEffects/cost respect toggles', () => {
    const c = comp({ tracks: [track()] })
    const withFx = apply(
      apply(c, { op: 'add_effect', trackId: 'cam', effect: { id: 'g', fx: 'film-grain', params: {} } }),
      { op: 'update_effect', trackId: 'cam', effectId: 'g', enabled: false },
    )
    const fx = withFx.tracks[0]!.effects![0]!
    expect(effectSeed(fx)).toBe(effectSeed({ ...fx }))
    expect(enabledEffects(withFx.tracks[0]!)).toHaveLength(0)
    expect(effectCost(withFx.tracks[0]!)).toBe(0)
  })

  it('adjustment clips only sit on adjustment tracks', () => {
    const adj = { id: 'adj', kind: 'adjustment' as const, clips: [] }
    const c = comp({ tracks: [adj] })
    const clip = { id: 'w', start: 1, duration: 2, source: { type: 'adjustment' as const } }
    const inserted = applyCompositionOps(c, [{ op: 'add_clip', trackId: 'adj', clip }])
    expect(inserted.ok).toBe(true)
    const clipTrack = { id: 'cc', kind: 'clip' as const, clips: [] }
    const c2 = comp({ tracks: [clipTrack] })
    expect(applyCompositionOps(c2, [{ op: 'add_clip', trackId: 'cc', clip }]).ok).toBe(false)
  })
})

describe('gl shader coverage', () => {
  /* the builtins every fragment source declares — params add to this set */
  const BUILTIN = new Set(['u_tex', 'u_tex2', 'u_res', 'u_seed', 'u_t', 'u_fps'])
  const uniform = (id: string) => `u_${id.replace(/-/g, '_')}`

  it('every registered effect ships a GL body and is listed in GL_EFFECT_IDS', () => {
    for (const spec of MOTION_EFFECTS) {
      expect(GL_EFFECT_IDS.has(spec.id), spec.id).toBe(true)
      expect(glslBodies(spec.id).length, spec.id).toBeGreaterThan(0)
    }
    expect(GL_EFFECT_IDS.size).toBe(MOTION_EFFECTS.length)
  })

  it('every spec parameter maps to a shader uniform, and bodies read nothing undeclared', () => {
    for (const spec of MOTION_EFFECTS) {
      const bodies = glslBodies(spec.id)
      const used = new Set(bodies.flatMap((b) => [...b.matchAll(/\bu_[A-Za-z_]\w*/g)].map((m) => m[0])))
      const declared = new Set(BUILTIN)
      for (const p of spec.params) {
        declared.add(uniform(p.id))
        /* colors declare an alpha companion uniform alongside the vec3 */
        if (p.kind === 'color') declared.add(`${uniform(p.id)}_a`)
        expect(used.has(uniform(p.id)), `${spec.id}.${p.id} never reaches the shader`).toBe(true)
      }
      for (const u of used) {
        expect(declared.has(u), `${spec.id} reads undeclared uniform ${u}`).toBe(true)
      }
    }
  })

  it('MO-14 reports nothing for a stack of all registered effects', () => {
    const track = () => ({
      id: 'cam',
      kind: 'camera' as const,
      keyframes: [],
      effects: MOTION_EFFECTS.map((spec) => ({ id: `fx-${spec.id}`, fx: spec.id, params: spec.defaults() })),
    })
    const issues = lintComposition(comp({ tracks: [track()] })).filter((i) => i.rule === 'MO-14')
    expect(issues).toEqual([])
  })
})

describe('fx: keyframe namespace', () => {
  it('names and splits only well-formed fx properties', () => {
    expect(isFxProperty('fx:glow.intensity')).toBe(true)
    expect(isFxProperty('fx:glow-2.radius')).toBe(true)
    expect(isFxProperty('fx:glow.')).toBe(false)
    expect(isFxProperty('x:glow.intensity')).toBe(false)
    expect(fxPropertyParts('fx:glow.intensity')).toEqual({ effectId: 'glow', param: 'intensity' })
    expect(fxPropertyParts('fx:weird')).toBeNull()
  })
})

describe('looks', () => {
  it('every built-in look resolves to a valid, enabled stack the renderer draws', () => {
    expect(MOTION_LOOKS.length).toBeGreaterThanOrEqual(8)
    for (const look of MOTION_LOOKS) {
      const stack = lookEffects(look.id)
      expect(stack, look.id).toBeTruthy()
      for (const fx of stack!) {
        expect(effectSpec(fx.fx), `${look.id}:${fx.fx}`).toBeTruthy()
        expect(effectSpec(fx.fx)!.validate(fx.params)).toBeNull()
        /* a look effect without a GL body drops loudly at render — every
           one must be drawable (film-35 needs curves + halftone, crt needs
           scanlines + barrel-distortion + bloom) */
        expect(GL_EFFECT_IDS.has(fx.fx), `${look.id}:${fx.fx} has no GL body`).toBe(true)
      }
    }
    expect(lookEffects('not-a-look')).toBeUndefined()
  })
})

describe('graph model', () => {
  it('laneSegments walks a lane in order and curve presets ease', () => {
    const c = comp({
      tracks: [
        {
          id: 't',
          kind: 'camera',
          keyframes: [
            { id: 'k1', property: 'x', t: 2, value: 4, easing: { type: 'linear' } },
            { id: 'k0', property: 'x', t: 0, value: 1, easing: { type: 'linear' } },
            { id: 'k2', property: 'y', t: 1, value: 9, easing: { type: 'linear' } },
          ],
        },
      ],
    })
    const lanes = trackLanes(c.tracks[0]!).sort()
    expect(lanes).toEqual(['x', 'y'])
    const segs = laneSegments(c.tracks[0]!, 'x')
    expect(segs).toHaveLength(1)
    expect(segs[0]!.from.t).toBe(0)
    expect(segs[0]!.to.t).toBe(2)
    expect(curveEasing('ease-out-quint')).toBeTruthy()
  })
})

describe('text split parity', () => {
  const html = (text: string) => `<div data-doop-id="h1">${text}</div><div data-doop-id="plain">no split</div>`

  it('elementText strips markup to the visible string', () => {
    expect(elementText('<p data-doop-id="x">Hello brave world</p>', 'x')).toBe('Hello brave world')
    /* nested markup is not a flat text — undefined, it cannot split safely */
    expect(elementText('<p data-doop-id="x">Hello <b>brave</b></p>', 'x')).toBeUndefined()
  })

  it('splitUnitsForFrame wraps word units once, only on split elements', () => {
    const out = splitUnitsForFrame(html('One two three'), new Map([['h1', 'word']]))
    expect(out).toContain('data-doop-unit="0"')
    expect((out.match(/data-doop-unit="/g) ?? []).length).toBe(3)
    expect(out).toContain('no split')
    expect(out).not.toMatch(/<div data-doop-id="plain">[^<]*data-doop-unit/)
  })
})
