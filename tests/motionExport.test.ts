/**
 * The phase-2 deliverable (AC-3): a composition's keyframes, transitions
 * and text animators export as pasteable CSS + WAAPI with token names kept.
 */
import { describe, expect, it } from 'vitest'
import { newComposition, type Composition, type CompositionBody } from '../shared/motion.ts'
import { exportCompositionCode, easingCss } from '../shared/motionExport.ts'

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

const file = (out: ReturnType<typeof exportCompositionCode>, name: string) =>
  out.files.find((f) => f.name === name)!.content

describe('easingCss', () => {
  it('emits css easings, keeps token names and samples springs to linear()', () => {
    expect(easingCss({ type: 'linear' })).toBe('linear')
    expect(easingCss({ type: 'hold' })).toBe('steps(1)')
    expect(easingCss({ type: 'steps', steps: 4 })).toBe('steps(4, jump-end)')
    expect(easingCss({ type: 'cubic-bezier', x1: 0.2, y1: 0.8, x2: 0.2, y2: 1 })).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)')
    expect(easingCss({ type: 'token', name: '--ease-out' })).toBe('var(--ease-out)')
    const spring = easingCss({ type: 'spring', stiffness: 180, damping: 26, mass: 1 })
    expect(spring.startsWith('linear(')).toBe(true)
    expect(spring).toContain('%')
  })
})

describe('exportCompositionCode', () => {
  const c = comp({
    tracks: [
      {
        id: 'cam',
        kind: 'camera',
        keyframes: [
          { id: 'x', property: 'x', t: 0, value: 0, easing: { type: 'linear' } },
          {
            id: 'x2',
            property: 'x',
            t: 10,
            value: 400,
            easing: { type: 'cubic-bezier', x1: 0.4, y1: 0, x2: 0.2, y2: 1 },
          },
        ],
      },
      {
        id: 'el',
        kind: 'element',
        frameId: 'f1',
        elementId: 'hero',
        keyframes: [
          { id: 'o1', property: 'opacity', t: 0, value: 0, easing: { type: 'token', name: '--ease-spring' } },
          { id: 'o2', property: 'opacity', t: 2, value: 1, easing: { type: 'linear' } },
          { id: 'y1', property: 'y', t: 0, value: 40, easing: { type: 'linear' } },
          { id: 'y2', property: 'y', t: 2, value: 0, easing: { type: 'hold' } },
        ],
      },
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
            transition: { kind: 'dissolve', duration: 0.6, token: '--dur-slower' },
          },
        ],
      },
    ],
  })

  it('emits css keyframes on the film clock with transform composition', () => {
    const css = file(exportCompositionCode(c), 'composition.css')
    expect(css).toContain('animation: anim_f1_hero 10s linear both paused')
    expect(css).toContain('0% { opacity: 0; transform: translate(0px, 40px)')
    expect(css).toContain('20% { opacity: 1; transform: none')
    /* the token easing is kept by name at its stop */
    expect(css).toContain('animation-timing-function: var(--ease-spring)')
  })

  it('emits waapi blocks with offsets, the camera and transition notes', () => {
    const js = file(exportCompositionCode(c), 'composition.js')
    expect(js).toContain('document.querySelector("[data-frame=\\"f1\\"] [data-doop-id=\\"hero\\"]")')
    expect(js).toContain('{ "offset": 0, "opacity": "0", "transform": "translate(0px, 40px)" }')
    expect(js).toContain('[data-doop-world]')
    expect(js).toContain('translate(0px, 0px) scale(1) rotate(0deg)')
    expect(js).toContain('translate(-400px, 0px) scale(1) rotate(0deg)')
    expect(js).toContain('dissolve')
    expect(js).toContain('--dur-slower')
  })

  it('collects every token name used', () => {
    const out = exportCompositionCode(c)
    expect(out.tokens).toEqual(['--dur-slower', '--ease-spring'])
  })

  it('expands text animators onto unit targets', () => {
    const out = exportCompositionCode(c, {
      frameBlocks: new Map([
        [
          'f1',
          {
            animators: [{ el: 'title', split: 'word', preset: 'rise-blur', start: 0, duration: 0.4, stagger: 0.05 }],
          },
        ],
      ]),
      frameTexts: new Map([['f1', new Map([['title', 'hello there']])]]),
    })
    const css = file(out, 'composition.css')
    expect(css).toContain('[data-doop-unit="0"]')
    expect(css).toContain('blur(0px)')
  })
})
