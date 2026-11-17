import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'

/**
 * A launched browser dies with the server. Puppeteer detaches it into its
 * own process group on POSIX, so any way out that skips cleanup — a signal
 * that exits the event loop, a throw, kill -9 — used to leave a headless
 * Chrome reparented to init (16 of them piled up on a dev Mac, ~45 MB each,
 * measured 2026-11-17).
 *
 * Two layers cover every exit:
 *  - a synchronous 'exit' hook kills every guarded process group — normal
 *    shutdowns, signals and process.exit() all land there;
 *  - a watchdog `node -e` watches our pid and the browser's, reaping the
 *    group when the server disappears — the kill -9 case nothing can
 *    catch. It exits as soon as either side is gone, so it never piles up
 *    either. One watchdog per live browser.
 *
 * A child that is closed politely is released: the watchdog is killed and
 * the pid leaves the map, so a later process that reuses the pid is never
 * reaped by accident.
 *
 * Windows: there is no process-group kill, so the hook and the watchdog
 * call `taskkill /t` for the tree. The desktop shell's Job Object is the
 * stronger answer the sidecar gets in P2 — this layer stays best-effort.
 */

interface Guarded {
  child: ChildProcess
  watchdog: ChildProcess | null
  cleanupDir?: string
}

const guarded = new Map<number, Guarded>()
let exitHookInstalled = false

/** Watch the browser's whole tree: reap it on `exit`, and spawn the
 *  watchdog that covers the exits nothing can observe (kill -9). */
export function guardProcessTree(child: ChildProcess, opts: { cleanupDir?: string } = {}): void {
  const pid = child.pid
  if (pid === undefined) return
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', reapAll)
  }
  guarded.set(pid, { child, watchdog: spawnWatchdog(pid), cleanupDir: opts.cleanupDir })
}

/** The browser went away by itself or through terminate(): stop watching
 *  and remove its profile dir (best effort). */
export function releaseGuarded(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  const entry = guarded.get(pid)
  if (!entry) return
  guarded.delete(pid)
  try {
    entry.watchdog?.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  if (entry.cleanupDir) void fs.promises.rm(entry.cleanupDir, { recursive: true, force: true }).catch(() => {})
}

/** Synchronous, for the `exit` hook: SIGKILL the group POSIX, the tree
 *  on Windows. */
function reapAll(): void {
  for (const entry of guarded.values()) {
    killProcessTree(entry.child)
    try {
      entry.watchdog?.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    if (entry.cleanupDir) {
      try {
        fs.rmSync(entry.cleanupDir, { recursive: true, force: true })
      } catch {
        /* the next boot's sweep gets it */
      }
    }
  }
}

export interface ChildLike {
  pid?: number
  kill: (signal?: NodeJS.Signals) => boolean
}

/** Kill the browser process AND the renderers/GPU children its process
 *  group holds — killing the root alone is what left orphans behind. */
export function killProcessTree(child: ChildLike): void {
  const pid = child.pid
  if (process.platform === 'win32' && pid) {
    /* taskkill /t takes the whole tree; spawnSync keeps it usable inside
       the synchronous `exit` hook */
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
      return
    } catch {
      /* fall through to the single-process kill */
    }
  }
  if (process.platform !== 'win32' && pid) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      /* not a group leader: fall through to the process itself */
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

/* One poll per second is fast enough: an orphaned browser costs only its
   own memory for the gap. The watchdog checks the browser first (nothing
   to guard → leave) so it never lingers on its own. */
const WATCHDOG_SCRIPT = String.raw`
const [ppid, target] = process.argv.slice(-2).map(Number)
const live = (pid) => {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}
const reap = () => {
  if (process.platform === 'win32') {
    import('node:child_process')
      .then((c) => { c.spawnSync('taskkill', ['/pid', String(target), '/t', '/f'], { stdio: 'ignore' }) })
      .finally(() => process.exit(0))
  } else {
    try { process.kill(-target, 'SIGKILL') } catch { try { process.kill(target, 'SIGKILL') } catch {} }
    process.exit(0)
  }
}
setInterval(() => {
  if (!live(target)) process.exit(0)
  else if (!live(ppid)) reap()
}, 1000)
`

/** A detached `node -e` watching our pid: when the server is gone — however
 *  it went — the browser's process group follows. Runs on the same runtime
 *  the server does (process.execPath), so no PATH lookup is needed. */
function spawnWatchdog(browserPid: number): ChildProcess | null {
  try {
    const watchdog = spawn(process.execPath, ['-e', WATCHDOG_SCRIPT, String(process.pid), String(browserPid)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    watchdog.unref()
    watchdog.once('error', () => {})
    return watchdog
  } catch {
    return null /* no watchdog: the exit hook still covers every catchable exit */
  }
}
