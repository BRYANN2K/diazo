import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DURATION, SPRING, exitDuration, staggerDelay } from '../src/lib/motion'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

describe('motion tokens', () => {
  it('keeps the script durations in step with the CSS custom properties', () => {
    for (const [name, ms] of Object.entries(DURATION)) {
      expect(css).toContain(`--dur-${name}: ${ms}ms;`)
    }
  })

  it('keeps each spring and its duration in step with the CSS', () => {
    for (const [name, spring] of Object.entries(SPRING)) {
      expect(css).toContain(`--dur-spring-${name}: ${spring.duration}ms;`)
      const points = /linear\(([^)]*)\)/.exec(spring.easing)?.[1] ?? ''
      const block = new RegExp(`--spring-${name}: linear\\(([^)]*)\\)`).exec(css)?.[1] ?? ''
      expect(block.replace(/\s+/g, '')).toBe(points.replace(/\s+/g, ''))
    }
  })

  it('exits at 70% of the enter time', () => {
    expect(exitDuration(200)).toBe(140)
    expect(exitDuration(400)).toBe(280)
  })

  it('staggers the first eight items 30ms apart and holds the rest', () => {
    expect([0, 1, 7, 8, 20].map(staggerDelay)).toEqual([0, 30, 210, 210, 210])
    expect(staggerDelay(-3)).toBe(0)
  })
})
