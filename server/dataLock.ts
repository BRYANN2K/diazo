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
 *
 * Holding is verified too: the heartbeat re-reads the file and a server
 * that finds another holder's name where its own was exits loudly — a
 * quiet heartbeat (a suspended process, a failed utimes) must never let a
 * second boot open the directory while the first keeps writing into it.
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

/* how long the lock's writer waits before trusting its create: long
   enough for a contender's in-flight rename to land, short enough to
   stay invisible at boot */
const CONFIRM_SETTLE_MS = 25

interface LockHolder {
  pid?: number
  host?: string
  at?: string
}

interface Lock {
  /** releases the heartbeat and removes the file (also wired to `exit`) */
  release(): void
}

export interface AcquireOptions {
  /** the heartbeat's interval — and the one interval a suspicious fresh
   *  lock gets to prove a live holder before it is taken over. Tests
   *  shrink it; production keeps the default. */
  heartbeatMs?: number
}

export function acquireDataLock(dir: string, opts: AcquireOptions = {}): Lock {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'server.lock')
  for (;;) {
    try {
      fs.writeFileSync(file, holder(), { flag: 'wx' })
      /* our own clock's date, not the volume's: a filesystem clock running
         ahead would leave the fresh lock future-dated, which every later
         boot reads as stale */
      try {
        const now = new Date()
        fs.utimesSync(file, now, now)
      } catch {
        /* the volume's clock it is — the heartbeat rewrites it in an interval */
      }
      /* winning the create does not end the race: a contender that read the
         same dead holder can still land a rename on our fresh file and
         write its own. Settle so that in-flight move is visible, then
         confirm the file on disk still names us — finding another pid
         means the other boot won and contest() gets the verdict */
      blockMs(CONFIRM_SETTLE_MS)
      if (readHolder(file)?.pid === process.pid) break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    contest(file, heartbeatMs)
  }

  const heartbeat = setInterval(() => {
    try {
      const now = new Date()
      fs.utimesSync(file, now, now)
    } catch {
      /* a failed touch is not fatal by itself — the re-read below decides */
    }
    /* a second boot that found our heartbeat stale claimed the dir and
       rewrote the file (or is doing so). Writing on anyway would corrupt
       the data under the new holder, and our exit would unlink its lock:
       stop loudly instead — release() removes the file only while it
       still names us */
    if (!namesUs(file)) {
      console.error(`[data] lost the data-dir lock at ${file} — another server holds it; exiting`)
      process.exit(1)
    }
  }, heartbeatMs)
  heartbeat.unref()

  let released = false
  const release = () => {
    if (released) return
    released = true
    clearInterval(heartbeat)
    process.off('exit', release)
    try {
      /* unlink only while the file still names us — after a takeover it
         belongs to a live server, and removing it would free the dir
         under them */
      if (namesUs(file)) fs.unlinkSync(file)
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

/** Decide an existing lock's fate: throw when it is held, take it aside
 *  when the holder is verifiably gone so the create loop can retry. */
function contest(file: string, heartbeatMs: number): void {
  const stat = statLock(file)
  const raw = readLock(file)
  const holder = parseHolder(raw)
  const ours = holder?.host === undefined || holder.host === os.hostname()
  const pid = typeof holder?.pid === 'number' ? holder.pid : 0
  const alive = pid > 0 && pidAlive(pid)

  if (!ours) {
    /* written elsewhere: the pid is not ours to probe, the heartbeat is */
    if (isStale(stat)) {
      takeLockAside(file, raw)
      return
    }
    throw new DataDirInUseError(file, `a server on ${holder?.host ?? 'another host'} — its heartbeat is fresh`)
  }
  if (pid === 0) {
    /* unreadable content — only a fresh file could still belong to a live,
       older-format holder; a stale one is safe to drop */
    if (isStale(stat)) {
      takeLockAside(file, raw)
      return
    }
    throw new DataDirInUseError(file, `an unreadable lock written ${age(stat)} ago`)
  }
  if (!alive) {
    /* pid is dead on this host: the holder is gone whatever the file's age */
    takeLockAside(file, raw)
    return
  }
  /* the live pid a lock names is not another server when it is our own — a
     container restart reruns the same low pids and Windows recycles them
     fast — or pid 1, the pid namespace's init: a server that held the lock
     as pid 1 took its whole container down with it, so a live pid 1 now is
     this container's init, not a holder. The exception is a same-hostname,
     same-pid neighbour on a shared volume (host networking, a fixed
     `hostname:` on two containers): it reads "our own pid" on a file that
     is still being beaten. A fresh heartbeat therefore gets one interval
     to move the file's date — a live holder cannot stay quiet that long,
     so an unmoved date means nobody is home */
  if (pid === process.pid || pid === 1) {
    if (stat !== null && !isStale(stat) && stillBeats(file, stat.mtimeMs, heartbeatMs)) {
      throw new DataDirInUseError(file, `a live server on this host is refreshing this lock`)
    }
    takeLockAside(file, raw)
    return
  }
  /* a live holder touches the file every heartbeat; a live pid with a
     heartbeat that went quiet is a recycled pid the dead holder left
     behind, not a server that still wants the directory */
  if (isStale(stat)) {
    takeLockAside(file, raw)
    return
  }
  throw new DataDirInUseError(file, `process ${pid} on this host`)
}

/** Take a stale lock aside by rename — exactly one contender can move the
 *  file, so a boot that loses the race never unlinks a file a winning boot
 *  just wrote. The moved file is deleted only when it still holds
 *  `expected`, the holder we judged dead; different content means we
 *  renamed a live claim, which is put back. True when the path is free. */
export function takeLockAside(file: string, expected: string | null): boolean {
  const moved = `${file}.${process.pid}`
  try {
    fs.renameSync(file, moved)
  } catch {
    return false /* gone or already taken — the create loop gets the verdict */
  }
  try {
    if (readLock(moved) === expected) {
      fs.unlinkSync(moved)
      return true
    }
    fs.renameSync(moved, file)
  } catch {
    /* a failed restore or delete: the create loop re-reads and retries */
  }
  return false
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

/** Give a possibly-live holder one heartbeat interval to move the file's
 *  date — the check that separates a leftover same-pid lock from a
 *  same-name neighbour that is still beating. */
function stillBeats(file: string, mtimeMs: number, heartbeatMs: number): boolean {
  blockMs(heartbeatMs)
  const now = statLock(file)
  return now !== null && now.mtimeMs !== mtimeMs
}

/** Whether the file still names this process on this host — the only proof
 *  the data dir is still ours, for the heartbeat and for release(). */
function namesUs(file: string): boolean {
  const holder = readHolder(file)
  return holder?.pid === process.pid && holder.host === os.hostname()
}

/** A synchronous pause — acquireDataLock stays sync for its boot call
 *  site, and a worker-free Atomics.wait is the only blocking sleep. */
function blockMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function statLock(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null /* deleted between our write attempt and now: contest retries on it */
  }
}

function readLock(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function parseHolder(raw: string | null): LockHolder | null {
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as LockHolder) : null
  } catch {
    return null
  }
}

function readHolder(file: string): LockHolder | null {
  return parseHolder(readLock(file))
}

function isStale(stat: fs.Stats | null): boolean {
  if (stat === null) return true
  /* either direction counts: a clock that stepped back after a power cut
     (no RTC, a resumed VM) leaves the lock future-dated, and waiting for
     our clock to reach its date would refuse every boot until then */
  return Math.abs(Date.now() - stat.mtimeMs) > STALE_MS
}

function age(stat: fs.Stats | null): string {
  return stat ? `${Math.round((Date.now() - stat.mtimeMs) / 1000)}s` : 'just now'
}
