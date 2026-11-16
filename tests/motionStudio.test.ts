import { describe, expect, it } from 'vitest'
import {
  cameraAt,
  cameraKeyTimes,
  ease,
  laneAt,
  timecode,
  type Composition,
  type MotionKeyframe,
} from '../src/lib/motion/contract'
import { fitCamera } from '../src/lib/motion/compositor'
import { cameraToViewport, viewportToCamera } from '../src/lib/motion/stageCamera'

const key = (property: string, t: number, value: number, easing: MotionKeyframe['easing'] = { type: 'linear' }) => ({
  id: `${property}-${t}`,
  property,
  t,
  value,
  easing,
})

function film(keyframes: MotionKeyframe[]): Composition {
  return {
    id: 'c1',
    canvasId: 'cv',
    pageId: 'p1',
    duration: 10,
    fps: 30,
    width: 1920,
    height: 1080,
    tracks: [{ id: 'cam', kind: 'camera', keyframes }],
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'Bryan',
  }
}

describe('Motion Studio client contract', () => {
  it('holds the endpoints outside the keys and interpolates between them', () => {
    const keys = [key('x', 2, 100), key('x', 4, 300)]
    expect(laneAt(keys, 0)).toBe(100)
    expect(laneAt(keys, 3)).toBe(200)
    expect(laneAt(keys, 9)).toBe(300)
  })

  it('cuts on a hold easing and steps on steps', () => {
    expect(laneAt([key('x', 0, 0, { type: 'hold' }), key('x', 1, 10)], 0.99)).toBe(0)
    expect(ease({ type: 'steps', steps: 4 }, 0.3, 0.3)).toBe(0.25)
  })

  it('eases cubic-bezier and named token curves, and an unknown token linearly', () => {
    const curve = { type: 'cubic-bezier' as const, x1: 0.22, y1: 1, x2: 0.36, y2: 1 }
    expect(ease(curve, 0, 0)).toBeCloseTo(0)
    expect(ease(curve, 1, 1)).toBeCloseTo(1)
    expect(ease(curve, 0.5, 0.5)).toBeGreaterThan(0.5)
    /* a CSS name resolves through the contract's named easings (no stylesheet in node) */
    expect(ease({ type: 'token', name: 'ease-in-out' }, 0.25, 0.25)).toBeLessThan(0.25)
    expect(ease({ type: 'token', name: '--nope' }, 0.3, 0.3)).toBe(0.3)
  })

  it('settles a spring at its target', () => {
    expect(ease({ type: 'spring', stiffness: 180, damping: 26, mass: 1 }, 0.99, 3)).toBeCloseTo(1, 3)
  })

  it('reads the camera at any time, and none without keys', () => {
    const comp = film([key('x', 0, 0), key('y', 0, 0), key('zoom', 0, 1), key('x', 10, 1000), key('zoom', 10, 2)])
    expect(cameraAt(comp, 5)).toEqual({ x: 500, y: 0, zoom: 1.5, rotation: 0 })
    expect(cameraAt(comp, 99)?.x).toBe(1000)
    expect(cameraAt(film([]), 1)).toBeNull()
    expect(cameraKeyTimes(comp)).toEqual([0, 10])
  })

  it('writes a timecode at the film rate', () => {
    expect(timecode(65.5, 30)).toBe('01:05.15')
  })

  it('round-trips the camera through the stage view', () => {
    const comp = film([])
    const box = { width: 1200, height: 800 }
    const camera = { x: 340, y: -120, zoom: 1.75, rotation: 0 }
    const back = viewportToCamera(cameraToViewport(camera, comp, box), comp, box)
    expect(back.x).toBeCloseTo(camera.x)
    expect(back.y).toBeCloseTo(camera.y)
    expect(back.zoom).toBeCloseTo(camera.zoom)
  })

  it('fits every frame of the page in the shot', () => {
    const frame = (x: number, y: number) => ({ id: `${x}`, x, y, width: 400, height: 300 }) as never
    const camera = fitCamera([frame(0, 0), frame(1000, 500)], 1920, 1080, 1)
    expect(camera.x).toBe(700)
    expect(camera.y).toBe(400)
    expect(camera.zoom).toBeCloseTo(Math.min(1920 / 1400, 1080 / 800))
  })
})
