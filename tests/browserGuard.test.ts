import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * server/browserGuard.ts against real process trees: a detached child plays
 * the browser (its own process group, like puppeteer's Chrome), a tsx helper
 * plays the server. Two ways a server can die must both reap the browser:
 *   exit-hook — a clean process.exit runs the synchronous 'exit' hook
 *   watchdog  — kill -9 runs no hooks, so a detached watcher reaps it
 * POSIX only: the watchdog's group kill relies on `kill(-pid)` semantics.
 */

const ROOT = process.cwd()
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx')
const HELPER = path.join(ROOT, 'tests', 'fixtures', 'browserGuardHelper.ts')

const posix = describe.skipIf(process.platform === 'win32')

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function expectDead(pid: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`pid ${pid} still alive after ${ms}ms`)
}

/** Launch the helper and read its `helper=<pid> guarded=<pid>` line — the
 *  shim pid a spawner gets back is not the real process, so the helper
 *  reports its own. */
function runHelper(mode: string): Promise<{ proc: ChildProcess; helperPid: number; pid: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(TSX, [HELPER, mode], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    let done = false
    proc.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const m = /helper=(\d+) guarded=(\d+)/.exec(out)
      if (m && !done) {
        done = true
        resolve({ proc, helperPid: Number(m[1]), pid: Number(m[2]) })
      }
    })
    proc.once('error', reject)
    proc.once('exit', () => {
      if (!done) reject(new Error(`helper exited without printing a pid: ${out}`))
    })
  })
}

posix('server/browserGuard.ts', () => {
  it('reaps the guarded process group when the server exits cleanly', async () => {
    const { proc, pid } = await runHelper('exit-hook')
    expect(pidAlive(pid)).toBe(true)
    await new Promise((r) => proc.once('exit', r))
    /* the exit hook is synchronous: the group is SIGKILLed before the
       helper's exit event reaches us */
    await expectDead(pid, 5_000)
  }, 30_000)

  it('reaps the browser after the server is killed -9, via the watchdog', async () => {
    const { proc, helperPid, pid } = await runHelper('watchdog')
    expect(pidAlive(pid)).toBe(true)
    /* the real helper, not the tsx shim proc.pid points at */
    process.kill(helperPid, 'SIGKILL')
    await new Promise((r) => proc.once('exit', r)).catch(() => {})
    /* the watchdog polls once a second; give it headroom */
    await expectDead(pid, 15_000)
  }, 30_000)

  it('leaves an unguarded child orphaned — the control showing the guard reaped', async () => {
    const { proc, pid } = await runHelper('no-guard')
    await new Promise((r) => proc.once('exit', r))
    /* the same orphan P0 measured ~16 of on a dev Mac: parent gone, browser alive */
    await new Promise((r) => setTimeout(r, 500))
    expect(pidAlive(pid)).toBe(true)
    /* clean the orphan up so the test machine doesn't keep it */
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    await expectDead(pid, 5_000)
  })
})
