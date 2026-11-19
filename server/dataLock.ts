import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'

/**
 * One server per data directory, enforced by two layers under
 * `<dir>/lock/` (created 0700):
 *
 * 1. `kernel.lock` — a kernel-held lock taken through `node:sqlite`
 *    (`BEGIN EXCLUSIVE`, never committed). SQLite takes an `fcntl` lock
 *    on POSIX and `LockFileEx` on Windows; the kernel drops it when the
 *    process dies, however it dies — kill -9, OOM, a power cut — and a
 *    suspended holder keeps it. The guarantee covers one kernel: two
 *    containers on one Docker host or k3s node share it; two VMs or two
 *    machines sharing a folder do not. The file is never unlinked,
 *    opened or read by us: an `fcntl` lock is lost when the process
 *    closes any descriptor on the file, and owner information lives in
 *    separate files anyway.
 *
 * 2. Claim epochs — `claim-<N>.json` created `wx` (the cross-kernel
 *    compare-and-swap: on a shared folder the create either wins or
 *    fails `EEXIST` under every kernel), `beat-<N>` rewritten by a
 *    worker thread every few seconds (PGlite runs Postgres on the main
 *    thread, and a chain of awaited queries starves its timers — the
 *    beat cannot live there), and `released-<N>` written on clean exit.
 *    A claim from our kernel is dead by definition — we hold its lock.
 *    A foreign claim that still beats is alive in another container or
 *    machine; one that went quiet for the observe window is a takeover
 *    question the mode answers: `takeover` takes it, `strict` refuses
 *    until a one-shot token (`DOOP_DATA_LOCK_TAKEOVER=<claim id>`) names
 *    exactly that claim.
 *
 * The worker is also the fence: every beat it re-checks that
 * `kernel.lock` is still the same inode, that our claim file exists and
 * that no higher epoch was claimed. Otherwise it writes one line to
 * stderr and SIGKILLs the process — no flush, since the dir is no
 * longer ours.
 *
 * Guaranteed, in `strict` and `takeover`:
 *   G1 two servers under one kernel never both own a data dir; a frozen
 *      holder keeps it; after kill -9, OOM or a power cut the next boot
 *      acquires at once.
 *   G2 across kernels on a shared folder a running owner is never
 *      overtaken, and two contenders never both win a takeover.
 *   G3 a clean exit frees the dir for any successor, on any kernel.
 *   G4 `strict` never takes an unreleased foreign claim without its
 *      token.
 *   G5 an owner that lost the dir (overtaken, files removed) ends
 *      within one beat without writing its shutdown flush.
 *
 * Not guaranteed:
 *   N1 `takeover`, across kernels only, overtakes an owner frozen
 *      longer than the observe window (a paused VM); it ends within a
 *      beat of waking. Operators who cannot accept that set `strict`.
 *   N2 network filesystems without locking and with long directory
 *      caching (NFS `nolock`): beats may be seen late. A PGlite data
 *      dir on a network filesystem is unsupported anyway.
 *   N3 `off`: nothing.
 *   N4 Windows is covered by SQLite's `LockFileEx` path and the spike
 *      workflow's Windows job, not by a probe on the dev machine.
 */

export type LockMode = 'strict' | 'takeover'

export type RefusalReason = 'held' | 'alive-elsewhere' | 'needs-takeover' | 'unsupported'

export class DataDirInUseError extends Error {
  readonly reason: RefusalReason
  readonly claimId?: string

  constructor(reason: RefusalReason, message: string, claimId?: string) {
    super(message)
    this.name = 'DataDirInUseError'
    this.reason = reason
    this.claimId = claimId
  }
}

/** Which kernel (lock domain) and machine a claim belongs to. */
export interface LockIdentity {
  kernel: string
  machine?: string
}

export interface AcquireOptions {
  mode: LockMode
  /** the desktop sidecar: a same-machine claim may be retaken (a host
   *  has one kernel at a time, so a match proves the owner dead) */
  embedded?: boolean
  /** strict only: lets exactly the named claim be taken over */
  takeoverToken?: string
  /** the worker's beat interval — tests shrink it */
  beatMs?: number
  /** how long a foreign claim must stay static before takeover is
   *  considered — tests shrink it */
  observeMs?: number
  /** the identity claims are compared with — tests inject another
   *  kernel to simulate a second kernel on one filesystem */
  identity?: LockIdentity
  /** false simulates a kernel that cannot see our lock — tests only */
  kernelLock?: boolean
  hooks?: {
    beforeKernelLock?: () => Promise<void>
    beforeClaimCreate?: () => Promise<void>
  }
}

export interface DataLock {
  readonly epoch: number
  release(): void
}

const BEAT_MS = 3_000
const OBSERVE_MS = 15_000
const OBSERVE_STEP_MS = 500
const MAX_TURNS = 5

/* ------------------------------------------------------------ kernel lock
   `node:sqlite` (built into Node 22.13+, no native addon) holds the lock
   for the process's life. The DatabaseSync object must stay reachable —
   garbage collection would close it and drop the lock — so it lives in
   `heldKernels`, which also refuses a second acquire in this process. */

interface SqliteDatabase {
  exec(sql: string): void
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (file: string) => SqliteDatabase
}

interface KernelHold {
  db: SqliteDatabase
  dev: bigint
  ino: bigint
}

const heldKernels = new Map<string, KernelHold>()

/* `node:sqlite` prints one ExperimentalWarning on load; silence that
   warning for the one call, then restore emitWarning exactly. */
function loadSqlite(): SqliteModule | undefined {
  const getBuiltinModule = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  if (typeof getBuiltinModule !== 'function') return undefined
  const emitWarning = process.emitWarning
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = warning instanceof Error ? warning.message : String(warning)
    if (text.includes('SQLite')) return undefined
    return (emitWarning as (...args: unknown[]) => unknown).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return getBuiltinModule.call(process, 'node:sqlite') as SqliteModule | undefined
  } finally {
    process.emitWarning = emitWarning
  }
}

function kernelRefusal(error: unknown): DataDirInUseError {
  const errcode = (error as { errcode?: number }).errcode
  /* SQLITE_BUSY / SQLITE_LOCKED: a live server in this kernel holds it */
  if (errcode === 5 || errcode === 6) {
    return new DataDirInUseError('held', 'the data dir is already in use by a live server in this kernel')
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new DataDirInUseError(
    'unsupported',
    `the filesystem cannot hold the data-dir lock (${detail}) — set DOOP_DATA_LOCK=off to boot without it`,
  )
}

function takeKernelLock(lockDir: string): KernelHold {
  if (heldKernels.has(lockDir)) {
    throw new DataDirInUseError('held', 'the data dir is already locked by this process')
  }
  const sqlite = loadSqlite()
  if (!sqlite) throw new DataDirInUseError('unsupported', 'the data-dir lock needs Node 22.13 or newer')
  const file = path.join(lockDir, 'kernel.lock')
  let db: SqliteDatabase
  try {
    db = new sqlite.DatabaseSync(file)
  } catch (error) {
    throw kernelRefusal(error)
  }
  try {
    db.exec('PRAGMA busy_timeout = 0')
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    try {
      db.close()
    } catch {
      /* the open failed anyway */
    }
    throw kernelRefusal(error)
  }
  /* the inode the lock lives on: kernel.lock unlinked under us means a
     contender can lock a fresh inode — the beat worker fences on this */
  const stat = fs.statSync(file, { bigint: true })
  const hold: KernelHold = { db, dev: stat.dev, ino: stat.ino }
  heldKernels.set(lockDir, hold)
  return hold
}

function releaseKernel(lockDir: string, hold: KernelHold): void {
  try {
    hold.db.exec('ROLLBACK')
  } catch {
    /* an already-closed handle still frees the lock on exit */
  }
  try {
    hold.db.close()
  } catch {
    /* idempotent */
  }
  heldKernels.delete(lockDir)
}

/* ------------------------------------------------------------- identity
   `kernel` names the lock domain: one value per kernel boot, shared by
   every container on it. `machine` names the host for the embedded
   reboot rule. Anything unreadable yields a random kernel id — it only
   ever makes claims look foreign, never the reverse. */

let cachedIdentity: LockIdentity | undefined

export function localIdentity(): LockIdentity {
  cachedIdentity ??= readIdentity()
  return cachedIdentity
}

function readIdentity(): LockIdentity {
  try {
    switch (process.platform) {
      case 'linux': {
        const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
        if (bootId) return { kernel: `linux:${bootId}`, machine: readMachineIdFile() }
        break
      }
      case 'darwin': {
        const out = spawnSync('sysctl', ['-n', 'kern.uuid'], { encoding: 'utf8', timeout: 5_000 })
        const uuid = out.status === 0 ? out.stdout.trim() : ''
        if (uuid) return { kernel: `darwin:${uuid}`, machine: `darwin:${uuid}` }
        break
      }
      case 'win32': {
        const out = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
          encoding: 'utf8',
          timeout: 5_000,
        })
        const guid = out.status === 0 ? /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out.stdout)?.[1] : undefined
        if (guid) return { kernel: `win32:${guid}`, machine: `win32:${guid}` }
        break
      }
    }
  } catch {
    /* falls through to the unknown identity */
  }
  const kernel = `unknown:${randomUUID()}`
  console.warn(`[data] no stable kernel identity on this host (${process.platform}) — using ${kernel}`)
  return { kernel }
}

function readMachineIdFile(): string | undefined {
  try {
    const id = fs.readFileSync('/etc/machine-id', 'utf8').trim()
    return /^[0-9a-f-]{16,}$/i.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------- claims
   Every contender works the same protocol: read the highest epoch,
   decide whether it is free, then wx-create the next one. A contender
   stalled between verdict and create simply loses the create — the
   delayed-contender window made structurally impossible. */

interface Claim {
  id: string
  epoch: number
  kernel?: string
  machine?: string
  pid?: number
  host?: string
  at?: string
}

const claimFile = (lockDir: string, n: number) => path.join(lockDir, `claim-${n}.json`)
const beatFile = (lockDir: string, n: number) => path.join(lockDir, `beat-${n}`)
const releasedFile = (lockDir: string, n: number) => path.join(lockDir, `released-${n}`)

/** The highest claimed epoch, 0 when none — null when the listing
 *  itself failed (a failed read is no information). */
function highestEpoch(lockDir: string): number | null {
  let names: string[]
  try {
    names = fs.readdirSync(lockDir)
  } catch {
    return null
  }
  let highest = 0
  for (const name of names) {
    const match = /^claim-(\d+)\.json$/.exec(name)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

/** A claim file that does not parse is still a claim — a torn write
 *  from a dead owner — it just cannot vouch for any kernel. */
function readClaim(lockDir: string, epoch: number): Claim {
  try {
    const parsed = JSON.parse(fs.readFileSync(claimFile(lockDir, epoch), 'utf8')) as Partial<Claim>
    return {
      id: typeof parsed.id === 'string' ? parsed.id : `epoch-${epoch}`,
      epoch,
      kernel: typeof parsed.kernel === 'string' ? parsed.kernel : undefined,
      machine: typeof parsed.machine === 'string' ? parsed.machine : undefined,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      host: typeof parsed.host === 'string' ? parsed.host : undefined,
      at: typeof parsed.at === 'string' ? parsed.at : undefined,
    }
  } catch {
    return { id: `epoch-${epoch}`, epoch }
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const describeClaim = (claim: Claim) => `pid ${claim.pid ?? '?'} on ${claim.host ?? 'an unknown host'}`

/** A foreign, unreleased claim is watched for the whole window on our
 *  own monotonic clock — never compared to a wall time or a file date.
 *  Any movement proves a live owner elsewhere; a frozen one may be
 *  overtaken per the mode. Returns true when the epoch is free to take. */
async function observeClaim(lockDir: string, epoch: number, claim: Claim, opts: AcquireOptions): Promise<true> {
  const observeMs = opts.observeMs ?? OBSERVE_MS
  const beat = beatFile(lockDir, epoch)
  const started = performance.now()
  const deadline = started + observeMs
  let lastEpoch = highestEpoch(lockDir)
  let lastBeat = readText(beat)
  for (;;) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(OBSERVE_STEP_MS, remaining)))
    const nowEpoch = highestEpoch(lockDir)
    const nowBeat = readText(beat)
    const moved =
      (nowEpoch !== null && lastEpoch !== null && nowEpoch !== lastEpoch) ||
      (nowBeat !== null && lastBeat !== null && nowBeat !== lastBeat)
    if (moved) {
      throw new DataDirInUseError(
        'alive-elsewhere',
        `the data dir is owned by a live server (${describeClaim(claim)}) — its claim kept beating in another kernel or container`,
        claim.id,
      )
    }
    if (nowEpoch !== null) lastEpoch = nowEpoch
    if (nowBeat !== null) lastBeat = nowBeat
  }
  if (opts.mode === 'takeover') {
    console.warn(`[data] taking over claim ${claim.id} — its owner (${describeClaim(claim)}) went quiet`)
    return true
  }
  if (opts.takeoverToken === claim.id) return true
  throw new DataDirInUseError(
    'needs-takeover',
    `the data dir holds an unreleased claim ${claim.id} (${describeClaim(claim)}) that went quiet — set DOOP_DATA_LOCK_TAKEOVER=${claim.id} to take it over`,
    claim.id,
  )
}

function createClaim(lockDir: string, epoch: number, identity: LockIdentity): boolean {
  const body = JSON.stringify({
    v: 1,
    id: randomUUID(),
    epoch,
    kernel: identity.kernel,
    machine: identity.machine,
    pid: process.pid,
    host: os.hostname(),
    at: new Date().toISOString(),
  })
  let fd: number
  try {
    fd = fs.openSync(claimFile(lockDir, epoch), 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    fs.writeFileSync(fd, body)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  return true
}

async function claimEpoch(lockDir: string, identity: LockIdentity, opts: AcquireOptions): Promise<number> {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const n = highestEpoch(lockDir) ?? 0
    const claim = n > 0 ? readClaim(lockDir, n) : null
    let free =
      n === 0 ||
      fs.existsSync(releasedFile(lockDir, n)) ||
      claim?.kernel === identity.kernel ||
      (claim !== null && !!opts.embedded && !!claim.machine && claim.machine === identity.machine)
    if (!free) free = await observeClaim(lockDir, n, claim as Claim, opts)
    await opts.hooks?.beforeClaimCreate?.()
    const next = n + 1
    if (!createClaim(lockDir, next, identity)) continue /* someone else won the create */
    /* a rival that claimed above us between our create and this read won
       a parallel takeover — remove ours and re-evaluate against it */
    const highest = highestEpoch(lockDir)
    if (highest !== null && highest > next) {
      fs.rmSync(claimFile(lockDir, next), { force: true })
      continue
    }
    return next
  }
  throw new DataDirInUseError(
    'alive-elsewhere',
    'the data dir stayed contended — another server kept winning the claim',
  )
}

/* ------------------------------------------------------------- the beat
   Written by a Worker so a busy main thread (PGlite's synchronous
   Postgres, a long migration) cannot pause it. The source is a string:
   esbuild must ship it verbatim, so it requires only built-ins. */

const BEAT_WORKER_SOURCE = `
const fs = require('node:fs')
const path = require('node:path')
const { workerData } = require('node:worker_threads')
const { lockDir, epoch, beatMs, checkKernel, kernelDev, kernelIno } = workerData
const beatFile = path.join(lockDir, 'beat-' + epoch)
const beatTmp = beatFile + '.tmp'
const claimFile = path.join(lockDir, 'claim-' + epoch + '.json')
const kernelFile = path.join(lockDir, 'kernel.lock')
const claimRe = /^claim-(\\d+)\\.json$/
let counter = 0
setInterval(() => {
  /* 1. beat — a failure is retried next tick, not fatal on its own */
  try {
    fs.writeFileSync(beatTmp, String(counter++))
    fs.renameSync(beatTmp, beatFile)
  } catch {}
  /* 2. fence — lost when the kernel lock's inode changed or vanished
     (a contender re-locked a fresh file under us), our claim file is
     gone, or a higher epoch exists. Any other failure proves nothing:
     the next tick re-checks. */
  let lost = false
  try {
    if (checkKernel) {
      let stat
      try {
        stat = fs.statSync(kernelFile, { bigint: true })
      } catch (error) {
        if (error && error.code === 'ENOENT') lost = true
        else throw error
      }
      if (stat && (stat.dev !== BigInt(kernelDev) || stat.ino !== BigInt(kernelIno))) lost = true
    }
    if (!lost && !fs.existsSync(claimFile)) lost = true
    if (!lost) {
      for (const name of fs.readdirSync(lockDir)) {
        const match = claimRe.exec(name)
        if (match && Number(match[1]) > epoch) {
          lost = true
          break
        }
      }
    }
  } catch {}
  /* 3. lost — the dir is no longer ours: one stderr line, no flush */
  if (lost) {
    try {
      fs.writeSync(2, '[data] lost the data dir — another owner took it; exiting without flushing\\n')
    } catch {}
    process.kill(process.pid, 'SIGKILL')
  }
}, beatMs)
`

function startBeatWorker(lockDir: string, epoch: number, kernel: KernelHold | null, beatMs: number): Worker {
  const worker = new Worker(BEAT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      lockDir,
      epoch,
      beatMs,
      checkKernel: kernel !== null,
      kernelDev: String(kernel?.dev ?? 0n),
      kernelIno: String(kernel?.ino ?? 0n),
    },
  })
  worker.unref()
  /* a dead worker must not crash the holder — but without it the claim
     stops beating and the fence is gone, so say so */
  worker.on('error', (error) => console.error('[data] the beat worker died — the claim stopped beating', error))
  return worker
}

/* -------------------------------------------------------------- acquire */

export async function acquireDataLock(dir: string, opts: AcquireOptions): Promise<DataLock> {
  const identity = opts.identity ?? localIdentity()
  const beatMs = opts.beatMs ?? BEAT_MS
  fs.mkdirSync(dir, { recursive: true })
  /* canonicalize: a symlinked spelling of the same dir must name the
     same lock — the in-process guard and the kernel lock key on it */
  const realDir = fs.realpathSync(dir)
  const lockDir = path.join(realDir, 'lock')
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(lockDir, 0o700)
  } catch {
    /* a filesystem without chmod still gets the lock */
  }

  await opts.hooks?.beforeKernelLock?.()
  const kernel = opts.kernelLock === false ? null : takeKernelLock(lockDir)
  try {
    const epoch = await claimEpoch(lockDir, identity, opts)
    fs.writeFileSync(beatFile(lockDir, epoch), '0')
    const worker = startBeatWorker(lockDir, epoch, kernel, beatMs)
    let released = false
    const release = () => {
      if (released) return
      released = true
      process.off('exit', release)
      /* `wx`: only the first release marks the epoch ended — errors are
         ignored, an unwritten marker only ever keeps a dead claim
         suspect */
      try {
        fs.writeFileSync(releasedFile(lockDir, epoch), '', { flag: 'wx' })
      } catch {
        /* already released, or the dir is gone */
      }
      void worker.terminate()
      if (kernel) releaseKernel(lockDir, kernel)
    }
    process.once('exit', release)
    sweepEpochs(lockDir, epoch - 1)
    sweepLegacyLocks(realDir)
    return { epoch, release }
  } catch (error) {
    if (kernel) releaseKernel(lockDir, kernel)
    throw error
  }
}

/* files of epochs older than the one we displaced are dead state; the
   displaced epoch's own files stay (its claim is the one we read) */
function sweepEpochs(lockDir: string, before: number): void {
  let names: string[]
  try {
    names = fs.readdirSync(lockDir)
  } catch {
    return
  }
  for (const name of names) {
    const match = /^(?:claim|beat|released)-(\d+)(?:\.json)?$/.exec(name)
    if (match && Number(match[1]) < before) fs.rmSync(path.join(lockDir, name), { force: true })
  }
}

/* the older designs' leftovers at the data root — none of them decide
   anything any more */
function sweepLegacyLocks(dir: string): void {
  for (const name of ['server.lock', 'server.lock-journal', 'server.lock.sock']) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      /* best effort */
    }
  }
}
