// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { lintDocKey } from '../shared/lintDocument'
import { SLOP_RULES_VERSION, type FrameLint } from '../shared/slopRules'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { lintIsCurrent } = await import('../src/lib/frameLint')

/* A stored verdict stands for the document it scored: this HTML at this
   size, with computed styles, under today's rules. Timestamps do not decide
   it, since a local save patches the HTML ahead of the server's updatedAt. */

const doc = { html: '<p>one</p>', width: 1440, height: 900 }

const lint = (over: Partial<FrameLint> = {}): FrameLint => ({
  score: 52,
  errors: 3,
  warnings: 0,
  issues: [],
  checkedAt: 2_000,
  version: SLOP_RULES_VERSION,
  engine: 'dom',
  doc: lintDocKey(doc),
  ...over,
})

describe('lintIsCurrent', () => {
  it('keeps a dom verdict of the document the frame shows', () => {
    expect(lintIsCurrent({ ...doc, lint: lint() })).toBe(true)
  })

  it('scores again once the html changed, whatever the timestamps say', () => {
    expect(lintIsCurrent({ ...doc, html: '<p>two</p>', lint: lint() })).toBe(false)
  })

  it('scores again once the frame was resized', () => {
    expect(lintIsCurrent({ ...doc, width: 320, lint: lint() })).toBe(false)
    expect(lintIsCurrent({ ...doc, height: 2000, lint: lint() })).toBe(false)
  })

  it('scores again a static pass, one under older rules, or one that names no document', () => {
    expect(lintIsCurrent({ ...doc, lint: lint({ engine: 'static' }) })).toBe(false)
    expect(lintIsCurrent({ ...doc, lint: lint({ version: SLOP_RULES_VERSION - 1 }) })).toBe(false)
    expect(lintIsCurrent({ ...doc, lint: lint({ doc: undefined }) })).toBe(false)
  })

  it('scores a frame that has no verdict yet', () => {
    expect(lintIsCurrent(doc)).toBe(false)
  })
})

describe('lintDocKey', () => {
  it('is short and tells documents and sizes apart', () => {
    const key = lintDocKey({ ...doc, html: 'x'.repeat(200_000) })
    expect(key.length).toBeLessThan(40)
    expect(lintDocKey(doc)).toBe(lintDocKey({ ...doc }))
    expect(lintDocKey(doc)).not.toBe(lintDocKey({ ...doc, html: '<p>One</p>' }))
    expect(lintDocKey(doc)).not.toBe(lintDocKey({ ...doc, width: 1439 }))
  })
})
