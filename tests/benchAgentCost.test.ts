import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { replay, report, type Transcript } from '../scripts/bench-agent-cost.ts'
import { gateVerdict, ingestHumanBallot, median, MEASURES } from '../bench/rubric.ts'

const TRANSCRIPTS = path.join(__dirname, '..', 'bench', 'transcripts')
const transcripts = readdirSync(TRANSCRIPTS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(TRANSCRIPTS, f), 'utf8')) as Transcript)

/* AC-2: the three reference jobs replay in both modes and price at the
   model-prices table; the quality scaffold (AC-22/23) scores the gate. */

describe('bench:agent-cost transcripts', () => {
  it('cover the three reference jobs in both modes', () => {
    const jobs = new Set(transcripts.map((t) => t.job))
    expect(jobs).toEqual(new Set(['landing', 'restyle', 'storyboard']))
    for (const job of jobs) {
      const modes = new Set(transcripts.filter((t) => t.job === job).map((t) => t.mode))
      expect(modes).toEqual(new Set(['tools', 'script']))
    }
  })

  it('counts turns and prices every run from the model-prices table', () => {
    for (const t of transcripts) {
      const r = report(t)
      expect(r.turns).toBe(t.turns.length)
      expect(r.cost).toBeGreaterThan(0)
      /* the very first turn writes the cache, reads nothing */
      const first = replay(t).turns[0]!
      expect(first.cacheRead).toBe(0)
      expect(first.cacheWrite).toBeGreaterThan(0)
    }
  })

  it('reads the grown conversation back as cache on later turns', () => {
    const t = transcripts.find((x) => x.job === 'restyle' && x.mode === 'tools')!
    const { turns } = replay(t)
    expect(turns.length).toBeGreaterThan(2)
    for (const turn of turns.slice(1)) expect(turn.cacheRead).toBeGreaterThan(0)
    /* later turns read more — the conversation only grows */
    expect(turns.at(-1)!.cacheRead).toBeGreaterThan(turns[1]!.cacheRead)
  })
})

describe('quality-gate scaffold (AC-22/23)', () => {
  it('passes when medians match and blind pairs go half or better', () => {
    const frame = (errs: string[]) => ({
      frameId: 'f',
      measures: Object.fromEntries(MEASURES.map((m) => [m, 1])),
      errors: errs,
    })
    const tools = [{ briefId: 'b1', kind: 'landing', mode: 'tools' as const, frames: [frame(['A'])] }]
    const script = [{ briefId: 'b1', kind: 'landing', mode: 'script' as const, frames: [frame(['A'])] }]
    const pairs = [
      { briefId: 'b1', first: 'tools' as const, winner: 'tie' as const, judge: 'vision' as const },
      { briefId: 'b1', first: 'script' as const, winner: 'first' as const, judge: 'vision' as const },
    ]
    const humans = Array.from({ length: 24 }, (_, i) => ({ ...pairs[0]!, pairId: String(i), judge: 'human' as const }))
    expect(gateVerdict(tools, script, [...pairs, ...humans]).pass).toBe(true)
  })

  it('fails on worse medians, new errors, or losing the blind pairs', () => {
    const frame = (lint: number, errs: string[] = []) => ({
      frameId: 'f',
      measures: { lint_errors: lint },
      errors: errs,
    })
    const tools = [{ briefId: 'b', kind: 'k', mode: 'tools' as const, frames: [frame(1)] }]
    const script = [{ briefId: 'b', kind: 'k', mode: 'script' as const, frames: [frame(3, ['NEW'])] }]
    const lost = [{ briefId: 'b', first: 'tools' as const, winner: 'first' as const, judge: 'vision' as const }]
    const verdict = gateVerdict(tools, script, lost)
    expect(verdict.pass).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('lint_errors')
    expect(verdict.reasons.join(' ')).toContain('error-level')
    expect(median([frame(3), frame(1), frame(9)], 'lint_errors')).toBe(3)
    expect(MEASURES).toContain('token_coverage')
  })
})

it('fails the gate when measurements or the human sample are missing', () => {
  expect(gateVerdict([], [], []).pass).toBe(false)
})

describe('quality gate: pairs and judging', () => {
  const frame = () => ({ frameId: 'f', measures: Object.fromEntries(MEASURES.map((m) => [m, 1])), errors: [] })
  const tools = [{ briefId: 'b1', kind: 'landing', mode: 'tools' as const, frames: [frame()] }]
  const script = [{ briefId: 'b1', kind: 'landing', mode: 'script' as const, frames: [frame()] }]

  it('matches human votes to the same pair, not just the same brief', () => {
    /* vision says script wins p-one in both orders, ties p-two */
    const vision = [
      { pairId: 'p-one', briefId: 'b1', first: 'tools' as const, winner: 'second' as const, judge: 'vision' as const },
      { pairId: 'p-one', briefId: 'b1', first: 'script' as const, winner: 'first' as const, judge: 'vision' as const },
      { pairId: 'p-two', briefId: 'b1', first: 'tools' as const, winner: 'tie' as const, judge: 'vision' as const },
      { pairId: 'p-two', briefId: 'b1', first: 'script' as const, winner: 'tie' as const, judge: 'vision' as const },
    ]
    /* Bryan picks tools on p-one: same pairId, real disagreement → his 24
       votes decide instead of the model → zero script wins → fail */
    const humans = Array.from({ length: 24 }, () => ({
      pairId: 'p-one',
      briefId: 'b1',
      first: 'tools' as const,
      winner: 'first' as const,
      judge: 'human' as const,
    }))
    expect(gateVerdict(tools, script, [...vision, ...humans]).pass).toBe(false)
    /* Bryan agrees with the model on the same pair → the model's four
       pairs decide → script wins-or-ties all → pass */
    const agreeing = vision.filter((v) => v.pairId !== 'p-one' || v.first === 'tools')
    const aligned = Array.from({ length: 24 }, () => ({
      pairId: 'p-one',
      briefId: 'b1',
      first: 'tools' as const,
      winner: 'second' as const,
      judge: 'human' as const,
    }))
    expect(gateVerdict(tools, script, [...agreeing, ...aligned]).pass).toBe(true)
  })

  it('rejects a judge that gives the same verdict on every pair', () => {
    const flat = Array.from({ length: 24 }, (_, i) => ({
      pairId: `p${i}`,
      briefId: 'b1',
      first: 'tools' as const,
      winner: 'tie' as const,
      judge: 'vision' as const,
    }))
    const verdict = gateVerdict(tools, script, flat)
    expect(verdict.pass).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('degenerate')
  })

  it('resolves a human ballot through the blind key only', () => {
    const blind = [
      { pairId: 'p1', briefId: 'b1', first: 'p1-a.png', second: 'p1-b.png', modes: ['script', 'tools'] },
      { pairId: 'p2', briefId: 'b1', first: 'p2-a.png', second: 'p2-b.png', modes: ['tools', 'script'] },
    ]
    const verdicts = ingestHumanBallot(blind, [
      { pairId: 'p1', winner: 'a' },
      { pairId: 'p2', winner: 'b' },
      { pairId: 'p3', winner: 'a' }, // unknown pair — dropped
      { pairId: 'p1', winner: null }, // blank — dropped
    ])
    expect(verdicts).toEqual([
      { pairId: 'p1', briefId: 'b1', first: 'script', winner: 'first', judge: 'human' },
      { pairId: 'p2', briefId: 'b1', first: 'tools', winner: 'second', judge: 'human' },
    ])
  })
})
