import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepBrowserProfiles } from '../server/browserGuard.ts'
import { findBrowserPath, launchBrowser } from '../server/screenshot.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * server/browserGuard.ts against real process trees: a detached child plays
 * the browser (its own process group, like puppeteer's Chrome), a tsx helper
 * plays the server. Two ways a server can die must both reap the browser:
 *   exit-hook — a clean process.exit runs the synchronous 'exit' hook
 *   watchdog  — kill -9 runs no hooks, so a detached watcher reaps it
 * POSIX only: the watchdog's group kill relies on `kill(-pid)` semantics.
 *
 * The profile sweep at the bottom is plain fs work and runs on every
 * platform: it must happen only where the server calls it (boot, under the
 * data lock), never from a browser launch.
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

describe('sweepBrowserProfiles (server/browserGuard.ts)', () => {
  const dirs: string[] = []

  function tmpBrowserDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'))
    dirs.push(dir)
    stubEnv('DOOP_BROWSER_DIR', dir)
    return dir
  }

  afterEach(() => {
    unstubAllEnvs()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('drops leftover profile-* dirs and keeps everything else', () => {
    const dir = tmpBrowserDir()
    fs.mkdirSync(path.join(dir, 'profile-dead'))
    fs.mkdirSync(path.join(dir, 'profile-older', 'nested'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'chrome-headless-shell-mac-arm64'))
    fs.writeFileSync(path.join(dir, 'profile-loose-file'), 'x')
    sweepBrowserProfiles()
    expect(fs.readdirSync(dir).sort()).toEqual(['chrome-headless-shell-mac-arm64', 'profile-loose-file'])
  })

  it('tolerates a missing browser dir', () => {
    const dir = tmpBrowserDir()
    fs.rmSync(dir, { recursive: true })
    expect(() => sweepBrowserProfiles()).not.toThrow()
  })

  it('never runs on browser launch — a launch keeps sibling profiles', async () => {
    if (!findBrowserPath()) return
    const dir = tmpBrowserDir()
    fs.mkdirSync(path.join(dir, 'profile-live-peer'))
    const browser = await launchBrowser(30_000)
    try {
      /* the launched browser did get a profile of its own — alongside, not
         instead of, the one another live process is using */
      const names = fs.readdirSync(dir)
      expect(names.filter((n) => n.startsWith('profile-')).length).toBeGreaterThan(1)
      expect(names).toContain('profile-live-peer')
    } finally {
      await browser.close()
    }
  }, 60_000)
})
