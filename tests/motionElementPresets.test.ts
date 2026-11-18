/**
 * Element motion presets (motion-elements P0, plan d.1): the 20/20/16
 * catalogue, rest at the boundaries so no preset leaks a pose, seeded
 * determinism, and the stagger distributions apply_element_preset uses.
 */
import { describe, expect, it } from 'vitest'
import type { MotionKeyframe } from '../shared/motion.ts'
import {
  ELEMENT_PRESET_IDS,
  elementPreset,
  elementPresetList,
  elementPresetSpec,
  isElementPreset,
  staggerOffsets,
} from '../shared/motionElementPresets.ts'

const strip = (kfs: MotionKeyframe[]) => kfs.map(({ property, t, value, easing }) => ({ property, t, value, easing }))

/** lanes: property → keyframes sorted by t */
const lanes = (kfs: MotionKeyframe[]) => {
  const m = new Map<string, MotionKeyframe[]>()
  for (const kf of kfs) {
    const lane = m.get(kf.property) ?? []
    lane.push(kf)
    m.set(kf.property, lane)
  }
  for (const lane of m.values()) lane.sort((a, b) => a.t - b.t)
  return m
}

/** the resting value of every property the presets drive */
const REST: Record<string, number | string> = {
  x: 0,
  y: 0,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  skewX: 0,
  skewY: 0,
  opacity: 1,
  blur: 0,
  clipPath: 'inset(0% 0% 0% 0%)',
}

describe('the catalogue', () => {
  it('has 20 entrances, 20 exits and 16 emphasis presets', () => {
    expect(ELEMENT_PRESET_IDS).toHaveLength(56)
    const families = elementPresetList().reduce<Record<string, number>>((acc, p) => {
      acc[p.family] = (acc[p.family] ?? 0) + 1
      return acc
    }, {})
    expect(families).toEqual({ entrance: 20, exit: 20, emphasis: 16 })
    /* every id resolves both ways */
    for (const id of ELEMENT_PRESET_IDS) {
      expect(isElementPreset(id)).toBe(true)
      expect(elementPresetSpec(id)?.id).toBe(id)
    }
    expect(isElementPreset('cartwheel')).toBe(false)
  })

  it('every preset ends at rest (entrances), starts at rest (exits), both (emphasis)', () => {
    for (const spec of elementPresetList()) {
      const kfs = elementPreset(spec.id, { t: 1, duration: 0.8 })
      expect(kfs.length, spec.id).toBeGreaterThan(0)
      for (const [property, lane] of lanes(kfs)) {
        const rest = REST[property]
        expect(rest, `${spec.id} drives ${property} — is it a real prop?`).toBeDefined()
        const first = lane[0]!
        const last = lane[lane.length - 1]!
        if (spec.family === 'entrance' || spec.family === 'emphasis') {
          expect(last.value, `${spec.id} ${property} last`).toBe(rest)
        }
        if (spec.family === 'exit' || spec.family === 'emphasis') {
          expect(first.value, `${spec.id} ${property} first`).toBe(rest)
        }
      }
    }
  })

  it('every keyframe lands inside [t, t+duration]', () => {
    for (const spec of elementPresetList()) {
      const kfs = elementPreset(spec.id, { t: 2, duration: 0.7 })
      for (const kf of kfs) {
        expect(kf.t, `${spec.id} ${kf.property}`).toBeGreaterThanOrEqual(2 - 1e-9)
        expect(kf.t, `${spec.id} ${kf.property}`).toBeLessThanOrEqual(2.7 + 1e-9)
      }
    }
  })
})

describe('determinism', () => {
  it('same seed, same keyframes — and a different seed jitters differently', () => {
    for (const id of ['shake', 'wiggle', 'glitch-in', 'glitch-out'] as const) {
      const a = strip(elementPreset(id, { t: 0, seed: 42 }))
      const b = strip(elementPreset(id, { t: 0, seed: 42 }))
      expect(a, id).toEqual(b)
      const c = strip(elementPreset(id, { t: 0, seed: 43 }))
      expect(c, id).not.toEqual(a)
    }
  })

  it('defaults are stable too', () => {
    const a = strip(elementPreset('wiggle', { t: 0 }))
    const b = strip(elementPreset('wiggle', { t: 0 }))
    expect(a).toEqual(b)
  })

  it('direction steers the travel, distance scales it', () => {
    const left = elementPreset('slide-in', { t: 0, direction: 'left', distance: 100 })
    const right = elementPreset('slide-in', { t: 0, direction: 'right', distance: 100 })
    const lx = lanes(left).get('x')![0]!.value as number
    const rx = lanes(right).get('x')![0]!.value as number
    expect(lx).toBe(-100)
    expect(rx).toBe(100)
    /* degrees work the same: 180 = left */
    const deg = elementPreset('slide-in', { t: 0, direction: 180, distance: 100 })
    expect(lanes(deg).get('x')![0]!.value as number).toBeCloseTo(-100)
  })
})

describe('staggerOffsets', () => {
  const expectOffsets = (got: number[], want: number[]) => {
    expect(got).toHaveLength(want.length)
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 10))
  }

  it('handles the trivial counts', () => {
    expect(staggerOffsets(0)).toEqual([])
    expect(staggerOffsets(1)).toEqual([0])
  })

  it('each spreads starts evenly; amount wins over each', () => {
    expectOffsets(staggerOffsets(4, { each: 0.1 }), [0, 0.1, 0.2, 0.3])
    expectOffsets(staggerOffsets(4, { amount: 0.9 }), [0, 0.3, 0.6, 0.9])
    expectOffsets(staggerOffsets(4, { each: 0.1, amount: 0.9 }), [0, 0.3, 0.6, 0.9])
  })

  it('from picks the lead element', () => {
    expectOffsets(staggerOffsets(4, { each: 0.1, from: 'end' }), [0.3, 0.2, 0.1, 0])
    /* center: the middle leads, the edges trail to the full spread */
    const center = staggerOffsets(5, { each: 0.1, from: 'center' })
    expect(center[2]).toBe(0)
    expect(Math.max(...center)).toBeCloseTo(0.4)
    expect(Math.min(...center)).toBe(0)
    /* edges: the outermost lead */
    const edges = staggerOffsets(5, { each: 0.1, from: 'edges' })
    expect(edges[0]).toBe(0)
    expect(edges[4]).toBe(0.1)
    expect(edges[2]).toBe(Math.max(...edges))
  })

  it('random is a seeded permutation of the offsets', () => {
    const a = staggerOffsets(6, { each: 0.1, from: 'random', seed: 7 })
    const b = staggerOffsets(6, { each: 0.1, from: 'random', seed: 7 })
    expect(a).toEqual(b)
    expect([...a].sort((x, y) => x - y)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5])
    const c = staggerOffsets(6, { each: 0.1, from: 'random', seed: 8 })
    expect(c).not.toEqual(a)
  })

  it('position orders sort by the element coordinate', () => {
    const pos = [
      { x: 300, y: 10 },
      { x: 100, y: 50 },
      { x: 200, y: 30 },
    ]
    expectOffsets(staggerOffsets(3, { each: 0.1, from: 'position-x' }, pos), [0.2, 0, 0.1])
    expectOffsets(staggerOffsets(3, { each: 0.1, from: 'position-y' }, pos), [0, 0.2, 0.1])
    /* grid sorts on x+y: idx1 (150), idx2 (230), idx0 (310) */
    expectOffsets(staggerOffsets(3, { each: 0.1, from: 'grid' }, pos), [0.2, 0, 0.1])
    /* and they refuse without positions */
    expect(() => staggerOffsets(3, { each: 0.1, from: 'position-x' })).toThrow()
    expect(() => staggerOffsets(3, { each: 0.1, from: 'grid' }, pos.slice(0, 2))).toThrow()
  })

  it('an ease reshapes the gaps', () => {
    const linear = staggerOffsets(5, { amount: 1 })
    const eased = staggerOffsets(5, { amount: 1, ease: { type: 'cubic-bezier', x1: 0.7, y1: 0, x2: 0.84, y2: 0 } })
    expectOffsets(linear, [0, 0.25, 0.5, 0.75, 1])
    expect(eased[4]).toBeCloseTo(1)
    expect(eased[2]).not.toBeCloseTo(0.5)
  })
})
