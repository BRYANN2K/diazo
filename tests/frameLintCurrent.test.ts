// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { SLOP_RULES_VERSION, type FrameLint } from '../shared/slopRules'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { lintIsCurrent } = await import('../src/lib/frameLint')

/* Opening a canvas re-scores only what moved on: a stored verdict taken with
   computed styles, under today's rules, after the frame's last change, stands. */

const lint = (over: Partial<FrameLint> = {}): FrameLint => ({
  score: 52,
  errors: 3,
  warnings: 0,
  issues: [],
  checkedAt: 2_000,
  version: SLOP_RULES_VERSION,
  engine: 'dom',
  ...over,
})

describe('lintIsCurrent', () => {
  it('keeps a dom verdict taken after the last change', () => {
    expect(lintIsCurrent({ lint: lint(), updatedAt: 1_000 })).toBe(true)
    expect(lintIsCurrent({ lint: lint(), updatedAt: 2_000 })).toBe(true)
  })

  it('scores again once the frame changed after the verdict', () => {
    expect(lintIsCurrent({ lint: lint(), updatedAt: 3_000 })).toBe(false)
  })

  it('scores again a static pass or one under older rules', () => {
    expect(lintIsCurrent({ lint: lint({ engine: 'static' }), updatedAt: 1_000 })).toBe(false)
    expect(lintIsCurrent({ lint: lint({ version: SLOP_RULES_VERSION - 1 }), updatedAt: 1_000 })).toBe(false)
  })

  it('scores a frame that has no verdict yet', () => {
    expect(lintIsCurrent({ updatedAt: 1_000 })).toBe(false)
  })
})
