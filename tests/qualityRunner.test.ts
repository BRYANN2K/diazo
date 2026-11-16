import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { runQualityBenchmark, type QualityTake } from '../bench/qualityRunner.ts'
import { MEASURES } from '../bench/rubric.ts'
it('runs twelve briefs three times per mode on two tiers and stores blind ballots', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'diazo-quality-'))
  const { briefs } = JSON.parse(await readFile('bench/briefs.json', 'utf8'))
  const take = {
    frames: [
      {
        frame: { id: 'f', html: '<h1>Fixture</h1>' },
        png: new Uint8Array([1]),
        score: { frameId: 'f', measures: Object.fromEntries(MEASURES.map((m) => [m, 0])), errors: [] },
      },
    ],
    usage: {},
    turns: 1,
  } as unknown as QualityTake
  const execute = vi.fn(async () => take),
    judge = vi.fn(async () => 'tie' as const)
  try {
    const result = await runQualityBenchmark({
      briefs,
      tiers: ['tier-a', 'tier-b'],
      output,
      driver: { execute, judge },
    })
    expect(execute).toHaveBeenCalledTimes(144)
    expect(judge).toHaveBeenCalledTimes(144)
    expect(result.results).toHaveLength(144)
    const ballot = JSON.parse(await readFile(path.join(output, 'human-ballot.json'), 'utf8'))
    expect(ballot).toHaveLength(24)
    expect(JSON.stringify(ballot)).not.toContain('script')
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})
