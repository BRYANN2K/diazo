import { describe, expect, it } from 'vitest'
import { runChecksOnPage, walkFocus, type CheckPage } from '../server/frameChecks'
import { FRAME_CHECK_WIDTHS, htmlFingerprint, type FocusStep, type ViewportSnapshot } from '../shared/frameChecks'
import { FOCUS_SETUP_EXPR, FOCUS_STEP_EXPR, VIEWPORT_CHECKS_EXPR } from '../shared/frameChecksCollect'

/* The renderer driver against a fake page: which widths it lays the frame
   out at, how the Tab walk stops, and what reaches the scorer. The real
   collectors run in tests/frameChecksBrowser.test.ts when Chromium exists. */

interface FakeOptions {
  /** the snapshot the viewport collector answers at a width */
  viewport?: (width: number) => Partial<ViewportSnapshot>
  focusables?: { selector: string; tag: string; tabIndex: number }[]
  /** what each Tab press lands on; null = focus left the elements */
  stops?: (FocusStep | null)[]
}

function fakePage(opts: FakeOptions = {}) {
  const log: string[] = []
  let width = 0
  let presses = 0
  const page: CheckPage = {
    setViewport: async (vp) => {
      const size = vp ?? { width: 0, height: 0 }
      width = size.width
      log.push(`viewport ${size.width}x${size.height}`)
    },
    evaluate: (async (expr: unknown) => {
      if (expr === VIEWPORT_CHECKS_EXPR) {
        log.push(`collect ${width}`)
        return { width, clientWidth: width, scrollWidth: width, elements: [], ...opts.viewport?.(width) }
      }
      if (expr === FOCUS_SETUP_EXPR) return opts.focusables ?? []
      if (expr === FOCUS_STEP_EXPR) {
        const stop = opts.stops?.[presses - 1]
        return stop === undefined ? null : stop
      }
      return undefined
    }) as CheckPage['evaluate'],
    keyboard: {
      press: async (key) => {
        presses++
        log.push(`press ${key}`)
      },
    },
  }
  return { page, log, presses: () => presses }
}

function stop(selector: string, over: Partial<FocusStep> = {}): FocusStep {
  return { selector, tag: 'a', rect: { x: 0, y: 0, w: 80, h: 30 }, index: 0, visibleChange: true, ...over }
}

describe('runChecksOnPage', () => {
  it('measures every width in order, then walks the keyboard at desktop width', async () => {
    const { page, log } = fakePage()
    const checks = await runChecksOnPage(page, '<p>x</p>', 7)
    const collected = log.filter((l) => l.startsWith('collect')).map((l) => Number(l.split(' ')[1]))
    expect(collected).toEqual([...FRAME_CHECK_WIDTHS])
    expect(log).toContain('viewport 375x812')
    /* the walk resizes back to desktop before its first Tab press */
    expect(log.slice(-2)).toEqual(['viewport 1440x900', 'press Tab'])
    expect(checks.viewports.map((v) => v.width)).toEqual([375, 768, 1440])
    expect(checks.htmlHash).toBe(htmlFingerprint('<p>x</p>'))
    expect(checks.checkedAt).toBe(7)
    expect(checks.focus).toEqual({ focusables: 0, reached: 0, withoutVisibleFocus: 0 })
  })

  it('scores what the collector found at each width', async () => {
    const { page } = fakePage({
      viewport: (w) =>
        w === 375
          ? {
              scrollWidth: 520,
              elements: [{ selector: '#grid', tag: 'div', rect: { x: 0, y: 0, w: 520, h: 10 }, overflowPx: 145 }],
            }
          : {},
    })
    const checks = await runChecksOnPage(page, '')
    expect(checks.issues.map((i) => [i.ruleId, i.widths])).toEqual([['FC-OVERFLOW', [375]]])
    expect(checks.viewports[0]!.overflowPx).toBe(145)
  })

  it('keeps the responsive result when the keyboard walk throws', async () => {
    const { page } = fakePage()
    page.keyboard.press = async () => {
      throw new Error('target closed')
    }
    const checks = await runChecksOnPage(page, '')
    expect(checks.focus).toBeNull()
    expect(checks.viewports).toHaveLength(3)
  })
})

describe('walkFocus', () => {
  const focusables = [
    { selector: '#a', tag: 'a', tabIndex: 0 },
    { selector: '#b', tag: 'button', tabIndex: 0 },
  ]

  it('stops when focus comes back to the start', async () => {
    const { page, presses } = fakePage({ focusables, stops: [stop('#a'), stop('#b', { index: 1 }), null] })
    const audit = await walkFocus(page)
    expect(audit.steps.map((s) => s.selector)).toEqual(['#a', '#b'])
    expect(audit.wrapped).toBe(true)
    expect(presses()).toBe(3)
  })

  it('caps the walk a few presses past the focusable count', async () => {
    const endless = Array.from({ length: 50 }, (_, i) => stop(`#x${i}`))
    const { page, presses } = fakePage({ focusables, stops: endless })
    const audit = await walkFocus(page)
    expect(presses()).toBe(focusables.length + 5)
    expect(audit.wrapped).toBe(false)
  })

  it('treats a page with nothing to focus as fully walked', async () => {
    const { page } = fakePage({ focusables: [], stops: [] })
    const audit = await walkFocus(page)
    expect(audit.steps).toEqual([])
    expect(audit.wrapped).toBe(true)
  })
})
