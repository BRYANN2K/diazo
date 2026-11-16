import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { runQualityBenchmark, type QualityDriver } from '../bench/qualityRunner.ts'

const [driverPath, output, firstTier, secondTier] = process.argv.slice(2)
if (!driverPath || !output || !firstTier || !secondTier) {
  throw new Error(
    'usage: bun run bench:agent-quality <driver.ts> <output-directory> <tier-a> <tier-b>; the driver executes real runs and must export driver',
  )
}
const { driver } = (await import(pathToFileURL(path.resolve(driverPath)).href)) as { driver: QualityDriver }
const { briefs } = JSON.parse(await readFile(new URL('../bench/briefs.json', import.meta.url), 'utf8'))
await runQualityBenchmark({ briefs, tiers: [firstTier, secondTier], output, driver })
