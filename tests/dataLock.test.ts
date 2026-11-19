import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataLock, DataDirInUseError, type RefusalReason } from '../server/dataLock.ts'

/**
 * server/dataLock.ts: one server per data dir, enforced by a kernel-held
 * lock through node:sqlite (`lock/kernel.lock`, an fcntl/LockFileEx the
 * kernel drops when the process dies however it dies) plus claim epochs
 * (`lock/claim-N.json` created wx, `beat-N` rewritten by a worker thread,
 * `released-N` on clean exit) for the cross-kernel case the kernel lock
 * cannot see. Real child processes hold the locks — a pid, a signal or a
 * second opener is the subject.
 */

const ROOT = process.cwd()
const HELPER = path.join(ROOT, 'tests', 'fixtures', 'dataLockHelper.ts')
const BEAT = 100
const OBSERVE = 600

interface FixtureOpts {
  dir: string
  mode?: 'strict' | 'takeover'
  embedded?: boolean
  takeoverToken?: string
  identity?: { kernel: string; machine?: string }
  kernelLock?: boolean
  beatMs?: number
  observeMs?: number
  stopAt?: 'beforeKernelLock' | 'beforeClaimCreate'
  spinMs?: number
  stopFile?: string
}

interface Helper {
  child: ChildProcess
  out: () => string
  err: () => string
}

/* spawn the holder as ONE node process — `--import tsx` loads the .ts
   helper in-process, so the child's pid is the lock's owner and a
   SIGKILL really kills the holder (a `tsx` wrapper would fork) */
function spawnHelper(opts: FixtureOpts): Helper {
  const child = spawn(process.execPath, ['--import', 'tsx', HELPER, JSON.stringify(opts)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()))
  children.push(child)
  return { child, out: () => out, err: () => err }
}

const dirs: string[] = []
const held: { release(): void }[] = []
const children: ChildProcess[] = []

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'))
  dirs.push(dir)
  return dir
}

const lockDir = (dir: string) => path.join(fs.realpathSync(dir), 'lock')
const claimFile = (dir: string, n: number) => path.join(lockDir(dir), `claim-${n}.json`)
const beatFile = (dir: string, n: number) => path.join(lockDir(dir), `beat-${n}`)

function waitHolding(helper: Helper, ms = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never held: ${helper.out()} ${helper.err()}`)), ms)
    const check = () => {
      const match = /holding=(\d+)/.exec(helper.out())
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    helper.child.stdout!.on('data', check)
    helper.child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`exited ${code}: ${helper.out()} ${helper.err()}`))
    })
    check()
  })
}

function waitExit(child: ChildProcess, ms = 15_000): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), ms)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

interface Outcome {
  holding: boolean
  refused: string | null
  code: number | null
  out: string
  err: string
}

/** Resolves when the helper holds (still running) or exits. */
function waitOutcome(helper: Helper, ms = 45_000): Promise<Outcome> {
  return new Promise((resolve) => {
    let done = false
    const finish = (partial: Partial<Outcome> & Pick<Outcome, 'holding' | 'refused'>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        holding: partial.holding,
        refused: partial.refused,
        code: partial.code ?? null,
        out: helper.out(),
        err: helper.err(),
      })
    }
    const timer = setTimeout(() => finish({ holding: false, refused: 'timeout' }), ms)
    helper.child.stdout!.on('data', () => {
      const out = helper.out()
      if (/holding=\d+/.test(out)) finish({ holding: true, refused: null })
      const refused = /refused=(\S+)/.exec(out)
      if (refused) finish({ holding: false, refused: refused[1] ?? '' })
    })
    helper.child.once('exit', (code) => {
      const refused = /refused=(\S+)/.exec(helper.out())
      finish({ holding: false, refused: refused?.[1] ?? null, code })
    })
  })
}

async function expectRefusal(promise: Promise<unknown>, reason: RefusalReason): Promise<DataDirInUseError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(DataDirInUseError)
    const refusal = error as DataDirInUseError
    expect(refusal.reason).toBe(reason)
    return refusal
  }
  throw new Error(`expected a ${reason} refusal`)
}

const kernelB = { kernel: 'test-kernel-b', machine: 'test-machine-b' }
const foreignOpts = { kernelLock: false as const, identity: kernelB, beatMs: BEAT, observeMs: OBSERVE }

afterEach(() => {
  for (const lock of held.splice(0)) lock.release()
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGCONT')
    } catch {
      /* already gone */
    }
    child.kill('SIGKILL')
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('server/dataLock.ts', () => {
  /* AC-1: a live holder — suspended or not — is refused, undisturbed */
  it.skipIf(process.platform === 'win32')(
    'refuses a second process while the holder lives, even SIGSTOPped',
    async () => {
      const dir = tmpdir()
      const holder = spawnHelper({ dir, mode: 'strict', beatMs: BEAT, observeMs: OBSERVE })
      await waitHolding(holder)
      const claimBefore = fs.readFileSync(claimFile(dir, 1), 'utf8')

      await expectRefusal(acquireDataLock(dir, { mode: 'strict', observeMs: OBSERVE }), 'held')

      holder.child.kill('SIGSTOP')
      try {
        await new Promise((r) => setTimeout(r, OBSERVE + 400))
        await expectRefusal(acquireDataLock(dir, { mode: 'strict', observeMs: OBSERVE }), 'held')
        expect(fs.readFileSync(claimFile(dir, 1), 'utf8')).toBe(claimBefore)
      } finally {
        holder.child.kill('SIGCONT')
      }
    },
    45_000,
  )

  it('refuses a second acquire in this process', async () => {
    const dir = tmpdir()
    held.push(await acquireDataLock(dir, { mode: 'strict' }))
    await expectRefusal(acquireDataLock(dir, { mode: 'strict' }), 'held')
  })

  /* AC-2: kill -9 frees the dir at once; pid and host decide nothing */
  it('acquires at once after kill -9 of the holder', async () => {
    const dir = tmpdir()
    const holder = spawnHelper({ dir, mode: 'strict', beatMs: BEAT, observeMs: OBSERVE })
    await waitHolding(holder)
    const gone = waitExit(holder.child)
    holder.child.kill('SIGKILL')
    await gone

    const started = performance.now()
    held.push(await acquireDataLock(dir, { mode: 'strict' }))
    expect(performance.now() - started).toBeLessThan(1_000)
  }, 45_000)

  /* AC-3: N boots at once on a dead holder's dir — exactly one wins */
  it('exactly one of eight simultaneous boots wins, ten rounds', async () => {
    const dir = tmpdir()
    /* a dead holder's leftover claim is what every round starts from:
       kill the winner after each round leaves it behind */
    for (let round = 0; round < 10; round++) {
      const batch = Array.from({ length: 8 }, () =>
        spawnHelper({ dir, mode: 'strict', beatMs: BEAT, observeMs: OBSERVE }),
      )
      const outcomes = await Promise.all(batch.map((h) => waitOutcome(h)))
      const winners = outcomes.filter((o) => o.holding)
      expect(
        winners,
        `round ${round}: ${outcomes.map((o) => `${o.holding ? 'held' : o.refused}`).join(',')}`,
      ).toHaveLength(1)
      const winner = batch[outcomes.findIndex((o) => o.holding)]!
      const gone = waitExit(winner.child)
      winner.child.kill('SIGKILL')
      await gone
    }
  }, 240_000)

  /* AC-4: suspended before the kernel lock — resumed after another won: refused */
  it.skipIf(process.platform === 'win32')(
    'a contender suspended before the kernel lock is refused after another won',
    async () => {
      const dir = tmpdir()
      const contender = spawnHelper({
        dir,
        mode: 'strict',
        stopAt: 'beforeKernelLock',
        beatMs: BEAT,
        observeMs: OBSERVE,
      })
      await new Promise((r) => setTimeout(r, 700))
      const winner = spawnHelper({ dir, mode: 'strict', beatMs: BEAT, observeMs: OBSERVE })
      await waitHolding(winner)
      const outcome = waitOutcome(contender)
      /* SIGCONT may land before the child's own SIGSTOP — keep resuming */
      const resume = setInterval(() => {
        try {
          contender.child.kill('SIGCONT')
        } catch {
          /* gone */
        }
      }, 100)
      const result = await outcome
      clearInterval(resume)
      expect(result.holding).toBe(false)
      expect(result.refused).toBe('held')
    },
    60_000,
  )

  /* AC-5: two kernels, no shared kernel lock — a beating foreign owner refuses */
  it('refuses a foreign claim whose owner keeps beating (two-kernel simulation)', async () => {
    const dir = tmpdir()
    const holder = spawnHelper({
      dir,
      mode: 'strict',
      kernelLock: false,
      identity: { kernel: 'test-kernel-a', machine: 'test-machine-a' },
      beatMs: BEAT,
      observeMs: OBSERVE,
    })
    await waitHolding(holder)
    await expectRefusal(acquireDataLock(dir, { mode: 'strict', ...foreignOpts }), 'alive-elsewhere')
  }, 45_000)

  it.skipIf(process.platform === 'win32')(
    'still refuses while the foreign owner spins its main thread — the beat is the worker’s',
    async () => {
      const dir = tmpdir()
      const holder = spawnHelper({
        dir,
        mode: 'strict',
        kernelLock: false,
        identity: { kernel: 'test-kernel-a' },
        beatMs: BEAT,
        observeMs: OBSERVE,
        spinMs: OBSERVE + 4_000,
      })
      await waitHolding(holder)
      /* the spin started with the holding line — the event loop is dead,
         yet the worker keeps beating and the contender is refused */
      await expectRefusal(acquireDataLock(dir, { mode: 'strict', ...foreignOpts }), 'alive-elsewhere')
    },
    60_000,
  )

  /* AC-6: a frozen foreign owner — strict needs the token, takeover takes over */
  it.skipIf(process.platform === 'win32')(
    'a frozen foreign owner: strict needs the claim id, takeover overtakes, the resumed owner dies',
    async () => {
      const dir = tmpdir()
      const frozen = spawnHelper({
        dir,
        mode: 'strict',
        kernelLock: false,
        identity: { kernel: 'test-kernel-a', machine: 'test-machine-a' },
        beatMs: BEAT,
        observeMs: OBSERVE,
      })
      await waitHolding(frozen)
      frozen.child.kill('SIGSTOP')

      const strictRefusal = await expectRefusal(
        acquireDataLock(dir, { mode: 'strict', ...foreignOpts }),
        'needs-takeover',
      )
      const claimId = strictRefusal.claimId
      expect(claimId).toBeTruthy()

      await expectRefusal(
        acquireDataLock(dir, { mode: 'strict', ...foreignOpts, takeoverToken: 'not-the-claim' }),
        'needs-takeover',
      )

      const takeover = spawnHelper({
        dir,
        mode: 'strict',
        kernelLock: false,
        identity: kernelB,
        takeoverToken: claimId,
        beatMs: BEAT,
        observeMs: OBSERVE,
      })
      expect(await waitHolding(takeover)).toBe(2)
      const takeoverGone = waitExit(takeover.child)
      takeover.child.kill('SIGKILL')
      await takeoverGone

      const auto = spawnHelper({
        dir,
        mode: 'takeover',
        kernelLock: false,
        identity: { kernel: 'test-kernel-c' },
        beatMs: BEAT,
        observeMs: OBSERVE,
      })
      expect(await waitHolding(auto)).toBe(3)

      /* resume the frozen owner: its fence sees the higher claim and ends
         it — within two beats, without a shutdown flush */
      const frozenGone = waitExit(frozen.child)
      frozen.child.kill('SIGCONT')
      await frozenGone
      expect(frozen.err()).toMatch(/lost the data dir/)
    },
    120_000,
  )

  /* AC-7: suspended before the wx create — the other claim wins the epoch */
  it.skipIf(process.platform === 'win32')(
    'a contender suspended before the claim create cannot come back to win',
    async () => {
      const dir = tmpdir()
      /* a dead foreign claim is what both contenders try to take */
      const dead = spawnHelper({
        dir,
        mode: 'strict',
        kernelLock: false,
        identity: { kernel: 'test-kernel-dead' },
        beatMs: BEAT,
        observeMs: OBSERVE,
      })
      await waitHolding(dead)
      const deadGone = waitExit(dead.child)
      dead.child.kill('SIGKILL')
      await deadGone

      const contender = spawnHelper({
        dir,
        mode: 'takeover',
        kernelLock: false,
        identity: kernelB,
        stopAt: 'beforeClaimCreate',
        beatMs: BEAT,
        observeMs: OBSERVE,
      })
      const winner = spawnHelper({
        dir,
        mode: 'takeover',
        kernelLock: false,
        identity: { kernel: 'test-kernel-c' },
        beatMs: BEAT,
        observeMs: OBSERVE,
      })
      expect(await waitHolding(winner)).toBe(2)

      const outcome = waitOutcome(contender)
      const resume = setInterval(() => {
        try {
          contender.child.kill('SIGCONT')
        } catch {
          /* gone */
        }
      }, 100)
      const result = await outcome
      clearInterval(resume)
      expect(result.holding).toBe(false)
      expect(result.refused).toBe('alive-elsewhere')
    },
    90_000,
  )

  /* AC-8: released-<N> frees the dir for any successor at once */
  it('a cleanly released dir is free for a successor on another kernel at once', async () => {
    const dir = tmpdir()
    const stopFile = path.join(dir, 'stop-me')
    const holder = spawnHelper({
      dir,
      mode: 'strict',
      kernelLock: false,
      identity: { kernel: 'test-kernel-a' },
      stopFile,
      beatMs: BEAT,
      observeMs: OBSERVE,
    })
    await waitHolding(holder)
    fs.writeFileSync(stopFile, '')
    await waitExit(holder.child)
    expect(fs.existsSync(path.join(lockDir(dir), 'released-1'))).toBe(true)

    const started = performance.now()
    const successor = spawnHelper({
      dir,
      mode: 'strict',
      kernelLock: false,
      identity: kernelB,
      beatMs: BEAT,
      observeMs: OBSERVE,
    })
    await waitHolding(successor)
    expect(performance.now() - started).toBeLessThan(3_000)
  }, 60_000)

  /* AC-9: the fence — losing the dir ends the holder within two beats */
  it('ends the holder within two beats when kernel.lock is deleted', async () => {
    const dir = tmpdir()
    const holder = spawnHelper({ dir, mode: 'strict', beatMs: BEAT, observeMs: OBSERVE })
    await waitHolding(holder)
    const gone = waitExit(holder.child)
    fs.rmSync(path.join(lockDir(dir), 'kernel.lock'))
    await gone
    expect(holder.err()).toMatch(/lost the data dir/)
  }, 45_000)

  it('ends the holder within two beats when its claim file is deleted', async () => {
    const dir = tmpdir()
    const holder = spawnHelper({ dir, mode: 'strict', beatMs: BEAT, observeMs: OBSERVE })
    await waitHolding(holder)
    const gone = waitExit(holder.child)
    fs.rmSync(claimFile(dir, 1))
    await gone
    expect(holder.err()).toMatch(/lost the data dir/)
  }, 45_000)

  it('ends the holder within two beats when a higher claim appears', async () => {
    const dir = tmpdir()
    const holder = spawnHelper({ dir, mode: 'strict', beatMs: BEAT, observeMs: OBSERVE })
    await waitHolding(holder)
    const gone = waitExit(holder.child)
    fs.writeFileSync(claimFile(dir, 9), '{"v":1,"id":"rival","epoch":9,"kernel":"other"}')
    await gone
    expect(holder.err()).toMatch(/lost the data dir/)
  }, 45_000)

  /* AC-10: a long data path holds through the beats */
  it('holds through five beats on a 200-character data path', async () => {
    const base = tmpdir()
    const dir = path.join(base, 'd'.repeat(Math.max(1, 200 - base.length - 1)))
    expect(dir.length).toBeGreaterThanOrEqual(200)
    const holder = spawnHelper({ dir, mode: 'strict', beatMs: BEAT, observeMs: OBSERVE })
    await waitHolding(holder)
    const beat = beatFile(dir, 1)
    const deadline = Date.now() + 10_000
    for (;;) {
      const count = Number(fs.existsSync(beat) ? fs.readFileSync(beat, 'utf8') : '0')
      if (count >= 5) break
      if (Date.now() > deadline) throw new Error(`beat stalled at ${count}: ${holder.err()}`)
      if (holder.child.exitCode !== null) throw new Error(`holder died: ${holder.out()} ${holder.err()}`)
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(holder.child.exitCode).toBeNull()
  }, 45_000)

  /* AC-11: a non-BUSY sqlite failure is unsupported and names the way out */
  it('a non-BUSY sqlite failure refuses as unsupported and names DOOP_DATA_LOCK=off', async () => {
    const dir = tmpdir()
    fs.mkdirSync(path.join(lockDir(dir), '..', 'lock'), { recursive: true })
    /* a directory where the database must open: sqlite cannot use it,
       and the error is not contention */
    fs.mkdirSync(path.join(lockDir(dir), 'kernel.lock'))
    const refusal = await expectRefusal(acquireDataLock(dir, { mode: 'strict' }), 'unsupported')
    expect(refusal.message).toContain('DOOP_DATA_LOCK=off')
  })

  it('sweeps the older designs’ server.lock leftovers after a clean take', async () => {
    const dir = tmpdir()
    for (const name of ['server.lock', 'server.lock-journal', 'server.lock.sock']) {
      fs.writeFileSync(path.join(dir, name), 'stale')
    }
    held.push(await acquireDataLock(dir, { mode: 'strict' }))
    for (const name of ['server.lock', 'server.lock-journal', 'server.lock.sock']) {
      expect(fs.existsSync(path.join(dir, name))).toBe(false)
    }
  })
})
