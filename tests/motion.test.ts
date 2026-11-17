/**
 * Motion Studio contract tests: the pure surface the frontend and MCP tools
 * share — parsing, ops, time→state, and the seek-safety lint.
 */
import { describe, expect, it } from 'vitest'
import {
  applyCompositionOps,
  buildStoryboard,
  newComposition,
  parseCompositionBody,
  parseEasing,
  parseEasingToken,
  parseMotionBlock,
  parseOps,
  storyboardOrder,
  type Composition,
  type CompositionBody,
} from '../shared/motion.ts'
import { easingProgress, frameStateAt, interpolate, laneValueAt, springProgress } from '../shared/motionRuntime.ts'
import { lintComposition, lintMotionHtml } from '../shared/motionLint.ts'

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

describe('parseCompositionBody', () => {
  it('accepts a minimal body', () => {
    const r = parseCompositionBody({ duration: 10, fps: 30, width: 1920, height: 1080 })
    expect(r.ok && r.value.duration).toBe(10)
  })
  it('rejects bad fps, sizes and durations', () => {
    expect(parseCompositionBody({ duration: 0, fps: 30, width: 100, height: 100 }).ok).toBe(false)
    expect(parseCompositionBody({ duration: 10, fps: 30.5, width: 100, height: 100 }).ok).toBe(false)
    expect(parseCompositionBody({ duration: 10, fps: 30, width: 2, height: 100 }).ok).toBe(false)
    expect(parseCompositionBody({ duration: 601, fps: 30, width: 100, height: 100 }).ok).toBe(false)
  })
  it('rejects two camera tracks and non-camera props on the camera track', () => {
    const cam = { id: 'a', kind: 'camera' }
    expect(parseCompositionBody({ ...body(), tracks: [cam, { id: 'b', kind: 'camera' }] }).ok).toBe(false)
    expect(
      parseCompositionBody({
        ...body(),
        tracks: [{ id: 'a', kind: 'camera', keyframes: [{ id: 'k', property: 'opacity', t: 0, value: 1 }] }],
      }).ok,
    ).toBe(false)
  })
  it('rejects what the ops refuse: effects off camera/adjustment and track blends', () => {
    /* a whole-body write reparses every track — it must not sneak in the
       stacks the add_track/add_effect/set_blend ops refuse op by op */
    const fx = { id: 'e1', fx: 'vignette', params: {} }
    for (const kind of ['element', 'clip', 'audio', 'caption'] as const) {
      const r = parseCompositionBody({ ...body(), tracks: [{ id: 't', kind, effects: [fx] }] })
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toContain(`not ${kind} tracks`)
    }
    const camFx = parseCompositionBody({ ...body(), tracks: [{ id: 'c', kind: 'camera', effects: [fx] }] })
    expect(camFx.ok).toBe(true)
    const adjFx = parseCompositionBody({ ...body(), tracks: [{ id: 'c', kind: 'adjustment', effects: [fx] }] })
    expect(adjFx.ok).toBe(true)
    const blended = parseCompositionBody({ ...body(), tracks: [{ id: 'c', kind: 'camera', blend: 'multiply' }] })
    expect(blended.ok).toBe(false)
    expect(!blended.ok && blended.error).toBe('track blend is not drawn yet')
    /* null blend stays a legal clear */
    const cleared = parseCompositionBody({ ...body(), tracks: [{ id: 'c', kind: 'camera', blend: null }] })
    expect(cleared.ok).toBe(true)
  })
})

describe('easing + evaluation', () => {
  it('parses easings', () => {
    expect(parseEasing('linear')).toEqual({ type: 'linear' })
    expect(parseEasing({ type: 'spring', stiffness: 100, damping: 12, mass: 1 })).toBeTruthy()
    expect(parseEasing({ type: 'cubic-bezier', x1: 2, y1: 0, x2: 0, y2: 0 })).toBeNull()
    expect(parseEasingToken('cubic-bezier(.2,.8,.2,1)')).toEqual({
      type: 'cubic-bezier',
      x1: 0.2,
      y1: 0.8,
      x2: 0.2,
      y2: 1,
    })
    expect(parseEasingToken('spring(180, 26, 1)')).toEqual({ type: 'spring', stiffness: 180, damping: 26, mass: 1 })
  })
  it('easingProgress: linear/hold/steps/spring', () => {
    expect(easingProgress({ type: 'linear' }, 0.5, 0.5)).toBe(0.5)
    expect(easingProgress({ type: 'hold' }, 0.9, 0.9)).toBe(0)
    expect(easingProgress({ type: 'steps', steps: 4 }, 0.5, 0.5)).toBe(0.5)
    expect(easingProgress({ type: 'steps', steps: 4, position: 'start' }, 0.5, 0.5)).toBe(0.75)
    expect(springProgress(100, 10, 1, 0)).toBe(0)
    expect(springProgress(100, 10, 1, 5)).toBeGreaterThan(0.99)
    /* an underdamped spring overshoots */
    let peak = 0
    for (let i = 0; i < 200; i++) peak = Math.max(peak, springProgress(100, 5, 1, i / 100))
    expect(peak).toBeGreaterThan(1)
  })
  it('interpolate: numbers lerp, colors lerp, other strings flip at midpoint', () => {
    expect(interpolate(0, 10, 0.5)).toBe(5)
    expect(interpolate('rgb(0, 0, 0)', 'rgb(255, 255, 255)', 0.5)).toBe('rgba(128, 128, 128, 1)')
    expect(interpolate('a', 'b', 0.4)).toBe('a')
    expect(interpolate('a', 'b', 0.6)).toBe('b')
  })
  it('laneValueAt holds endpoints outside the lane', () => {
    const lane = [
      { id: 'a', property: 'x', t: 2, value: 0, easing: { type: 'linear' } as const },
      { id: 'b', property: 'x', t: 4, value: 10, easing: { type: 'linear' } as const },
    ]
    expect(laneValueAt(lane, 0)).toBe(0)
    expect(laneValueAt(lane, 3)).toBe(5)
    expect(laneValueAt(lane, 9)).toBe(10)
  })
})

describe('frameStateAt', () => {
  const c = comp({
    tracks: [
      {
        id: 'cam',
        kind: 'camera',
        keyframes: [
          { id: 'x0', property: 'x', t: 0, value: 0, easing: { type: 'linear' } },
          { id: 'x1', property: 'x', t: 10, value: 100, easing: { type: 'linear' } },
          { id: 'z0', property: 'zoom', t: 0, value: 2, easing: { type: 'hold' } },
        ],
      },
      {
        id: 'el',
        kind: 'element',
        frameId: 'f1',
        elementId: 'hero',
        keyframes: [{ id: 'o', property: 'opacity', t: 5, value: 0.5, easing: { type: 'linear' } }],
      },
      {
        id: 'cap',
        kind: 'caption',
        clips: [{ id: 'c', start: 2, duration: 3, source: { type: 'caption', text: 'hi' } }],
      },
    ],
  })
  it('evaluates camera, elements and clips deterministically', () => {
    const s = frameStateAt(c, 3)
    expect(s.camera).toEqual({ x: 30, y: 0, zoom: 2, rotation: 0 })
    expect(s.elements['f1/hero']).toEqual({ opacity: 0.5 })
    expect(s.activeClips).toHaveLength(1)
    expect(s.activeClips[0]!.trackId).toBe('cap')
    expect(frameStateAt(c, 3)).toEqual(s)
    /* clip window [2,5) — out at both ends */
    expect(frameStateAt(c, 1).activeClips).toHaveLength(0)
    expect(frameStateAt(c, 5).activeClips).toHaveLength(0)
  })
  it('clamps t and skips muted tracks', () => {
    expect(frameStateAt(c, -3).t).toBe(0)
    expect(frameStateAt(c, 99).t).toBe(10)
    const muted = { ...c, tracks: c.tracks.map((t) => (t.id === 'cap' ? { ...t, muted: true } : t)) }
    expect(frameStateAt(muted, 3).activeClips).toHaveLength(0)
  })
  it('merges frame blocks under element tracks', () => {
    const s = frameStateAt(c, 5, {
      frameBlocks: new Map([
        [
          'f1',
          [
            { el: 'hero', prop: 'x', t: 0, value: 7 },
            { el: 'other', prop: 'opacity', t: 0, value: 1 },
          ],
        ],
      ]),
    })
    expect(s.elements['f1/hero']).toEqual({ x: 7, opacity: 0.5 })
    expect(s.elements['f1/other']).toEqual({ opacity: 1 })
  })
})

describe('ops', () => {
  it('applies set_camera upserts and creates the camera track', () => {
    const c = comp()
    const r = applyCompositionOps(c, [
      { op: 'set_camera', t: 0, x: 10, y: 20, zoom: 1.5 },
      { op: 'set_camera', t: 0, x: 99 },
    ])
    expect(r.ok).toBe(true)
    const cam = r.ok ? r.value.tracks.find((t) => t.kind === 'camera')! : null!
    expect(cam.keyframes!.find((k) => k.property === 'x')!.value).toBe(99)
    expect(cam.keyframes!.find((k) => k.property === 'zoom')!.value).toBe(1.5)
  })
  it('is atomic: a bad op fails the whole batch', () => {
    const c = comp()
    const r = applyCompositionOps(c, [
      { op: 'add_track', track: { id: 't1', kind: 'caption' } },
      { op: 'remove_track', trackId: 'nope' },
    ])
    expect(r.ok).toBe(false)
    expect(c.tracks).toHaveLength(0)
  })
  it('rejects clips past the duration and wrong-kind clips', () => {
    const c = comp({ tracks: [{ id: 'a', kind: 'audio' }] })
    expect(
      applyCompositionOps(c, [
        {
          op: 'add_clip',
          trackId: 'a',
          clip: { id: 'x', start: 0, duration: 3, source: { type: 'caption', text: 'no' } },
        },
      ]).ok,
    ).toBe(false)
    expect(
      applyCompositionOps(c, [
        {
          op: 'add_clip',
          trackId: 'a',
          clip: { id: 'x', start: 8, duration: 3, source: { type: 'asset', assetId: 'as1' } },
        },
      ]).ok,
    ).toBe(false)
  })
  it('validates wire ops', () => {
    expect(parseOps([{ op: 'set_camera', t: 1, x: 0 }], 10).ok).toBe(true)
    expect(parseOps([{ op: 'set_camera', t: 1 }], 10).ok).toBe(false)
    expect(parseOps([{ op: 'bogus' }], 10).ok).toBe(false)
  })
})

describe('motion block + storyboard', () => {
  it('parses a data-doop-motion block', () => {
    expect(parseMotionBlock(JSON.stringify({ v: 1, keyframes: [{ el: 'a', prop: 'x', t: 0, value: 1 }] }))).toBeTruthy()
    expect(parseMotionBlock('{v:2}')).toBeNull()
    expect(parseMotionBlock('{"v":1,"keyframes":[{"el":"a"}]}')).toBeNull()
  })
  it('orders a storyboard in reading order and fits the camera', () => {
    const frames = [
      { id: 'b', x: 500, y: 0, width: 100, height: 100 },
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'c', x: 0, y: 300, width: 100, height: 100 },
    ]
    expect(storyboardOrder(frames).map((f) => f.id)).toEqual(['a', 'b', 'c'])
    const { body: b, shots } = buildStoryboard({ frames, width: 1000, height: 1000, fps: 30, shotSeconds: 2 })
    expect(b.duration).toBe(6)
    expect(shots.map((s) => s.frameId)).toEqual(['a', 'b', 'c'])
    const cam = b.tracks[0]!
    expect(cam.kind).toBe('camera')
    expect(cam.keyframes).toHaveLength(12) /* 3 shots × 4 props */
    expect(cam.keyframes!.every((k) => k.easing.type === 'hold')).toBe(true)
  })
})

describe('lint_motion', () => {
  it('flags the wall clock, free-running loops, unseeded random, gsap', () => {
    const issues = lintMotionHtml('<script>setInterval(() => { Date.now(); Math.random(); gsap.to(); }, 16)</script>')
    const rules = issues.map((i) => i.rule)
    expect(rules).toContain('MO-01')
    expect(rules).toContain('MO-02')
    expect(rules).toContain('MO-03')
    expect(rules).toContain('MO-05')
  })
  it('accepts a seek-bound script', () => {
    const issues = lintMotionHtml(
      `<script>document.addEventListener('doop:seek', e => requestAnimationFrame(() => {}))</script>`,
    )
    expect(issues.filter((i) => i.rule === 'MO-02')).toHaveLength(0)
  })
  it('flags unbound and infinite CSS animations but not --t-bound ones', () => {
    expect(lintMotionHtml('<style>.a{animation:spin 1s infinite}</style>').some((i) => i.rule === 'MO-04')).toBe(true)
    expect(lintMotionHtml('<style>.a{animation:spin 2s ease}</style>').some((i) => i.rule === 'MO-04')).toBe(true)
    expect(
      lintMotionHtml(
        '<style>.a{animation:spin 2s linear;animation-play-state:paused;animation-delay:calc(var(--t)*-1s)}</style>',
      ).some((i) => i.rule === 'MO-04'),
    ).toBe(false)
  })
  it('flags autoplay media, nested timed media, bad motion blocks, missing scene duration', () => {
    expect(lintMotionHtml('<video autoplay src="x.mp4"></video>').some((i) => i.rule === 'MO-07')).toBe(true)
    expect(
      lintMotionHtml('<div data-start="0"><video data-start="1" src="x.mp4"></video></div>').some(
        (i) => i.rule === 'MO-08',
      ),
    ).toBe(true)
    expect(
      lintMotionHtml('<script type="application/json" data-doop-motion>not json</script>').some(
        (i) => i.rule === 'MO-10',
      ),
    ).toBe(true)
    expect(lintMotionHtml('<div data-doop-scene><p>x</p></div>').some((i) => i.rule === 'MO-09')).toBe(true)
    expect(
      lintMotionHtml('<div data-doop-scene data-duration="8"><p>x</p></div>').some((i) => i.rule === 'MO-09'),
    ).toBe(false)
  })
  it('lintComposition flags structural problems', () => {
    const issues = lintComposition(
      comp({
        tracks: [
          {
            id: 'a',
            kind: 'caption',
            clips: [{ id: 'c', start: 9, duration: 3, source: { type: 'caption', text: 'x' } }],
          },
        ],
      }),
    )
    expect(issues.some((i) => i.message.includes('past the composition duration'))).toBe(true)
  })
})
