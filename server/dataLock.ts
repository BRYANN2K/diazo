import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * One server per data directory. `<dir>/server.lock` records the holder's
 * pid, host and a heartbeat the running server refreshes; a boot that finds
 * it refuses to start instead of letting two writers corrupt PGlite's data.
 *
 * Reclaiming after a crash: the holder's pid is gone. When the file was
 * written on this host the dead pid is proof enough — retake it right away.
 * When it was written under another hostname (a container sharing the
 * volume, another pid namespace), an unprobed pid says nothing, so the
 * heartbeat decides: fresh means still held, stale means abandoned.
 */

export class DataDirInUseError extends Error {
  constructor(file: string, detail: string) {
    super(`the data dir is already in use (${detail}). If you're sure no other Diazo server holds it, delete ${file}`)
    this.name = 'DataDirInUseError'
  }
}

const HEARTBEAT_MS = 15_000
/* a lock whose heartbeat went quiet this long ago is abandoned; it must
   comfortably outlast HEARTBEAT_MS so a live holder never looks stale */
const STALE_MS = 60_000

interface LockHolder {
  pid?: number
  host?: string
  at?: string
}

interface Lock {
  /** releases the heartbeat and removes the file (also wired to `exit`) */
  release(): void
}

export function acquireDataLock(dir: string): Lock {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'server.lock')
  for (;;) {
    try {
      fs.writeFileSync(file, holder(), { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      contest(file)
    }
  }

  const heartbeat = setInterval(() => {
    try {
      const now = new Date()
      fs.utimesSync(file, now, now)
    } catch {
      /* the file is checked again on the next boot — a failed touch is not fatal */
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()

  let released = false
  const release = () => {
    if (released) return
    released = true
    clearInterval(heartbeat)
    process.off('exit', release)
    try {
      fs.unlinkSync(file)
    } catch {
      /* already gone */
    }
  }
  /* 'exit' is the one hook every shutdown path (signals, process.exit, an
     uncaught throw) lands on; the release itself is synchronous */
  process.once('exit', release)
  return { release }
}

function holder(): string {
  return JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() })
}

/** Decide an existing lock's fate: throw when it is held, remove it when
 *  the holder is verifiably gone so the create loop can retry. */
function contest(file: string): void {
  const stat = statLock(file)
  const holder = readHolder(file)
  const ours = holder?.host === undefined || holder.host === os.hostname()
  const pid = typeof holder?.pid === 'number' ? holder.pid : 0
  const alive = pid > 0 && pidAlive(pid)

  if (ours && alive) throw new DataDirInUseError(file, `process ${pid} on this host`)
  if (ours && pid === 0) {
    /* unreadable content — only a fresh file could still belong to a live,
       older-format holder; a stale one is safe to drop */
    if (isStale(stat)) return remove(file)
    throw new DataDirInUseError(file, `an unreadable lock written ${age(stat)} ago`)
  }
  if (ours) {
    /* pid is dead on this host: the holder is gone whatever the file's age */
    return remove(file)
  }
  /* written elsewhere: the pid is not ours to probe, the heartbeat is */
  if (isStale(stat)) return remove(file)
  throw new DataDirInUseError(file, `a server on ${holder?.host ?? 'another host'} — its heartbeat is fresh`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    /* EPERM = exists, owned by someone else; ESRCH = gone */
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function statLock(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null /* deleted between our write attempt and now: contest retries on it */
  }
}

function readHolder(file: string): LockHolder | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as LockHolder) : null
  } catch {
    return null
  }
}

function isStale(stat: fs.Stats | null): boolean {
  return stat === null || Date.now() - stat.mtimeMs > STALE_MS
}

function age(stat: fs.Stats | null): string {
  return stat ? `${Math.round((Date.now() - stat.mtimeMs) / 1000)}s` : 'just now'
}

function remove(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch {
    /* someone else took it already — the create loop gets the verdict */
  }
}
