import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomInt } from 'node:crypto'
import type { Frame } from '../shared/types.ts'
import type { TokenUsage } from '../shared/usage.ts'
import { MEASURES, type BriefResult, type FrameScore, type PairVerdict, PAIR_RUBRIC } from './rubric.ts'

export interface QualityBrief {
  id: string
  kind: string
  prompt: string
}
export interface QualityTake {
  frames: { frame: Frame; png: Uint8Array; score: FrameScore }[]
  usage: TokenUsage
  turns: number
}
/** Driver performs a real run on a fresh canvas, then scores with the server
 * checks. No provider is called by the scaffold unless a driver is supplied. */
export interface QualityDriver {
  execute(input: {
    brief: QualityBrief
    mode: 'tools' | 'script'
    tier: string
    repetition: number
  }): Promise<QualityTake>
  judge(input: { first: Uint8Array; second: Uint8Array; rubric: string }): Promise<'first' | 'second' | 'tie'>
}
export async function runQualityBenchmark(input: {
  briefs: QualityBrief[]
  tiers: readonly [string, string]
  output: string
  driver: QualityDriver
}): Promise<{ results: BriefResult[]; pairs: PairVerdict[] }> {
  if (input.briefs.length !== 12 || new Set(input.briefs.map((b) => b.id)).size !== 12)
    throw new Error('benchmark needs 12 distinct briefs')
  if (input.tiers[0] === input.tiers[1]) throw new Error('benchmark needs two distinct tiers')
  await mkdir(input.output, { recursive: true })
  const results: BriefResult[] = [],
    pairs: PairVerdict[] = []
  const blind: { pairId: string; first: string; second: string; modes: string[] }[] = []
  for (const brief of input.briefs)
    for (const [tierIndex, tier] of input.tiers.entries())
      for (let repetition = 0; repetition < 3; repetition++) {
        const takes = {} as Record<'tools' | 'script', QualityTake>
        for (const mode of ['tools', 'script'] as const) {
          const take = await input.driver.execute({ brief, mode, tier, repetition })
          if (!take.frames.length) throw new Error(`no frames for ${brief.id}`)
          for (const { score } of take.frames)
            for (const measure of MEASURES) {
              if (!Number.isFinite(score.measures[measure])) throw new Error(`missing ${measure} for ${brief.id}`)
            }
          takes[mode] = take
          const dir = path.join(input.output, `${brief.id}-${tierIndex}-${repetition}-${mode}`)
          await mkdir(dir, { recursive: true })
          for (const [i, { frame, png, score }] of take.frames.entries()) {
            await writeFile(path.join(dir, `${i}.html`), frame.html)
            await writeFile(path.join(dir, `${i}.png`), png)
            await writeFile(path.join(dir, `${i}.json`), JSON.stringify({ frame, score }))
          }
          await writeFile(path.join(dir, 'usage.json'), JSON.stringify({ usage: take.usage, turns: take.turns }))
          results.push({
            briefId: brief.id,
            kind: brief.kind,
            mode,
            tier,
            repetition,
            frames: take.frames.map((f) => f.score),
          })
        }
        if (takes.tools.frames.length !== takes.script.frames.length)
          throw new Error('paired runs must deliver matching frame counts')
        for (let i = 0; i < takes.tools.frames.length; i++) {
          const pairId = `${brief.id}-${tierIndex}-${repetition}-${i}`
          const order = randomInt(2) ? (['tools', 'script'] as const) : (['script', 'tools'] as const)
          const a = takes[order[0]].frames[i]!.png,
            b = takes[order[1]].frames[i]!.png
          const aName = `${pairId}-a.png`,
            bName = `${pairId}-b.png`
          await writeFile(path.join(input.output, aName), a)
          await writeFile(path.join(input.output, bName), b)
          blind.push({ pairId, first: aName, second: bName, modes: [...order] })
          for (const first of ['tools', 'script'] as const) {
            const second = first === 'tools' ? 'script' : 'tools'
            pairs.push({
              pairId,
              briefId: brief.id,
              first,
              judge: 'vision',
              winner: await input.driver.judge({
                first: takes[first].frames[i]!.png,
                second: takes[second].frames[i]!.png,
                rubric: PAIR_RUBRIC,
              }),
            })
          }
        }
      }
  await writeFile(
    path.join(input.output, 'results.json'),
    JSON.stringify({ date: new Date().toISOString(), results, pairs }, null, 2),
  )
  // Keep the mapping separate from the human ballot. At least 24 ballots are required by the gate.
  await writeFile(path.join(input.output, 'blind-key.json'), JSON.stringify(blind, null, 2))
  await writeFile(
    path.join(input.output, 'human-ballot.json'),
    JSON.stringify(
      blind.slice(0, 24).map(({ pairId, first, second }) => ({ pairId, first, second, winner: null })),
      null,
      2,
    ),
  )
  return { results, pairs }
}
