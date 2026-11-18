/**
 * Layer planning: promotion rules, static/dynamic content decisions,
 * budgets (MO-15..19), the compositor matrix with parent chains, and the
 * raster CSS helpers — the static half the browser engine builds on
 * (motion-elements P0).
 */
import { describe, expect, it } from 'vitest'
import {
  MOTION_LIMITS,
  newComposition,
  type Composition,
  type CompositionBody,
  type MotionTrack,
} from '../shared/motion.ts'
import type { CompositionStateAt } from '../shared/motionRuntime.ts'
import {
  baseHideCss,
  isLayer,
  layerIsolateCss,
  layerMatrix,
  layerRasterProps,
  mulAffine,
  planLayers,
  type LayerGeometry,
} from '../shared/motionLayers.ts'

const body = (tracks: MotionTrack[] = []): CompositionBody => ({
  duration: 10,
  fps: 30,
  width: 1000,
  height: 500,
  tracks,
})

const comp = (tracks: MotionTrack[] = []): Composition =>
  newComposition({ canvasId: 'c1', pageId: 'p1', body: body(tracks), updatedBy: 'test', now: 1000 })

const el = (over: Partial<MotionTrack> = {}): MotionTrack => ({
  id: 't1',
  kind: 'element',
  frameId: 'f1',
  elementId: 'hero',
  ...over,
})

const FX = { id: 'e1', fx: 'vignette', params: {} }
const HTML = `<body><div data-doop-id="wrap"><h1 data-doop-id="hero">hi</h1></div><p data-doop-id="sub">x</p></body>`

describe('isLayer — the promotion table', () => {
  it('promotes an element with an enabled stack, a blend, a matte, masks or mode on', () => {
    expect(isLayer(el({ effects: [FX] }))).toBe(true)
    expect(isLayer(el({ blend: 'screen' }))).toBe(true)
    expect(isLayer(el({ matte: { source: 't2', channel: 'alpha' } }))).toBe(true)
    expect(
      isLayer(
        el({
          masks: [{ id: 'm', shape: { type: 'rect', x: 0, y: 0, width: 10, height: 10 } }],
        }),
      ),
    ).toBe(true)
    expect(isLayer(el({ layer: { mode: 'on' } }))).toBe(true)
  })

  it('keeps ordinary and suppressed elements in the base raster', () => {
    expect(isLayer(el())).toBe(false)
    expect(isLayer(el({ blend: 'normal' }))).toBe(false)
    /* mode off keeps the element in the base even with a stack */
    expect(isLayer(el({ effects: [FX], layer: { mode: 'off' } }))).toBe(false)
    /* a muted track draws nothing extra */
    expect(isLayer(el({ effects: [FX], muted: true }))).toBe(false)
    /* non-element kinds never promote */
    expect(isLayer({ id: 'c', kind: 'camera', effects: [FX] })).toBe(false)
    expect(isLayer(el({ effects: [FX], frameId: undefined }))).toBe(false)
    /* a stack that is all-disabled does not promote */
    expect(isLayer(el({ effects: [{ ...FX, enabled: false }] }))).toBe(false)
  })
})

describe('planLayers — static vs dynamic content', () => {
  const frames = [{ id: 'f1', html: HTML }]

  it('transform and opacity lanes keep a layer static', () => {
    const track = el({
      effects: [FX],
      keyframes: [
        { id: 'k1', property: 'x', t: 0, value: 0, easing: { type: 'linear' } as const },
        { id: 'k2', property: 'x', t: 1, value: 50, easing: { type: 'linear' } as const },
        { id: 'k3', property: 'opacity', t: 0, value: 0, easing: { type: 'linear' } as const },
        { id: 'k4', property: 'opacity', t: 1, value: 1, easing: { type: 'linear' } as const },
      ],
    })
    const [plan] = planLayers(comp([track]), frames)
    expect(plan!.layers).toHaveLength(1)
    expect(plan!.layers[0]!.content).toBe('static')
    expect(plan!.layers[0]!.geometry).toBe('unavailable')
  })

  it('fx: lanes stay static — they drive params on the GL pass', () => {
    const track = el({
      effects: [FX],
      keyframes: [{ id: 'k1', property: 'fx:e1.amount', t: 0, value: 0, easing: { type: 'linear' } as const }],
    })
    const [plan] = planLayers(comp([track]), frames)
    expect(plan!.layers[0]!.content).toBe('static')
  })

  it('a non-transform lane makes the raster dynamic', () => {
    const track = el({
      effects: [FX],
      keyframes: [{ id: 'k1', property: 'color', t: 0, value: '#000', easing: { type: 'linear' } as const }],
    })
    const [plan] = planLayers(comp([track]), frames)
    expect(plan!.layers[0]!.content).toBe('dynamic')
    expect(plan!.layers[0]!.contentReasons[0]).toContain('color')
  })

  it('a scene frame is always dynamic — its paint depends on --t', () => {
    const sceneHtml = `<body data-doop-scene><h1 data-doop-id="hero">hi</h1></body>`
    const [plan] = planLayers(comp([el({ effects: [FX] })]), [{ id: 'f1', html: sceneHtml }])
    expect(plan!.layers[0]!.content).toBe('dynamic')
    expect(plan!.layers[0]!.contentReasons.join()).toContain('scene')
  })

  it('a tracked non-layer descendant re-rasters the parent layer', () => {
    const track = el({ effects: [FX] })
    const child = el({
      id: 't2',
      elementId: 'sub',
      keyframes: [{ id: 'k', property: 'x', t: 0, value: 0, easing: { type: 'linear' } as const }],
    })
    /* 'sub' is inside hero's subtree in HTML — hero re-paints when it moves */
    const nested = `<body><h1 data-doop-id="hero"><b data-doop-id="sub">in</b></h1></body>`
    const [plan] = planLayers(comp([track, child]), [{ id: 'f1', html: nested }])
    expect(plan!.layers[0]!.content).toBe('dynamic')
    expect(plan!.layers[0]!.contentReasons.join()).toContain('sub')
  })

  it('pad combines authoring and stack growth, clamped', () => {
    const track = el({ layer: { mode: 'on', pad: 10 }, effects: [{ id: 'g', fx: 'glow', params: { radius: 20 } }] })
    const [plan] = planLayers(comp([track]), frames)
    expect(plan!.layers[0]!.pad).toBeGreaterThanOrEqual(10)
    expect(plan!.layers[0]!.pad).toBeLessThanOrEqual(MOTION_LIMITS.MAX_LAYER_PAD)
  })

  it('scale follows the worst camera zoom and layer scale, capped at 4', () => {
    const cam = {
      id: 'cam',
      kind: 'camera' as const,
      keyframes: [{ id: 'z', property: 'zoom', t: 0, value: 2, easing: { type: 'hold' } as const }],
    }
    const track = el({ effects: [FX] })
    const [plan] = planLayers(comp([cam, track]), frames)
    expect(plan!.layers[0]!.scale).toBe(2)
    const [huge] = planLayers(
      comp([
        {
          ...cam,
          keyframes: [{ id: 'z', property: 'zoom', t: 0, value: 99, easing: { type: 'hold' } as const }],
        },
        track,
      ]),
      frames,
    )
    expect(huge!.layers[0]!.scale).toBe(4)
    /* a layer.scale override wins */
    const [fixed] = planLayers(comp([cam, el({ layer: { mode: 'on', scale: 1.5 } })]), frames)
    expect(fixed!.layers[0]!.scale).toBe(1.5)
  })

  it('document order drives composite order without measured paint order', () => {
    const tracks = [
      el({ id: 't1', elementId: 'hero', effects: [FX] }),
      el({ id: 't2', elementId: 'sub', effects: [FX] }),
    ]
    const [plan] = planLayers(comp(tracks), frames)
    const hero = plan!.layers.find((l) => l.elementId === 'hero')!
    const sub = plan!.layers.find((l) => l.elementId === 'sub')!
    expect(hero.order).toBeLessThan(sub.order)
  })
})

describe('planLayers — budgets and issues', () => {
  it('MO-15 fires over the per-frame layer budget', () => {
    const tracks = Array.from({ length: MOTION_LIMITS.MAX_LAYERS_PER_FRAME + 1 }, (_, i) =>
      el({ id: `t${i}`, elementId: `e${i}`, effects: [FX] }),
    )
    const [plan] = planLayers(comp(tracks), [{ id: 'f1' }])
    expect(plan!.issues.some((i) => i.rule === 'MO-15' && i.severity === 'error')).toBe(true)
  })

  it('MO-15 fires over the film-wide layer budget', () => {
    const frames = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}` }))
    const tracks = Array.from({ length: MOTION_LIMITS.MAX_LAYERS + 1 }, (_, i) =>
      el({ id: `t${i}`, frameId: `f${i % 5}`, elementId: `e${i}`, effects: [FX] }),
    )
    const plans = planLayers(comp(tracks), frames)
    const all = plans.flatMap((p) => p.issues)
    expect(all.some((i) => i.rule === 'MO-15' && i.message.includes('across the film'))).toBe(true)
  })

  it('MO-15 fires when the needed texture exceeds the side budget', () => {
    const geo: LayerGeometry = { rect: { x: 0, y: 0, width: MOTION_LIMITS.MAX_LAYER_SIDE + 100, height: 10 } }
    const [plan] = planLayers(comp([el({ effects: [FX] })]), [{ id: 'f1' }], {
      geometry: new Map([['f1/hero', geo]]),
    })
    expect(plan!.issues.some((i) => i.rule === 'MO-15' && i.message.includes('texture'))).toBe(true)
  })

  it('MO-19 flags a layer nested inside an effect-carrying layer', () => {
    const nested = `<body><div data-doop-id="wrap"><h1 data-doop-id="hero">hi</h1></div></body>`
    const tracks = [
      el({ id: 't1', elementId: 'wrap', effects: [FX] }),
      el({ id: 't2', elementId: 'hero', effects: [FX] }),
    ]
    const [plan] = planLayers(comp(tracks), [{ id: 'f1', html: nested }])
    const mo19 = plan!.issues.filter((i) => i.rule === 'MO-19')
    expect(mo19).toHaveLength(1)
    expect(mo19[0]!.message).toContain('hero')
    expect(mo19[0]!.message).toContain('wrap')
    /* without the parent stack there is no double-application — no issue */
    const [clean] = planLayers(comp([el({ id: 't1', elementId: 'wrap', blend: 'screen' }), tracks[1]!]), [
      { id: 'f1', html: nested },
    ])
    expect(clean!.issues.filter((i) => i.rule === 'MO-19')).toHaveLength(0)
  })

  it('MO-17 warns when measured geometry forces the transform into CSS', () => {
    const geo: LayerGeometry = { rect: { x: 0, y: 0, width: 10, height: 10 }, ancestorRotated: true }
    const [plan] = planLayers(comp([el({ effects: [FX] })]), [{ id: 'f1' }], {
      geometry: new Map([['f1/hero', geo]]),
    })
    expect(plan!.layers[0]!.transform).toBe('css')
    expect(plan!.issues.some((i) => i.rule === 'MO-17' && i.severity === 'warning')).toBe(true)
    /* an explicit layer.transform wins over the heuristic */
    const [forced] = planLayers(
      comp([el({ effects: [FX], layer: { mode: 'on', transform: 'compositor' } })]),
      [{ id: 'f1' }],
      {
        geometry: new Map([['f1/hero', geo]]),
      },
    )
    expect(forced!.layers[0]!.transform).toBe('compositor')
  })

  it('measured geometry fills texture size and area-weights the cost', () => {
    const geo: LayerGeometry = { rect: { x: 0, y: 0, width: 100, height: 50 } }
    const track = el({ effects: [{ id: 'b', fx: 'gaussian-blur', params: {} }] })
    const [plan] = planLayers(comp([track]), [{ id: 'f1' }], { geometry: new Map([['f1/hero', geo]]) })
    const layer = plan!.layers[0]!
    expect(layer.geometry).toBe('measured')
    expect(layer.texture).toBeTruthy()
    expect(layer.texture!.width).toBeGreaterThanOrEqual(100)
    /* unweighted cost is the stack sum; measured is area-weighted */
    const area = (100 * 50) / (1000 * 500)
    expect(layer.cost).toBeCloseTo(4 * area, 10) /* gaussian-blur costs 4 */
  })
})

describe('layerMatrix — compositor transforms', () => {
  const state = (elements: Record<string, Record<string, number | string>>): CompositionStateAt => ({
    t: 0,
    camera: null,
    elements,
    activeClips: [],
  })

  const plan: Parameters<typeof layerMatrix>[0] = {
    trackId: 't1',
    frameId: 'f1',
    elementId: 'hero',
    order: 0,
    content: 'static',
    contentReasons: [],
    transform: 'compositor',
    visible: true,
    pad: 0,
    scale: 1,
    cost: 0,
    geometry: 'unavailable',
  }

  it('is the identity at rest', () => {
    expect(layerMatrix(plan, state({}))).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('translates by x/y and scales about the measured origin', () => {
    const m = layerMatrix(plan, state({ 'f1/hero': { x: 10, y: 5 } }))
    expect(m[4]).toBeCloseTo(10)
    expect(m[5]).toBeCloseTo(5)
    /* scale 2 about origin (50, 25): the origin is the fixed point —
       M(50,25) = (50,25) */
    const geo: LayerGeometry = { rect: { x: 40, y: 20, width: 20, height: 10 } }
    const sm = layerMatrix(plan, state({ 'f1/hero': { scale: 2 } }), geo)
    expect(sm[0]).toBeCloseTo(2)
    const ox = 50
    const oy = 25
    expect(sm[0] * ox + sm[2] * oy + sm[4]).toBeCloseTo(ox)
    expect(sm[1] * ox + sm[3] * oy + sm[5]).toBeCloseTo(oy)
  })

  it('premultiplies the parent chain outermost-first', () => {
    const geo: LayerGeometry = {
      rect: { x: 0, y: 0, width: 10, height: 10 },
      parents: [{ elementId: 'wrap', origin: { x: 0, y: 0 } }],
    }
    /* parent moved +20 x: the child rides along — its translation adds */
    const m = layerMatrix(plan, state({ 'f1/hero': { x: 5, y: 0 }, 'f1/wrap': { x: 20, y: 0 } }), geo)
    expect(m[4]).toBeCloseTo(25)
    /* parent scaled 2×: the child's own 5px offset becomes 10 */
    const scaled = layerMatrix(plan, state({ 'f1/hero': { x: 5, y: 0 }, 'f1/wrap': { scale: 2 } }), geo)
    expect(scaled[0]).toBeCloseTo(2)
    expect(scaled[4]).toBeCloseTo(10)
  })

  it('mulAffine composes in application order', () => {
    const t = mulAffine([1, 0, 0, 1, 10, 0], [2, 0, 0, 2, 0, 0])
    /* scale first, then translate: (2·x, 2·y) + (10,0) */
    expect(t[0] * 1 + t[4]).toBeCloseTo(12)
    expect(t[3] * 1 + t[5]).toBeCloseTo(2)
  })
})

describe('raster CSS helpers', () => {
  it('layerIsolateCss shows only the element subtree and hides nested layers', () => {
    const css = layerIsolateCss('hero', ['nested-1'])
    expect(css).toContain('[data-doop-id="hero"]')
    expect(css).toContain('visibility: hidden')
    expect(css).toContain('[data-doop-id="nested-1"]')
    expect(css).toContain('background: transparent')
    /* the nested rule comes last so it wins over the subtree reveal */
    expect(css.lastIndexOf('nested-1')).toBeGreaterThan(css.indexOf('"hero"'))
  })

  it('layerIsolateCss refuses unsafe ids', () => {
    expect(() => layerIsolateCss('a" onmouseover="x')).toThrow()
    expect(() => baseHideCss(['a" bad'])).toThrow()
    expect(baseHideCss(['ok-id'])).toContain('data-doop-id="ok-id"')
  })

  it('baseHideCss hides each promoted element', () => {
    const css = baseHideCss(['a', 'b'])
    expect(css.split('\n')).toHaveLength(2)
    expect(css).toContain('[data-doop-id="a"]')
    expect(css).toContain('[data-doop-id="b"]')
  })

  it('layerRasterProps drops transform props the compositor owns', () => {
    const props = { x: 10, opacity: 0.5, rotate: 30, color: '#fff', fontSize: 20 }
    const out = layerRasterProps('compositor', props)
    expect(out).toEqual({ color: '#fff', fontSize: 20 })
    /* css mode keeps everything — the raster draws the transform itself */
    expect(layerRasterProps('css', props)).toEqual(props)
  })
})
