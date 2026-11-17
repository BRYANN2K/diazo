import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepBrowserProfiles } from '../server/browserGuard.ts'
import { browserProfileDir } from '../server/paths.ts'
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

  /** a data dir and a separate browser download dir, both stubbed in */
  function tmpInstall(): { data: string; browser: string; profiles: string } {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-data-'))
    const browser = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-dl-'))
    dirs.push(data, browser)
    stubEnv('DOOP_DATA_DIR', data)
    stubEnv('DOOP_BROWSER_DIR', browser)
    return { data, browser, profiles: path.join(data, 'browser-profiles') }
  }

  afterEach(() => {
    unstubAllEnvs()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('drops leftover profile-* dirs and keeps everything else', () => {
    const { profiles } = tmpInstall()
    fs.mkdirSync(path.join(profiles, 'profile-dead'), { recursive: true })
    fs.mkdirSync(path.join(profiles, 'profile-older', 'nested'), { recursive: true })
    fs.mkdirSync(path.join(profiles, 'keep-dir'), { recursive: true })
    fs.writeFileSync(path.join(profiles, 'profile-loose-file'), 'x')
    sweepBrowserProfiles()
    expect(fs.readdirSync(profiles).sort()).toEqual(['keep-dir', 'profile-loose-file'])
  })

  it('tolerates a missing profile dir', () => {
    const { profiles } = tmpInstall()
    fs.rmSync(profiles, { recursive: true, force: true })
    expect(() => sweepBrowserProfiles()).not.toThrow()
  })

  it('sweeps only our own profiles — never a neighbour sharing DOOP_BROWSER_DIR', () => {
    const ours = tmpInstall()
    /* a second server with its own locked data dir and the same download
       dir: each boot's sweep must reach only the profiles beneath its own
       data dir, which is what the lock actually covers */
    const theirs = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-peer-'))
    dirs.push(theirs)
    fs.mkdirSync(path.join(ours.profiles, 'profile-dead'), { recursive: true })
    fs.mkdirSync(path.join(theirs, 'browser-profiles', 'profile-live'), { recursive: true })
    fs.mkdirSync(path.join(ours.browser, 'profile-stray'), { recursive: true })
    sweepBrowserProfiles()
    expect(fs.existsSync(path.join(ours.profiles, 'profile-dead'))).toBe(false)
    expect(fs.existsSync(path.join(theirs, 'browser-profiles', 'profile-live'))).toBe(true)
    /* a stray profile-* inside the download dir is nobody's to sweep */
    expect(fs.existsSync(path.join(ours.browser, 'profile-stray'))).toBe(true)
  })

  it('manages profiles under the data dir only when DOOP_EMBEDDED or DOOP_BROWSER_DIR says so', () => {
    const { profiles } = tmpInstall()
    stubEnv('DOOP_BROWSER_DIR', undefined)
    stubEnv('DOOP_EMBEDDED', undefined)
    /* Docker and the checkout: puppeteer's temp-dir default, and a stale
       profile-* under the data dir is not ours to touch */
    expect(browserProfileDir()).toBeUndefined()
    fs.mkdirSync(path.join(profiles, 'profile-stale'), { recursive: true })
    sweepBrowserProfiles()
    expect(fs.existsSync(path.join(profiles, 'profile-stale'))).toBe(true)

    stubEnv('DOOP_EMBEDDED', '1')
    expect(browserProfileDir()).toBe(profiles)
    stubEnv('DOOP_EMBEDDED', undefined)
    stubEnv('DOOP_BROWSER_DIR', '/somewhere/explicit')
    /* the variable moves only the download — profiles stay beneath the
       locked data dir, where a shared download can never be swept */
    expect(browserProfileDir()).toBe(profiles)
  })

  it('writes nothing under the data dir when the profile is unmanaged', async () => {
    if (!findBrowserPath()) return
    const { data, profiles } = tmpInstall()
    stubEnv('DOOP_BROWSER_DIR', undefined)
    stubEnv('DOOP_EMBEDDED', undefined)
    const browser = await launchBrowser(30_000)
    try {
      /* the Docker profile contract: Chrome's singleton files stay in the
         system temp dir, off the persistent volume */
      expect(fs.existsSync(profiles)).toBe(false)
      expect(fs.existsSync(path.join(data, 'browser'))).toBe(false)
    } finally {
      await browser.close()
    }
  }, 60_000)

  it('never runs on browser launch — a launch keeps sibling profiles', async () => {
    if (!findBrowserPath()) return
    const { profiles } = tmpInstall()
    fs.mkdirSync(path.join(profiles, 'profile-live-peer'), { recursive: true })
    const browser = await launchBrowser(30_000)
    try {
      /* the launched browser did get a profile of its own — alongside, not
         instead of, the one another live process is using */
      const names = fs.readdirSync(profiles)
      expect(names.filter((n) => n.startsWith('profile-')).length).toBeGreaterThan(1)
      expect(names).toContain('profile-live-peer')
    } finally {
      await browser.close()
    }
  }, 60_000)
})
