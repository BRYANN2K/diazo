/**
 * Fixture for tests/dataLock.test.ts — not a test itself.
 * Holds the data lock with a short heartbeat so a takeover is observable
 * inside a test timeout: `tsx tests/fixtures/dataLockHelper.ts <dir> <ms>`.
 * Prints `holding=<pid>` once the lock is ours, then stays put — the test
 * replaces the claim file to see the holder notice and exit loudly. A
 * refused acquire prints `refused=<message>` and exits 2.
 */
import { acquireDataLock } from '../../server/dataLock.ts'

const dir = process.argv[2]
if (!dir) throw new Error('usage: dataLockHelper.ts <dir> <heartbeatMs>')
const heartbeatMs = Number(process.argv[3] ?? '300')
try {
  await acquireDataLock(dir, { heartbeatMs })
} catch (error) {
  console.error(`refused=${(error as Error).message}`)
  process.exit(2)
}
console.log(`holding=${process.pid}`)
setInterval(() => {}, 60_000)
