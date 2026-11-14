import { describe, expect, it } from 'vitest'
import {
  FRAME_CHECK_RULES,
  checkFocus,
  checkViewport,
  htmlFingerprint,
  scoreFrameChecks,
  textContrast,
  type CheckElement,
  type FocusAudit,
  type FocusStep,
  type ViewportSnapshot,
} from '../shared/frameChecks'
import { FOCUS_SETUP_EXPR, FOCUS_STEP_EXPR, VIEWPORT_CHECKS_EXPR } from '../shared/frameChecksCollect'

function el(over: Partial<CheckElement>): CheckElement {
  return { selector: 'body > div', tag: 'div', rect: { x: 0, y: 0, w: 100, h: 40 }, ...over }
}

function vp(width: number, elements: CheckElement[], over: Partial<ViewportSnapshot> = {}): ViewportSnapshot {
  return { width, clientWidth: width, scrollWidth: width, elements, ...over }
}

function step(over: Partial<FocusStep>): FocusStep {
  return {
    selector: 'body > a',
    tag: 'a',
    rect: { x: 0, y: 0, w: 80, h: 30 },
    index: 0,
    visibleChange: true,
    ...over,
  }
}

describe('textContrast', () => {
  it('matches the WCAG ratio for opaque colours', () => {
    expect(textContrast('rgb(0, 0, 0)', 'rgb(255, 255, 255)')).toBeCloseTo(21, 1)
    expect(textContrast('rgb(119, 119, 119)', 'rgb(255, 255, 255)')).toBeCloseTo(4.48, 1)
  })

  it('composites translucent text over its backdrop', () => {
    /* black at 30% on white reads as a light grey, well below AA */
    const ratio = textContrast('rgba(0, 0, 0, 0.3)', 'rgb(255, 255, 255)')!
    expect(ratio).toBeLessThan(3)
  })

  it('returns null for colours it cannot parse', () => {
    expect(textContrast('currentColor', 'rgb(255, 255, 255)')).toBeNull()
  })
})

describe('checkViewport', () => {
  it('blames the element that runs past the screen edge', () => {
    const drafts = checkViewport(
      vp(375, [el({ selector: '#hero', overflowPx: 120, label: 'Hero' })], { scrollWidth: 495 }),
    )
    expect(drafts).toHaveLength(1)
    expect(drafts[0]!.ruleId).toBe('FC-OVERFLOW')
    expect(drafts[0]!.message).toContain('120px')
    expect(drafts[0]!.message).toContain('scrolls sideways')
  })

  it('says when body overflow-x:hidden cuts the content off instead', () => {
    const drafts = checkViewport(vp(375, [el({ overflowPx: 40, overflowHidden: true })]))
    expect(drafts[0]!.message).toContain('cut off')
  })

  it('flags a page that scrolls sideways with no element to blame', () => {
    const drafts = checkViewport(vp(375, [], { scrollWidth: 400 }))
    expect(drafts.map((d) => d.ruleId)).toEqual(['FC-OVERFLOW'])
    expect(drafts[0]!.selector).toBeUndefined()
  })

  it('reports clipped text, intentional truncation worded as such', () => {
    const drafts = checkViewport(
      vp(768, [
        el({ selector: '#a', clip: { axis: 'y', hiddenPx: 18, intentional: false } }),
        el({ selector: '#b', clip: { axis: 'x', hiddenPx: 60, intentional: true } }),
      ]),
    )
    expect(drafts.map((d) => d.ruleId)).toEqual(['FC-CLIP', 'FC-CLIP'])
    expect(drafts[0]!.message).toContain('clipped')
    expect(drafts[1]!.message).toContain('truncated')
  })

  it('checks tap targets on touch widths only', () => {
    const small = el({ tag: 'button', tap: { w: 32, h: 32 } })
    expect(checkViewport(vp(375, [small])).map((d) => d.ruleId)).toEqual(['FC-TAP'])
    expect(checkViewport(vp(1440, [small]))).toHaveLength(0)
    expect(checkViewport(vp(375, [el({ tap: { w: 44, h: 48 } })]))).toHaveLength(0)
  })

  it('applies the AA floor, 3:1 for large text', () => {
    const grey = { color: 'rgb(150, 150, 150)', bg: 'rgb(255, 255, 255)', fontWeight: 400 }
    expect(checkViewport(vp(1440, [el({ contrast: { ...grey, fontSizePx: 16 } })]))[0]!.ruleId).toBe('FC-CONTRAST')
    /* grey 128 on white is 3.9:1: enough for large text, not for body text */
    const mid = { color: 'rgb(128, 128, 128)', bg: 'rgb(255, 255, 255)', fontWeight: 400 }
    expect(checkViewport(vp(1440, [el({ contrast: { ...mid, fontSizePx: 28 } })]))).toHaveLength(0)
    expect(checkViewport(vp(1440, [el({ contrast: { ...mid, fontSizePx: 16 } })]))).toHaveLength(1)
  })
})

describe('checkFocus', () => {
  const focusables = [
    { selector: '#a', tag: 'a', tabIndex: 0 },
    { selector: '#b', tag: 'button', tabIndex: 0 },
    { selector: '#c', tag: 'input', tabIndex: 0 },
  ]

  it('flags a stop with no visible focus change, once per element', () => {
    const audit: FocusAudit = {
      focusables,
      steps: [
        step({ selector: '#a' }),
        step({ selector: '#b', visibleChange: false, rect: { x: 100, y: 0, w: 80, h: 30 } }),
      ],
      wrapped: false,
    }
    const { drafts, summary } = checkFocus(audit)
    expect(drafts.map((d) => d.ruleId)).toEqual(['FC-FOCUS-VISIBLE'])
    expect(drafts[0]!.selector).toBe('#b')
    expect(summary).toEqual({ focusables: 3, reached: 2, withoutVisibleFocus: 1 })
  })

  it('flags positive tabindex and a jump back up the page', () => {
    const audit: FocusAudit = {
      focusables: [...focusables, { selector: '#d', tag: 'a', tabIndex: 3 }],
      steps: [
        step({ selector: '#a', rect: { x: 0, y: 400, w: 80, h: 30 } }),
        step({ selector: '#b', rect: { x: 0, y: 100, w: 80, h: 30 } }),
      ],
      wrapped: false,
    }
    const rules = checkFocus(audit).drafts.map((d) => d.ruleId)
    expect(rules).toEqual(['FC-TAB-ORDER', 'FC-TAB-ORDER'])
  })

  it('does not call a move to the next column a jump', () => {
    const audit: FocusAudit = {
      focusables,
      steps: [
        step({ selector: '#a', rect: { x: 0, y: 400, w: 200, h: 30 } }),
        step({ selector: '#b', rect: { x: 300, y: 100, w: 200, h: 30 } }),
      ],
      wrapped: false,
    }
    expect(checkFocus(audit).drafts).toHaveLength(0)
  })

  it('reports focusables Tab never reached once the walk wrapped', () => {
    const audit: FocusAudit = { focusables, steps: [step({ selector: '#a' })], wrapped: true }
    const drafts = checkFocus(audit).drafts
    expect(drafts.map((d) => d.ruleId)).toEqual(['FC-TAB-REACH'])
    expect(drafts[0]!.message).toContain('2 focusable elements')
    /* a walk cut short by the step cap proves nothing about reachability */
    expect(checkFocus({ ...audit, wrapped: false }).drafts).toHaveLength(0)
  })
})

describe('scoreFrameChecks', () => {
  it('merges one element across widths and scores the result', () => {
    const tiny = el({ selector: '#cta', tag: 'button', tap: { w: 30, h: 30 } })
    const wide = el({ selector: '#grid', overflowPx: 200 })
    const checks = scoreFrameChecks({
      viewports: [vp(375, [tiny, wide], { scrollWidth: 575 }), vp(768, [tiny]), vp(1440, [tiny])],
      focus: { focusables: [{ selector: '#cta', tag: 'button', tabIndex: 0 }], steps: [], wrapped: false },
      htmlHash: 'h',
      checkedAt: 5,
    })
    const tap = checks.issues.find((i) => i.ruleId === 'FC-TAP')!
    expect(tap.widths).toEqual([375, 768])
    expect(checks.errors).toBe(1)
    expect(checks.warnings).toBe(1)
    expect(checks.score).toBe(100 - 15 - 4)
    expect(checks.viewports).toEqual([
      { width: 375, overflowPx: 200, issues: 2 },
      { width: 768, overflowPx: 0, issues: 1 },
      { width: 1440, overflowPx: 0, issues: 0 },
    ])
    expect(checks.focus).toEqual({ focusables: 1, reached: 0, withoutVisibleFocus: 0 })
    expect(checks.checkedAt).toBe(5)
  })

  it('caps issues per rule', () => {
    const many = Array.from({ length: 30 }, (_, i) => el({ selector: `#b${i}`, tap: { w: 10, h: 10 } }))
    const checks = scoreFrameChecks({ viewports: [vp(375, many)], focus: null, htmlHash: 'h' })
    expect(checks.issues.length).toBeLessThanOrEqual(8)
    expect(checks.focus).toBeNull()
  })

  it('gives every rule a known severity', () => {
    for (const r of FRAME_CHECK_RULES) expect(['error', 'warning']).toContain(r.severity)
  })
})

describe('htmlFingerprint', () => {
  it('is stable and changes with the document', () => {
    expect(htmlFingerprint('<p>a</p>')).toBe(htmlFingerprint('<p>a</p>'))
    expect(htmlFingerprint('<p>a</p>')).not.toBe(htmlFingerprint('<p>b</p>'))
  })
})

describe('collector sources', () => {
  it('parse as plain scripts', () => {
    /* the renderer evaluates them as expressions; a syntax slip would only
       surface on a live render otherwise */
    for (const expr of [VIEWPORT_CHECKS_EXPR, FOCUS_SETUP_EXPR, FOCUS_STEP_EXPR]) {
      expect(() => new Function(expr)).not.toThrow()
    }
  })
})
