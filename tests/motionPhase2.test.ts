/**
 * Phase 2 contract tests: transitions, camera presets, text animators and
 * the mask/path properties — the additive surface over the phase 0-1 core.
 */
import { describe, expect, it } from 'vitest'
import {
  applyCompositionOps,
  newComposition,
  parseCompositionBody,
  parseMotionBlock,
  parseOps,
  type Composition,
  type CompositionBody,
} from '../shared/motion.ts'
import { frameStateAt, interpolate } from '../shared/motionRuntime.ts'
import { cameraPreset, seededRandom } from '../shared/motionPresets.ts'
import { expandTextAnimator, splitTextUnits, unitOrder, unitSelector } from '../shared/motionText.ts'
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

describe('transitions', () => {
  it('parses a transition on a clip and rejects bad ones', () => {
    const track = {
      id: 'c',
      kind: 'clip' as const,
      clips: [
        {
          id: 'a',
          start: 0,
          duration: 4,
          source: { type: 'frame' as const, frameId: 'f1' },
          transition: { kind: 'dissolve' as const, duration: 0.6, token: '--dur-slower' },
        },
      ],
    }
    const r = parseCompositionBody(body({ tracks: [track] }))
    expect(r.ok).toBe(true)
    expect(r.ok && r.value.tracks[0]!.clips![0]!.transition).toEqual({
      kind: 'dissolve',
      duration: 0.6,
      token: '--dur-slower',
    })
    const bad = (kind: string) =>
      parseCompositionBody(
        body({
          tracks: [
            {
              id: 'c',
              kind: 'clip',
              clips: [
                {
                  id: 'a',
                  start: 0,
                  duration: 4,
                  source: { type: 'frame', frameId: 'f1' },
                  transition: { kind, duration: 1 },
                },
              ],
            },
          ] as never,
        }),
      )
    expect(bad('spin').ok).toBe(false)
    /* 'cut' is the default — a cut transition must not be stored */
    expect(bad('cut').ok).toBe(false)
  })

  it('update_clip sets and clears a transition', () => {
    const c = comp({
      tracks: [
        {
          id: 'c',
          kind: 'clip',
          clips: [{ id: 'a', start: 0, duration: 4, source: { type: 'frame', frameId: 'f1' } }],
        },
      ],
    })
    const set = applyCompositionOps(c, [
      { op: 'update_clip', trackId: 'c', clipId: 'a', transition: { kind: 'push', duration: 1, direction: 'up' } },
    ])
    expect(set.ok).toBe(true)
    expect(set.ok && set.value.tracks[0]!.clips![0]!.transition?.kind).toBe('push')
    const cleared = applyCompositionOps(set.ok ? set.value : c, [
      { op: 'update_clip', trackId: 'c', clipId: 'a', transition: null },
    ])
    expect(cleared.ok && cleared.value.tracks[0]!.clips![0]!.transition).toBeUndefined()
    const ops = parseOps(
      [{ op: 'update_clip', trackId: 'c', clipId: 'a', transition: { kind: 'wipe', duration: 0.5 } }],
      10,
    )
    expect(ops.ok).toBe(true)
  })

  it('frameStateAt pairs the incoming and outgoing clips through the window', () => {
    const c = comp({
      tracks: [
        {
          id: 'shots',
          kind: 'clip',
          clips: [
            { id: 'a', start: 0, duration: 4, source: { type: 'frame', frameId: 'f1' } },
            {
              id: 'b',
              start: 4,
              duration: 4,
              source: { type: 'frame', frameId: 'f2' },
              transition: { kind: 'dissolve', duration: 1 },
            },
          ],
        },
      ],
    })
    /* inside the transition window: both clips active with roles */
    const mid = frameStateAt(c, 4.5)
    const inClip = mid.activeClips.find((a) => a.clip.id === 'b')!
    const outClip = mid.activeClips.find((a) => a.clip.id === 'a')!
    expect(inClip.transition).toEqual({ transition: { kind: 'dissolve', duration: 1 }, role: 'in', u: 0.5 })
    expect(outClip.transition).toEqual({ transition: { kind: 'dissolve', duration: 1 }, role: 'out', u: 0.5 })
    /* before and after the window: a hard-cut-like single clip */
    expect(frameStateAt(c, 6).activeClips.filter((a) => a.transition)).toHaveLength(0)
    expect(frameStateAt(c, 2).activeClips).toHaveLength(1)
    /* a gap means no outgoing partner */
    const gapped = comp({
      tracks: [
        {
          id: 'shots',
          kind: 'clip',
          clips: [
            { id: 'a', start: 0, duration: 2, source: { type: 'frame', frameId: 'f1' } },
            {
              id: 'b',
              start: 5,
              duration: 4,
              source: { type: 'frame', frameId: 'f2' },
              transition: { kind: 'dissolve', duration: 1 },
            },
          ],
        },
      ],
    })
    const st = frameStateAt(gapped, 5.5)
    expect(st.activeClips).toHaveLength(1)
    expect(st.activeClips[0]!.transition?.role).toBe('in')
  })
})

describe('camera presets', () => {
  const from = { x: 500, y: 300, zoom: 1.5, rotation: 0 }
  const frame = { id: 'f1', x: 0, y: 0, width: 800, height: 600 }

  it('push-in zooms and pins every lane', () => {
    const kfs = cameraPreset('push-in', { t: 2, duration: 3, from, amount: 1.4 })
    expect(kfs.filter((k) => k.property === 'zoom')).toEqual([
      expect.objectContaining({ t: 2, value: 1.5 }),
      expect.objectContaining({ t: 5, value: 1.5 * 1.4 }),
    ])
    expect(kfs.filter((k) => k.property === 'x')).toHaveLength(2)
  })

  it('pans a fraction of the frame', () => {
    const kfs = cameraPreset('pan-right', { t: 0, duration: 2, from, frame, amount: 0.5 })
    const xs = kfs.filter((k) => k.property === 'x').map((k) => k.value)
    expect(xs).toEqual([500, 500 + 0.5 * 800])
  })

  it('crash-zoom holds then crashes', () => {
    const kfs = cameraPreset('crash-zoom', { t: 0, duration: 2, from, amount: 2 })
    const zooms = kfs.filter((k) => k.property === 'zoom')
    expect(zooms).toHaveLength(3)
    expect(zooms[0]!.easing.type).toBe('hold')
    expect(zooms[2]!.value).toBe(3)
  })

  it('handheld is seeded: same seed, same jitter; different seed differs', () => {
    const a = cameraPreset('handheld', { t: 0, duration: 4, from, seed: 7, frequency: 4 })
    const b = cameraPreset('handheld', { t: 0, duration: 4, from, seed: 7, frequency: 4 })
    const c = cameraPreset('handheld', { t: 0, duration: 4, from, seed: 8, frequency: 4 })
    expect(a.map((k) => k.value)).toEqual(b.map((k) => k.value))
    expect(a.map((k) => k.value)).not.toEqual(c.map((k) => k.value))
    expect(seededRandom(3)()).toBe(seededRandom(3)())
  })

  it('orbit writes a rotation sweep', () => {
    const kfs = cameraPreset('orbit', { t: 0, duration: 8, from, amount: 180 })
    const rot = kfs.filter((k) => k.property === 'rotation').map((k) => k.value)
    expect(rot).toEqual([0, 180])
  })
})

describe('text animators', () => {
  it('splits text by line, word and char deterministically', () => {
    expect(splitTextUnits('a b\nc', 'line')).toEqual(['a b', 'c'])
    expect(splitTextUnits('a  b c', 'word')).toEqual(['a', 'b', 'c'])
    expect(splitTextUnits('a b', 'char')).toEqual(['a', 'b'])
    expect(splitTextUnits('héllo', 'char')).toHaveLength(5)
  })

  it('orders units forward, from center and by seeded shuffle', () => {
    expect(unitOrder(4, 'forward')).toEqual([0, 1, 2, 3])
    /* seq[i] = the position unit i plays at: the center unit first */
    expect(unitOrder(5, 'center')).toEqual([3, 1, 0, 2, 4])
    const a = unitOrder(10, 'random', 42)
    expect(a).toEqual(unitOrder(10, 'random', 42))
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(a).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('expands a spec into per-unit keyframes on generated targets', () => {
    const { units, keyframes } = expandTextAnimator(
      { el: 'title', split: 'word', preset: 'rise-blur', start: 1, duration: 0.5, stagger: 0.1 },
      'hello brave world',
    )
    expect(units).toEqual(['hello', 'brave', 'world'])
    expect(keyframes.filter((k) => k.el === unitSelector('title', 0) && k.prop === 'opacity')).toEqual([
      expect.objectContaining({ t: 1, value: 0 }),
      expect.objectContaining({ t: 1.5, value: 1 }),
    ])
    /* unit 2 starts one stagger later */
    expect(keyframes.find((k) => k.el === unitSelector('title', 2) && k.prop === 'blur')!.t).toBeCloseTo(1.2)
  })

  it('mask-wipe clip-paths lerp through inset()', () => {
    expect(interpolate('inset(0% 100% 0% 0%)', 'inset(0% 0% 0% 0%)', 0.5)).toBe('inset(0% 50% 0% 0%)')
    /* mismatched units can't lerp — the discrete flip keeps the from-value
       below the midpoint and the to-value after */
    expect(interpolate('inset(0px 100px 0px 0px)', 'inset(0% 0% 0% 0%)', 0.4)).toBe('inset(0px 100px 0px 0px)')
    expect(interpolate('inset(0px 100px 0px 0px)', 'inset(0% 0% 0% 0%)', 0.6)).toBe('inset(0% 0% 0% 0%)')
  })

  it('parses animators inside a motion block and lints the split marker', () => {
    const block = parseMotionBlock(
      JSON.stringify({
        v: 1,
        keyframes: [],
        animators: [{ el: 'title', split: 'word', preset: 'rise-blur', start: 0, duration: 1, stagger: 0.05, seed: 3 }],
      }),
    )
    expect(block?.animators).toHaveLength(1)
    expect(
      parseMotionBlock(
        '{"v":1,"keyframes":[],"animators":[{"el":"x","split":"byte","preset":"rise-blur","start":0,"duration":1,"stagger":0}]}',
      ),
    ).toBeNull()
    /* lint: bad split value flagged, animator without data-doop-split warned */
    expect(lintMotionHtml('<p data-doop-id="t" data-doop-split="byte">hi</p>').some((i) => i.rule === 'MO-12')).toBe(
      true,
    )
    const html = `<p data-doop-id="t">hi</p><script type="application/json" data-doop-motion>{"v":1,"keyframes":[],"animators":[{"el":"t","split":"word","preset":"rise-blur","start":0,"duration":1,"stagger":0.05}]}</script>`
    expect(lintMotionHtml(html).some((i) => i.rule === 'MO-12')).toBe(true)
    const okHtml = html.replace('<p data-doop-id="t">', '<p data-doop-id="t" data-doop-split="word">')
    expect(lintMotionHtml(okHtml).some((i) => i.rule === 'MO-12')).toBe(false)
  })
})

describe('lint additions', () => {
  it('warns when a transition outlives its clip or sits off a clip track', () => {
    const c = comp({
      tracks: [
        {
          id: 'a',
          kind: 'audio',
          clips: [
            {
              id: 'x',
              start: 0,
              duration: 1,
              source: { type: 'asset', assetId: 's1' },
              transition: { kind: 'dissolve', duration: 2 },
            },
          ],
        },
      ],
    })
    const msgs = lintComposition(c).map((i) => i.message)
    expect(msgs.some((m) => m.includes('outlives the clip'))).toBe(true)
    expect(msgs.some((m) => m.includes('transitions pair shots on clip tracks'))).toBe(true)
  })
})
