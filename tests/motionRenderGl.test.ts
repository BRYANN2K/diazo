/**
 * The renderer's GL backend split (motion-elements P0, AC-8): a film
 * without promoted element layers launches the legacy browser — no
 * GL flags, byte-identical output. A film with layers uses the
 * configured RENDER_GL backend.
 */
import { describe, expect, it } from 'vitest'
import { glArgs, glForComposition } from '../server/screenshot.ts'
import { newComposition, type MotionTrack } from '../shared/motion.ts'

const comp = (tracks: MotionTrack[] = []) =>
  newComposition({
    canvasId: 'c1',
    pageId: 'p1',
    body: { duration: 10, fps: 30, width: 1000, height: 500, tracks },
    updatedBy: 'test',
    now: 1000,
  })

const FX = { id: 'e1', fx: 'glow', params: {} }

describe('glForComposition — the backend a film gets', () => {
  it('a film without layers renders on the legacy backend', () => {
    expect(glForComposition(comp())).toBe('legacy')
    expect(
      glForComposition(
        comp([
          { id: 'cam', kind: 'camera', keyframes: [] },
          { id: 'e', kind: 'element', frameId: 'f1', elementId: 'hero' },
        ]),
      ),
    ).toBe('legacy')
    /* effect-carrying SCENE tracks are not element layers — the camera
       track's stack draws on the scene pass that always ran */
    expect(glForComposition(comp([{ id: 'cam', kind: 'camera', effects: [FX] }]))).toBe('legacy')
  })

  it('a film with a promoted element layer takes the configured GL backend', () => {
    const layered = comp([{ id: 'e', kind: 'element', frameId: 'f1', elementId: 'hero', effects: [FX] }])
    expect(glForComposition(layered)).not.toBe('legacy')
    /* muted and mode-off tracks draw no layer — back to legacy */
    const muted = comp([{ id: 'e', kind: 'element', frameId: 'f1', elementId: 'hero', effects: [FX], muted: true }])
    expect(glForComposition(muted)).toBe('legacy')
    const off = comp([
      { id: 'e', kind: 'element', frameId: 'f1', elementId: 'hero', effects: [FX], layer: { mode: 'off' } },
    ])
    expect(glForComposition(off)).toBe('legacy')
  })
})

describe('glArgs — the flags each backend launches with', () => {
  it('legacy adds no GL flags — the pre-P0 Chromium configuration', () => {
    expect(glArgs('legacy')).toEqual([])
    expect(glArgs('gpu')).toEqual([])
  })
  it('swiftshader forces the deterministic software raster', () => {
    expect(glArgs('swiftshader')).toContain('--use-angle=swiftshader')
    expect(glArgs('swiftshader')).toContain('--enable-unsafe-swiftshader')
  })
  it('off disables the 3D apis', () => {
    expect(glArgs('off')).toEqual(['--disable-3d-apis'])
  })
})
