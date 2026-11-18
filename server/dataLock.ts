import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { flockSync } from 'fs-ext'
import { env } from './env.ts'

/**
 * One server per data directory, enforced by a kernel-held file lock on
 * `<dir>/server.lock`: a stable file that is created once and NEVER
 * unlinked. The holder opens it, takes the OS's exclusive lock —
 * flock(2) on POSIX, LockFileEx on Windows — and keeps the fd for its
 * lifetime. The kernel releases the lock when the process dies, however
 * it dies: kill -9, a power cut, an OOM. A suspended holder stays
 * locked — its fd is still open — and heartbeat age never decides
 * death: a holder that goes quiet keeps its directory.
 *
 * The kernel lock is the single arbiter, so acquisition and recovery
 * are serialized by definition: a contender that finds the file locked
 * refuses before touching a byte of protected state; a dead holder's
 * lock is simply free to take. There is no move-aside, no unlink, no
 * create race — nothing a delayed contender can disturb mid-handoff.
 *
 * The file's content is a claim the holder writes AFTER locking — pid,
 * host, machine identity, when — read by refused boots for the error
 * message and by the cross-host guard below. It is never consulted for
 * liveness.
 *
 * Filesystem semantics: flock propagates over NFS where server and
 * client support locking and LockFileEx behaves the same over SMB. A
 * filesystem that cannot answer (ENOTSUP/ENOLCK/...) fails closed: the
 * documented requirement for a data dir is working advisory locking.
 * The residual case is a filesystem that accepts the lock locally while
 * the true holder lives on another machine — silent false exclusivity.
 * There the claim guards: written under a different machine identity,
 * it is refused unconditionally, however old, because its heartbeat's
 * age cannot prove that remote holder dead. Remove the file only when
 * that machine is gone for good.
 *
 * One legacy note: installs that ran the socket design leave
 * `server.lock.sock` behind; a live socket there means an old-version
 * server still owns the dir, so it is probed before holding, and the
 * dead ones are swept.
 */

export class DataDirInUseError extends Error {
  constructor(file: string, detail: string) {
    super(
      `the data dir is already in use or cannot be proven free (${detail}). If you're sure no Diazo server holds it, delete ${file}`,
    )
    this.name = 'DataDirInUseError'
  }
}

const HEARTBEAT_MS = 15_000
/* connecting to a legacy holder's socket and reading its identity */
const PROBE_TIMEOUT_MS = 2_000

interface LockHolder {
  pid?: number
  host?: string
  mid?: string
  at?: string
}

interface Lock {
  /** closes the lock fd — the kernel releases the lock (also wired to `exit`) */
  release(): void
}

export interface AcquireOptions {
  /** the interval that re-verifies the claim file still names us. Tests
   *  shrink it; production keeps the default. */
  heartbeatMs?: number
  /** probe timeout for the legacy socket sweep. Tests shrink it. */
  probeTimeoutMs?: number
}

type Probe =
  /* a listener answered — an old-version holder is alive whoever it is */
  | { state: 'alive'; holder: LockHolder | null }
  /* the kernel proved nothing listens */
  | { state: 'dead' }
  /* timeout or an ambiguous error — death cannot be proved */
  | { state: 'unknown'; error: Error }

/** flock contention on POSIX; LockFileEx's denial surfaces with platform
 *  codes on Windows. Anything else means the filesystem could not prove
 *  the state at all — refused all the same, just worded differently. */
const HELD_CODES = new Set(['EAGAIN', 'EACCES', 'EDEADLK', 'EBUSY', 'ERROR_LOCK_VIOLATION'])

/* flock's contention guarantee differs by platform: on BSD/macOS a
   second lock on the SAME file by the SAME process succeeds (locks are
   process-keyed, not descriptor-keyed), where Linux and LockFileEx
   refuse per handle. The kernel cannot be trusted to refuse our own
   re-entry, so we do — a path this process already holds is held. */
const heldHere = new Set<string>()

export async function acquireDataLock(dir: string, opts: AcquireOptions = {}): Promise<Lock> {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  fs.mkdirSync(dir, { recursive: true })
  /* canonicalize: a symlinked spelling of the same dir must name the same
     lock — the in-process guard and the claim both key on it */
  const realDir = fs.realpathSync(dir)
  const file = path.join(realDir, 'server.lock')
  if (heldHere.has(file)) throw new DataDirInUseError(file, describeHolder(readClaimFile(file)))

  /* 'a+': create the file if absent, NEVER truncate — a contender's open
     must not wipe the holder's claim */
  const fd = fs.openSync(file, 'a+', 0o600)
  try {
    flockSync(fd, 'exnb')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const detail = HELD_CODES.has(code ?? '')
      ? describeHolder(readClaimFile(file))
      : `the filesystem cannot prove the lock (${code ?? (error as Error).message})`
    fs.closeSync(fd)
    throw new DataDirInUseError(file, detail)
  }

  try {
    /* a live socket of the old design: an old-version server owns the dir
       without a file lock — refuse before our claim overwrites its state */
    const sock = `${file}.sock`
    if (fs.existsSync(sock)) {
      const probe = await probeSocket(sock, probeTimeoutMs)
      if (probe.state === 'alive') {
        throw new DataDirInUseError(file, describeHolder(probe.holder))
      }
      if (probe.state === 'unknown') {
        throw new DataDirInUseError(file, `its old-format socket could not be disproven (${probe.error.message})`)
      }
      fs.rmSync(sock, { force: true })
    }

    const me: LockHolder = {
      pid: process.pid,
      host: os.hostname(),
      mid: machineId() ?? undefined,
      at: new Date().toISOString(),
    }
    const claim = readClaimFd(fd)
    if (isForeign(claim, me.mid)) {
      throw new DataDirInUseError(
        file,
        `a server on ${claim?.host ?? 'another machine'} wrote it — a claim from another machine is never retaken`,
      )
    }

    /* the locked file must be the file at the path — if it was replaced
       between open and lock, the claim write and the heartbeat would look
       at different inodes */
    if (!sameFile(fd, file)) {
      throw new DataDirInUseError(file, 'the lock file was replaced during acquisition')
    }

    /* O_APPEND ignores write positions — the claim lands at EOF either
       way, so truncate first and the append writes at 0 */
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, JSON.stringify(me), 0)
    heldHere.add(file)
    return hold(fd, file, me, heartbeatMs)
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

/** We hold the kernel lock: watch only that the path keeps naming our
 *  claim — a stolen or deleted claim means the dir could be re-claimed
 *  on a new inode under us, and a second owner corrupts the database.
 *  The lock itself can never be lost while the fd lives. */
function hold(fd: number, file: string, me: LockHolder, heartbeatMs: number): Lock {
  const beat = setInterval(() => {
    try {
      /* compare path inode to our locked inode where the platform reports
         one; content is read through OUR fd — opening the file again is
         how a holder could lose its own lock under fcntl semantics */
      const st = statOrNull(file)
      const ours = fs.fstatSync(fd)
      const sameInode = !st || !st.ino || !ours.ino || st.ino === ours.ino
      if (!st || !sameInode || !namesUs(readClaimFd(fd), me)) {
        console.error(`[data] lost the data-dir lock at ${file} — another server may hold it; exiting`)
        process.exit(1)
      }
    } catch {
      /* a failed check is not proof of theft — the next beat re-checks */
    }
  }, heartbeatMs)
  beat.unref()

  let released = false
  const release = () => {
    if (released) return
    released = true
    clearInterval(beat)
    process.off('exit', release)
    heldHere.delete(file)
    try {
      fs.closeSync(fd)
    } catch {
      /* already closed */
    }
    /* the claim file stays: the next boot relocks it and overwrites. It is
       never unlinked — unlinking the name is how a fresh file (a fresh
       lockable inode) could be created under a live holder */
  }
  /* 'exit' is the one hook every shutdown path lands on; the kernel frees
     the lock with the fd either way */
  process.once('exit', release)
  return { release }
}

function describeHolder(holder: LockHolder | null): string {
  return holder?.pid
    ? `process ${holder.pid}${holder.host && holder.host !== os.hostname() ? ` on ${holder.host}` : ''}`
    : 'a live server holds it'
}

/** Written under a different machine identity, a claim is foreign — even
 *  a stale one: on a shared filesystem its holder may be alive but its
 *  lock invisible to us. Where identities are absent the hostname falls
 *  back; a mid match overrides a hostname change (a recreated container
 *  that kept its DOOP_MACHINE_ID). */
function isForeign(claim: LockHolder | null, mid: string | undefined): boolean {
  if (!claim) return false
  if (mid && claim.mid) return claim.mid !== mid
  return !!(claim.host && claim.host !== os.hostname())
}

/** Whether the parsed claim still names this process on this host — the
 *  heartbeat's theft check. */
function namesUs(claim: LockHolder | null, me: LockHolder): boolean {
  return !!claim && claim.pid === me.pid && claim.host === me.host
}

function readClaimFd(fd: number): LockHolder | null {
  try {
    const buf = Buffer.alloc(4096)
    const read = fs.readSync(fd, buf, 0, buf.length, 0)
    return parseClaim(buf.subarray(0, read).toString('utf8'))
  } catch {
    return null
  }
}

function readClaimFile(file: string): LockHolder | null {
  try {
    return parseClaim(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function parseClaim(raw: string): LockHolder | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as LockHolder) : null
  } catch {
    return null
  }
}

/** stat(path).ino === fstat(fd).ino where inodes are reported; on Windows
 *  stat.ino is 0 and the check degrades to the claim content watch. */
function sameFile(fd: number, file: string): boolean {
  const st = statOrNull(file)
  const ours = fs.fstatSync(fd)
  return !st || !st.ino || !ours.ino || st.ino === ours.ino
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ machine id
   A stable per-machine identity for the foreign-claim guard: DOOP_MACHINE_ID
   when pinned (a container deployment that survives recreation keeps it),
   else the OS's own machine id, else nothing — the hostname then decides. */

let cachedMid: string | null | undefined

function machineId(): string | null {
  if (cachedMid === undefined) cachedMid = readMachineId()
  return cachedMid
}

function readMachineId(): string | null {
  if (env.DOOP_MACHINE_ID) return env.DOOP_MACHINE_ID
  try {
    switch (process.platform) {
      case 'linux':
        return readMidFile('/etc/machine-id') ?? readMidFile('/var/lib/dbus/machine-id')
      case 'darwin':
        return midFromCommand('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], /"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      case 'win32':
        return midFromCommand(
          'reg',
          ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
          /MachineGuid\s+REG_SZ\s+(\S+)/,
        )
      default:
        return null
    }
  } catch {
    return null
  }
}

function readMidFile(file: string): string | null {
  try {
    const mid = fs.readFileSync(file, 'utf8').trim()
    return /^[0-9a-f-]{16,}$/i.test(mid) ? mid : null
  } catch {
    return null
  }
}

function midFromCommand(cmd: string, args: string[], pattern: RegExp): string | null {
  const out = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5_000 })
  return out.status === 0 ? (pattern.exec(out.stdout)?.[1] ?? null) : null
}

/* ------------------------------------------------------- legacy socket
   The socket design's leftovers: `<file>.sock` is probed before the claim
   is written — a live listener means an old-version server still owns the
   dir; a dead one is swept. Same verdicts as before: answered is alive,
   refused or missing is dead, anything else proves nothing. */

function probeSocket(sock: string, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    const conn = net.connect(sock)
    let settled = false
    const done = (probe: Probe) => {
      if (settled) return
      settled = true
      conn.destroy()
      resolve(probe)
    }
    const timer = setTimeout(() => done({ state: 'unknown', error: new Error('probe timed out') }), timeoutMs)
    timer.unref()
    conn.once('connect', () => {
      let data = ''
      conn.setEncoding('utf8')
      conn.on('data', (chunk) => {
        data += chunk
      })
      conn.once('close', () => {
        clearTimeout(timer)
        done({ state: 'alive', holder: parseClaim(data.trim()) })
      })
    })
    conn.once('error', (error) => {
      clearTimeout(timer)
      const code = (error as NodeJS.ErrnoException).code
      done(
        code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK'
          ? { state: 'dead' }
          : { state: 'unknown', error },
      )
    })
  })
}
