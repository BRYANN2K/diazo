/**
 * Fixture for tests/dataLock.test.ts and tests/dataLockContainers.test.ts —
 * not a test itself. One JSON argument carries every option:
 *
 *   tsx tests/fixtures/dataLockHelper.ts '{"dir":"…","mode":"strict",…}'
 *
 * Prints `holding=<epoch>` once the lock is ours (synchronously, so a
 * blocked main thread cannot swallow it) and stays. A DataDirInUseError
 * prints `refused=<reason> [claimId]` and exits 2; anything else exits 1.
 *
 * Options: dir (required), mode, embedded, takeoverToken, identity,
 * kernelLock, beatMs, observeMs, and the fixture's own seams:
 *   stopAt: 'beforeKernelLock'|'beforeClaimCreate' — that hook SIGSTOPs
 *           the process once (the test resumes it)
 *   spinMs: after holding, block the main thread this long — the beat is
 *           the worker's, never the event loop's
 *   stopFile: poll for it every 100 ms and exit 0 when it appears — the
 *           clean-exit path (released-<N>) that works under every runtime
 *
 * Node built-ins and erasable TypeScript only: plain node runs it (the
 * container test runs it under node:22-slim's type stripping).
 */
import fs from 'node:fs'
import { acquireDataLock, DataDirInUseError } from '../../server/dataLock.ts'
import type { AcquireOptions, LockIdentity } from '../../server/dataLock.ts'

interface FixtureOptions extends AcquireOptions {
  dir: string
  stopAt?: 'beforeKernelLock' | 'beforeClaimCreate'
  spinMs?: number
  stopFile?: string
  identity?: LockIdentity
}

const opts = JSON.parse(process.argv[2] ?? '{}') as FixtureOptions
if (!opts.dir) {
  console.error('usage: dataLockHelper.ts {"dir":"…",…}')
  process.exit(64)
}

/* synchronous writes: a spinning main thread must not hold the line back */
const say = (line: string) => fs.writeSync(1, `${line}\n`)

let stopped = false
const stopOnce = (): Promise<void> => {
  if (stopped) return Promise.resolve()
  stopped = true
  process.kill(process.pid, 'SIGSTOP')
  return Promise.resolve()
}

const { dir, stopAt, spinMs, stopFile, ...acquireOpts } = opts

try {
  const lock = await acquireDataLock(dir, {
    ...acquireOpts,
    hooks: {
      beforeKernelLock: stopAt === 'beforeKernelLock' ? stopOnce : undefined,
      beforeClaimCreate: stopAt === 'beforeClaimCreate' ? stopOnce : undefined,
    },
  })
  say(`holding=${lock.epoch}`)
  if (stopFile) {
    const poller = setInterval(() => {
      if (fs.existsSync(stopFile)) process.exit(0)
    }, 100)
    poller.unref()
  }
  if (spinMs) {
    const end = Date.now() + spinMs
    while (Date.now() < end) {
      /* busy — proof the beat lives in the worker thread */
    }
  }
  setInterval(() => {}, 60_000)
} catch (error) {
  if (error instanceof DataDirInUseError) {
    say(`refused=${error.reason}${error.claimId ? ` ${error.claimId}` : ''}`)
    process.exit(2)
  }
  console.error(error)
  process.exit(1)
}
