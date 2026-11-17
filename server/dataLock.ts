import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * One server per data directory. `<dir>/server.lock` is the claim — a small
 * JSON file created O_EXCL, refreshed by the holder's heartbeat, removed on
 * release — and `<dir>/server.lock.sock` a unix socket the holder binds for
 * its whole lifetime.
 *
 * The socket is what makes the lock OS-backed rather than a guess from file
 * dates: the kernel keeps it listening exactly while the holder runs (a
 * suspended holder still counts — its backlog answers), so a refused
 * connection is proof of death, not a hint. No pid is ever probed, which is
 * what a same-pid neighbour in another container cannot fake: the probe
 * reaches the real listener over the shared volume whoever it belongs to.
 *
 * A boot that finds a claim probes the socket first. A live socket refuses
 * the boot before it touches a byte of protected state; a provably dead one
 * lets the boot move the claim aside and re-create it. Two contenders can
 * both reach that step, so the O_EXCL create is the single-winner gate and
 * the claim is only ever moved after death was proven — a live holder's
 * claim is never unlinked out from under it.
 *
 * Across a network filesystem the socket cannot reach a foreign holder —
 * connect refuses even though the remote server is alive. There the claim's
 * host and freshness decide, and they fail closed: foreign and fresh is
 * refused, foreign and stale is presumed abandoned, and a stolen holder
 * notices on its next heartbeat and exits loudly. Requiring unix sockets
 * keeps this to macOS/Linux — the platforms the embedded install targets.
 */

export class DataDirInUseError extends Error {
  constructor(file: string, detail: string) {
    super(
      `the data dir is already in use (${detail}). If you're sure no other Diazo server holds it, delete ${file} and ${file}.sock`,
    )
    this.name = 'DataDirInUseError'
  }
}

const HEARTBEAT_MS = 15_000
/* a foreign claim whose heartbeat went quiet this long ago is abandoned; it
   must comfortably outlast HEARTBEAT_MS so a live holder never looks stale.
   Only foreign locks are judged by age — a local holder's liveness is the
   socket's, not the clock's */
const STALE_MS = 60_000
/* after a refused probe, one pause and a second probe before the socket is
   accepted as dead — a transient refusal must not open a reclaim race */
const CONFIRM_DEAD_MS = 100
/* a claim with no socket file yet gets this long to produce one: the
   create->bind gap is milliseconds, so a claim still socketless after this
   belongs to a dead claimant */
const MIDCLAIM_MS = 1_000
/* connecting and reading the holder's identity */
const PROBE_TIMEOUT_MS = 2_000

interface LockHolder {
  pid?: number
  host?: string
  at?: string
}

interface Lock {
  /** closes the socket and removes the claim (also wired to `exit`) */
  release(): void
}

export interface AcquireOptions {
  /** the heartbeat interval that refreshes the claim and re-verifies our
   *  hold on it. Tests shrink it; production keeps the default. */
  heartbeatMs?: number
  /** the delays that pace acquisition: the re-probe pause after a refused
   *  connection, the window a fresh claim gets to bind its socket, and the
   *  probe timeout. Tests shrink them. */
  confirmMs?: number
  midClaimMs?: number
  probeTimeoutMs?: number
}

type Probe =
  /* a listener answered — the holder is alive whoever it is */
  | { state: 'alive'; holder: LockHolder | null }
  /* the kernel proved nothing listens — `missing` when there is no socket
     file at all (a mid-claim claimant could be about to bind), `missing`
     false when a file is there but nothing answers (a dead holder) */
  | { state: 'dead'; missing: boolean }
  /* timeout or an ambiguous error — death cannot be proved */
  | { state: 'unknown'; error: Error }

export async function acquireDataLock(dir: string, opts: AcquireOptions = {}): Promise<Lock> {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS
  const confirmMs = opts.confirmMs ?? CONFIRM_DEAD_MS
  const midClaimMs = opts.midClaimMs ?? MIDCLAIM_MS
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  fs.mkdirSync(dir, { recursive: true })
  const claim = path.join(dir, 'server.lock')
  const sock = `${claim}.sock`
  const me = holder()

  for (;;) {
    try {
      /* the single-winner gate: exactly one contender can create the claim */
      fs.writeFileSync(claim, me, { flag: 'wx' })
      return await hold(claim, sock, me, { heartbeatMs, probeTimeoutMs })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    for (let probe = await probeLock(sock, probeTimeoutMs); ; probe = await probeLock(sock, probeTimeoutMs)) {
      if (probe.state === 'alive') {
        const who = probe.holder ?? readHolder(claim)
        throw new DataDirInUseError(
          claim,
          who?.pid
            ? `process ${who.pid}${who.host && who.host !== os.hostname() ? ` on ${who.host}` : ''}`
            : 'a live server holds the socket',
        )
      }
      if (probe.state === 'unknown') {
        throw new DataDirInUseError(claim, `the holder's state cannot be proved (${probe.error.message})`)
      }
      /* dead — but a socket file that vanished mid-claim or a backlog at
         its limit can look the same for an instant; prove it twice */
      await sleep(confirmMs)
      probe = await probeLock(sock, probeTimeoutMs)
      if (probe.state !== 'dead') continue

      /* still dead. A foreign claim that is still being heartbeated means
         the holder lives on another host — its socket is unreachable for
         us, not absent, so its death cannot be proved: fail closed */
      const seen = readClaim(claim)
      if (seen?.holder?.host && seen.holder.host !== os.hostname() && isFresh(seen.mtimeMs)) {
        throw new DataDirInUseError(claim, `a server on ${seen.holder.host} — its heartbeat is fresh`)
      }
      /* a fresh claim whose socket never existed is mid-claim: its socket
         lands within milliseconds. Give it the window before moving it
         aside — stealing a fresh claim whose owner is about to bind is the
         one race left open. A dead socket FILE needs no wait: its holder
         already bound and is gone for good */
      if (probe.missing && seen && isFresh(seen.mtimeMs)) {
        await sleep(midClaimMs)
        probe = await probeLock(sock, probeTimeoutMs)
        if (probe.state !== 'dead') continue
        const now = readClaim(claim)
        if (now?.raw !== seen.raw) continue /* the claim moved under us — start over */
      }
      moveClaimAside(claim, seen)
      break
    }
  }
}

/** The claim file says nothing about liveness by itself — it is read only
 *  after the socket proved the holder dead, or for a foreign heartbeat. */
interface Claim {
  raw: string
  holder: LockHolder | null
  mtimeMs: number
}

function readClaim(file: string): Claim | null {
  try {
    const stat = fs.statSync(file)
    return { raw: fs.readFileSync(file, 'utf8'), holder: readHolder(file), mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

/** Move the judged-dead claim aside so the create loop can retry. The
 *  content must be exactly what was inspected: a different file means a
 *  live claim was displaced — restore it through an atomic link when the
 *  slot is still free, and never overwrite a newer claim to do it. */
function moveClaimAside(file: string, seen: Claim | null): void {
  const aside = `${file}.dead-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    fs.renameSync(file, aside)
  } catch {
    return /* gone or already taken — the loop re-reads and retries */
  }
  try {
    if (readClaim(aside)?.raw === seen?.raw) {
      fs.unlinkSync(aside)
      return
    }
    try {
      fs.linkSync(aside, file)
    } catch {
      /* a newer claim landed — leave it alone */
    }
    fs.unlinkSync(aside)
  } catch {
    /* a failed delete or restore: the loop re-reads and retries */
  }
}

/** We won the claim: bind the socket it gates, prove both still name us,
 *  then keep the claim fresh and watched until released. */
async function hold(
  claim: string,
  sock: string,
  me: string,
  opts: { heartbeatMs: number; probeTimeoutMs: number },
): Promise<Lock> {
  /* a stale socket file from the dead holder blocks the bind; only the
     claim's winner ever removes it, and only after the socket was probed
     dead — a live listener's file is never touched */
  try {
    fs.rmSync(sock, { force: true })
  } catch {
    /* the bind below gets the real verdict if this fails */
  }
  /* every probe gets the holder's identity and a hang-up: reading it is how
     a contender (and our own verify) tells who the socket belongs to */
  const server = net.createServer((conn) => conn.end(`${me}\n`))
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(sock, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    /* the bind failed (a socket path the OS rejects, a dir that vanished):
       leave no claim behind — it would only read as a dead one later */
    try {
      if (namesUs(claim)) fs.unlinkSync(claim)
    } catch {
      /* best effort — the next boot reclaims a dead claim anyway */
    }
    throw error
  }
  /* the inode the heartbeat watches: after a steal the path can carry a
     foreign socket while ours keeps listening namelessly */
  const sockIno = statIno(sock)
  try {
    /* before any protected state is touched: the claim must still name us
       (a contender may have moved it and put it back, or taken the slot)
       and the socket must answer as us */
    if (!namesUs(claim)) throw new DataDirInUseError(claim, 'the claim was taken during acquisition')
    const who = await probeIdentity(sock, opts.probeTimeoutMs)
    if (who?.pid !== process.pid || who.host !== os.hostname()) {
      throw new DataDirInUseError(claim, 'a rival claimed the socket during acquisition')
    }
  } catch (error) {
    await closeServer(server)
    throw error
  }

  const beat = setInterval(() => {
    /* a contender that could not prove our death (a foreign host on a
       network filesystem, a stolen claim) may still have taken the dir:
       the claim must keep naming us and the socket keep being ours — a
       holder that loses either exits loudly rather than corrupt under a
       second owner */
    try {
      if (!stillOurs(claim, sock, sockIno)) {
        console.error(`[data] lost the data-dir lock at ${claim} — another server holds it; exiting`)
        process.exit(1)
      }
      fs.writeFileSync(claim, holder())
    } catch {
      /* a failed refresh is not fatal by itself — the next beat re-checks */
    }
  }, opts.heartbeatMs)
  beat.unref()

  let released = false
  const release = () => {
    if (released) return
    released = true
    clearInterval(beat)
    process.off('exit', release)
    try {
      /* unlink only while the claim still names us — after a takeover the
         pair belongs to a live server, and removing it would free the dir
         under them */
      if (namesUs(claim)) {
        fs.unlinkSync(claim)
        fs.rmSync(sock, { force: true })
      }
    } catch {
      /* already gone */
    }
    void closeServer(server)
  }
  /* 'exit' is the one hook every shutdown path (signals, process.exit, an
     uncaught throw) lands on; the file cleanup itself is synchronous and
     the kernel reaps the socket with the process either way */
  process.once('exit', release)
  return { release }
}

/** Whether the claim still names us and the socket file is still the one we
 *  bound — the two ways a theft shows up for the heartbeat. */
function stillOurs(claim: string, sock: string, sockIno: number | null): boolean {
  if (!namesUs(claim)) return false
  /* the socket path must still be a file at all: a removed socket leaves
     the dir socketless to every contender even though we keep listening */
  if (!fs.existsSync(sock)) return false
  const ino = statIno(sock)
  /* when either side cannot report an inode, the existence + claim checks
     are all the watch there is */
  return sockIno === null || ino === null || ino === sockIno
}

function statIno(file: string): number | null {
  try {
    const ino = fs.statSync(file).ino
    return ino > 0 ? ino : null
  } catch {
    return null
  }
}

function holder(): string {
  return JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() })
}

/** Whether the file still names this process on this host — the only proof
 *  the data dir is still ours, for the heartbeat and for release(). */
function namesUs(file: string): boolean {
  const holder = readHolder(file)
  return holder?.pid === process.pid && holder.host === os.hostname()
}

function readHolder(file: string): LockHolder | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as LockHolder) : null
  } catch {
    return null
  }
}

function isFresh(mtimeMs: number): boolean {
  /* either direction counts as live-ish: a clock that stepped back after a
     power cut leaves the claim future-dated, and waiting for our clock to
     reach its date would refuse every boot until then */
  return Math.abs(Date.now() - mtimeMs) <= STALE_MS
}

/** Connect and read the identity line the holder writes before hanging up.
 *  The verdict is the connect itself: answered means alive, refused or
 *  missing means provably dead, everything else proves nothing. */
function probeLock(sock: string, timeoutMs: number): Promise<Probe> {
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
        done({ state: 'alive', holder: parseHolder(data.trim()) })
      })
    })
    conn.once('error', (error) => {
      clearTimeout(timer)
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return done({ state: 'dead', missing: true })
      done(
        code === 'ECONNREFUSED' || code === 'ENOTSOCK'
          ? { state: 'dead', missing: false }
          : { state: 'unknown', error },
      )
    })
  })
}

/** Our own verify: who the socket says the holder is. Null when it does not
 *  answer with an identity line in time. */
function probeIdentity(sock: string, timeoutMs: number): Promise<LockHolder | null> {
  return probeLock(sock, timeoutMs).then((probe) => (probe.state === 'alive' ? probe.holder : null))
}

function parseHolder(raw: string): LockHolder | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as LockHolder) : null
  } catch {
    return null
  }
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    server.unref()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
