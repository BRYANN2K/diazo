import { describe, expect, it } from 'vitest'
import { verdictReveal, verdictTone } from '../src/lib/frameBadges'

/* The verdict badge next to a frame's name (Frame checks frame): a clean
   verdict is a green tick that stays; issues stay out of sight and out of
   the title row until the frame is hovered, focused or selected. */

describe('verdictTone', () => {
  it('is ok for a clean verdict', () => {
    expect(verdictTone(0, 0)).toBe('ok')
  })

  it('is caution for warnings alone', () => {
    expect(verdictTone(3, 0)).toBe('caution')
  })

  it('is danger as soon as one error is among the issues', () => {
    expect(verdictTone(3, 1)).toBe('danger')
    expect(verdictTone(1, 1)).toBe('danger')
  })
})

describe('verdictReveal', () => {
  it('always shows a clean verdict', () => {
    expect(verdictReveal(0)).toBe('')
  })

  it('takes a verdict with issues out of the row at rest, keeping it for screen readers', () => {
    const classes = verdictReveal(2).split(' ')
    expect(classes).toContain('sr-only')
    expect(classes).toContain('opacity-0')
    /* never a bare opacity hide: that kept the badge's width and cut the name */
    expect(classes).not.toContain('invisible')
  })

  it('brings it back on hover, focus and selection', () => {
    const classes = verdictReveal(2).split(' ')
    for (const state of ['group-hover', 'group-focus-within', 'group-data-[selected]']) {
      expect(classes).toContain(`${state}:not-sr-only`)
      expect(classes).toContain(`${state}:opacity-100`)
    }
  })
})
