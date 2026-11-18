import { describe, expect, it } from 'vitest'
import { frameStateAt, type Composition, type MotionKeyframe } from '../src/lib/motion/contract'
import { frameMotionCss } from '../src/lib/motion/elementCss'
import { htmlAt, isScene } from '../src/lib/motion/compositor'

const comp: Composition = {
  id: 'c1',
  canvasId: 'cv',
  pageId: 'p1',
  duration: 4,
  fps: 30,
  width: 1920,
  height: 1080,
  tracks: [
    {
      id: 'e1',
      kind: 'element',
      frameId: 'f1',
      elementId: 'hero',
      keyframes: [
        { id: 'a', property: 'opacity', t: 0, value: 0, easing: { type: 'linear' } },
        { id: 'b', property: 'opacity', t: 2, value: 1, easing: { type: 'linear' } },
        { id: 'c', property: 'y', t: 0, value: 40, easing: { type: 'linear' } },
        { id: 'd', property: 'y', t: 2, value: 0, easing: { type: 'linear' } },
      ],
    },
  ],
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'Bryan',
}

describe('element tracks as frame CSS', () => {
  it('writes the resolved values onto the element by its data-doop-id', () => {
    const css = frameMotionCss(frameStateAt(comp, 1), 'f1')
    expect(css).toContain('[data-doop-id="hero"]')
    expect(css).toContain('opacity: 0.5 !important')
    expect(css).toContain('translate: 0px 20px !important')
  })

  it('leaves frames no track touches alone', () => {
    expect(frameMotionCss(frameStateAt(comp, 1), 'f2')).toBe('')
  })

  it('writes the film time and the CSS into a frame document', () => {
    const html = htmlAt('<html><head><title>x</title></head><body></body></html>', 'p{color:red}', 1.5)
    expect(html).toContain('<style data-doop-motion>:root{--t:1.5}\np{color:red}</style></head>')
    expect(isScene('<main data-doop-scene data-duration="4">')).toBe(true)
    expect(isScene('<main>')).toBe(false)
  })
})

describe('wipe presets and numeric-string coercion', () => {
  const clipKf = (id: string, t: number, value: string, preset?: string): MotionKeyframe => ({
    id,
    property: 'clipPath',
    t,
    value,
    easing: { type: 'linear' },
    ...(preset !== undefined ? { preset } : {}),
  })
  const clipTrack = (keyframes: MotionKeyframe[]) => ({
    id: 'e1',
    kind: 'element' as const,
    frameId: 'f1',
    elementId: 'hero',
    keyframes,
  })
  const withClip = {
    ...comp,
    tracks: [
      clipTrack([clipKf('w1', 0, 'inset(0% 100% 0% 0%)', 'wipe-in'), clipKf('w2', 2, 'inset(0% 0% 0% 0%)', 'wipe-in')]),
    ],
  }

  it('a preset-authored clipPath lane serialises as clip-path — the wipe presets draw', () => {
    const css = frameMotionCss(frameStateAt(withClip, 0), 'f1')
    expect(css).toContain('clip-path: inset(0% 100% 0% 0%) !important')
  })

  it('a stored legacy clipPath lane stays raster-inert — the film is byte-identical (AC-8)', () => {
    /* the reviewer's probe: a film authored before clip-path drew carries
       a lane the parser accepted but never rendered — the CSS it produces
       must be the same bytes as the film without the lane */
    const legacy = {
      ...comp,
      tracks: [
        clipTrack([
          { id: 'x1', property: 'x', t: 0, value: 12, easing: { type: 'linear' } as const },
          clipKf('w1', 0, 'inset(0% 100% 0% 0%)'),
          clipKf('w2', 2, 'inset(0% 0% 0% 0%)'),
        ]),
      ],
    }
    const withoutLane = {
      ...legacy,
      tracks: [clipTrack([{ id: 'x1', property: 'x', t: 0, value: 12, easing: { type: 'linear' } as const }])],
    }
    for (const t of [0, 1, 2, 4]) {
      const css = frameMotionCss(frameStateAt(legacy, t), 'f1')
      expect(css).not.toContain('clip-path')
      expect(css).toBe(frameMotionCss(frameStateAt(withoutLane, t), 'f1'))
    }
  })

  it('a frame-authored clipPath lane stays inert too', () => {
    const block = new Map([['f1', [{ el: 'hero', prop: 'clipPath', t: 0, value: 'inset(0% 100% 0% 0%)' }] as const]])
    const css = frameMotionCss(frameStateAt(comp, 0, { frameBlocks: block }), 'f1')
    expect(css).not.toContain('clip-path')
  })

  it('unmarked keys in a preset lane do not draw — only the marked sublane does', () => {
    const mixed = {
      ...comp,
      tracks: [
        clipTrack([
          clipKf('w0', 0, 'inset(0% 0% 0% 100%)'),
          clipKf('w1', 1, 'inset(0% 100% 0% 0%)', 'wipe-in'),
          clipKf('w2', 2, 'inset(0% 0% 0% 0%)', 'wipe-in'),
        ]),
      ],
    }
    /* the marked sublane holds its first value before t=1 — the unmarked
       head's inset(… 100%) never reaches the raster */
    const early = frameMotionCss(frameStateAt(mixed, 0.5), 'f1')
    expect(early).toContain('clip-path: inset(0% 100% 0% 0%) !important')
    expect(early).not.toContain('0% 0% 0% 100%')
    const css = frameMotionCss(frameStateAt(mixed, 1.5), 'f1')
    expect(css).toContain('clip-path: inset(0% 50% 0% 0%) !important')
  })

  it('numeric strings coerce like numbers — "0.5" writes 0.5', () => {
    const c = {
      ...comp,
      tracks: [
        {
          id: 'e1',
          kind: 'element' as const,
          frameId: 'f1',
          elementId: 'hero',
          keyframes: [
            {
              id: 'a',
              property: 'opacity',
              t: 0,
              value: '0.5' as unknown as number,
              easing: { type: 'hold' } as const,
            },
          ],
        },
      ],
    }
    const css = frameMotionCss(frameStateAt(c, 0), 'f1')
    expect(css).toContain('opacity: 0.5 !important')
  })
})
