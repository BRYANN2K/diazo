import fs from 'node:fs'
import path from 'node:path'
import { listBackups } from './backup.ts'
import { acquireDataLock } from './dataLock.ts'
import { resolveLockMode } from './dataLockMode.ts'
import { env } from './env.ts'
import { dataDir } from './paths.ts'
import { restoreBackup } from './restore.ts'

/**
 * The data command line — `bun run data …` in a checkout, `data-tool.mjs`
 * in the embedded bundle. The supported way to list backups and restore
 * one on a stopped install: restore takes the data-dir lock first, so a
 * running server makes it refuse instead of swapping the dir under it.
 *
 * paths.ts loads env.ts, so the tool runs under the install's own
 * environment — on a production install that means the same secrets the
 * server needs, or it exits before doing anything.
 */

const [command, target] = process.argv.slice(2)

function usage(): never {
  console.error('usage: data <backups | restore <archive|latest>>')
  process.exit(2)
}

if (command === 'backups') {
  for (const pair of await listBackups()) {
    const { size } = fs.statSync(pair.archive)
    const { manifest } = pair
    console.log(
      `${pair.stamp}  ${manifest.reason}  ${size} bytes  ${manifest.migrations.count} migrations (newest ${manifest.migrations.newest})`,
    )
  }
} else if (command === 'restore' && target) {
  const lockMode = resolveLockMode()
  if (lockMode !== 'off') {
    try {
      await acquireDataLock(dataDir(), {
        mode: lockMode,
        embedded: !!env.DOOP_EMBEDDED,
        takeoverToken: env.DOOP_DATA_LOCK_TAKEOVER,
      })
    } catch (error) {
      console.error(`[data] ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  }
  try {
    const { restoredFrom, replaced } = await restoreBackup(target)
    console.log(
      `[data] restored ${restoredFrom}${replaced ? ` — the previous data dir moved to ${path.basename(replaced)}` : ''}`,
    )
  } catch (error) {
    console.error(`[data] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
} else {
  usage()
}
