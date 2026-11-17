import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataLock, DataDirInUseError, takeLockAside, type AcquireOptions } from '../server/dataLock.ts'

/**
 * server/dataLock.ts: one live server per data directory. A lock whose
 * holder is verifiably gone (dead pid on this host, or a foreign-host lock
 * whose heartbeat went stale) is reclaimed; a live one is refused so two
 * writers can never share PGlite's data dir. A holder that loses its own
 * file stops writing and exits.
 */

interface Lock {
  release(): void
}

const ROOT = process.cwd()
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx')
const HELPER = path.join(ROOT, 'tests', 'fixtures', 'dataLockHelper.ts')

const dirs: string[] = []
const held: Lock[] = []

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'))
  dirs.push(dir)
  return dir
}

function lock(dir: string, opts?: AcquireOptions): Lock {
  const l = acquireDataLock(dir, opts)
  held.push(l)
  return l
}

const lockFile = (dir: string) => path.join(dir, 'server.lock')

function writeLock(dir: string, body: object, mtimeMsAgo = 0): void {
  const file = lockFile(dir)
  fs.writeFileSync(file, JSON.stringify(body))
  const mtime = new Date(Date.now() - mtimeMsAgo)
  fs.utimesSync(file, mtime, mtime)
}

/** a pid that is guaranteed dead: a child that already exited */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid
}

/** a pid that is guaranteed alive and not ours: a sleeping child */
const children: ChildProcess[] = []
function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
  children.push(child)
  return child.pid!
}

const workers: Worker[] = []

afterEach(() => {
  for (const l of held.splice(0)) l.release()
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const w of workers.splice(0)) void w.terminate()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('server/dataLock.ts', () => {
  it('writes a lock naming this pid and host, and release removes it', () => {
    const dir = tmpdir()
    const l = lock(dir)
    const holder = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')) as { pid: number; host: string }
    expect(holder.pid).toBe(process.pid)
    expect(holder.host).toBe(os.hostname())
    l.release()
    expect(fs.existsSync(lockFile(dir))).toBe(false)
  })

  it('stamps the fresh lock with our own clock, not the volume’s', () => {
    const dir = tmpdir()
    lock(dir)
    /* a filesystem clock running ahead would leave us future-dated, which
       every later boot reads as stale — the write is re-stamped at once */
    expect(Math.abs(Date.now() - fs.statSync(lockFile(dir)).mtimeMs)).toBeLessThan(5_000)
  })

  it('refuses a second server while the holder is alive', () => {
    const dir = tmpdir()
    /* a live process on this host, still heartbeating its lock */
    writeLock(dir, { pid: livePid(), host: os.hostname() })
    expect(() => acquireDataLock(dir)).toThrow(DataDirInUseError)
    expect(() => acquireDataLock(dir)).toThrow(/process \d+ on this host/)
  })

  it('frees the directory for the next boot after release', () => {
    const dir = tmpdir()
    lock(dir).release()
    expect(() => lock(dir)).not.toThrow()
  })

  it('release leaves a file another holder wrote', () => {
    const dir = tmpdir()
    /* a long heartbeat so the interval never fires while the file is not
       ours — what is tested is release(), not the exit-on-takeover path */
    const l = lock(dir, { heartbeatMs: 60_000 })
    const rival = livePid()
    writeLock(dir, { pid: rival, host: os.hostname() })
    l.release()
    /* a release that unlinks unconditionally would free the dir under the
       live server that just took it */
    const holder = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')) as { pid: number }
    expect(holder.pid).toBe(rival)
  })

  it('a holder that loses its lock stops and exits loudly', async () => {
    const dir = tmpdir()
    /* a child holds the lock with a fast heartbeat; replacing the file
       plays the second boot that found a quiet heartbeat */
    const child = spawn(TSX, [HELPER, dir, '300'], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('holding=')) resolve()
      })
      child.once('error', reject)
      setTimeout(() => reject(new Error('helper never took the lock')), 15_000)
    })
    writeLock(dir, { pid: livePid(), host: os.hostname() })
    expect(await exited).toBe(1)
    expect(stderr).toMatch(/lost the data-dir lock/)
    /* and the new holder's file is still there — exit unlinks only our own */
    const holder = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')) as { pid: number }
    expect(holder.pid).not.toBe(child.pid)
  }, 30_000)

  it('reclaims a lock whose pid is dead on this host', () => {
    const dir = tmpdir()
    writeLock(dir, { pid: deadPid(), host: os.hostname() })
    expect(() => lock(dir)).not.toThrow()
    const holder = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')) as { pid: number }
    expect(holder.pid).toBe(process.pid)
  })

  it('reclaims a fresh lock naming our own pid — a container restart reissues it', () => {
    const dir = tmpdir()
    /* kill -9 in a container: the next boot gets the same pid back, sees it
       "alive" (it is us) and must not refuse into a crash loop. A fresh
       lock gets one heartbeat to prove a live neighbour — nobody moves it */
    writeLock(dir, { pid: process.pid, host: os.hostname() })
    expect(() => lock(dir, { heartbeatMs: 150 })).not.toThrow()
  })

  it('reclaims a fresh lock naming pid 1 — a live init is not a holder', () => {
    const dir = tmpdir()
    /* the same container story: a server that was pid 1 died with its whole
       namespace; today's pid 1 is the new container's init */
    writeLock(dir, { pid: 1, host: os.hostname() })
    expect(() => lock(dir, { heartbeatMs: 150 })).not.toThrow()
  })

  it('refuses a same-pid lock that is still being refreshed — a twin container', async () => {
    const dir = tmpdir()
    /* two containers sharing hostname, pid space and the volume (host
       networking, a fixed `hostname:`): the second reads "our own pid" on
       a lock that is still alive. A heartbeat that keeps moving the file's
       date is the only tell — wait one interval, then refuse. The beat
       comes from a worker: the wait itself blocks this thread's loop */
    writeLock(dir, { pid: process.pid, host: os.hostname() })
    const worker = new Worker(
      `const { workerData } = require('node:worker_threads')
       const fs = require('node:fs')
       const buf = new Int32Array(new SharedArrayBuffer(4))
       const end = Date.now() + workerData.ms
       while (Date.now() < end) {
         try { const now = new Date(); fs.utimesSync(workerData.file, now, now) } catch {}
         Atomics.wait(buf, 0, 0, 30)
       }
       process.exit(0)`,
      { eval: true, workerData: { file: lockFile(dir), ms: 800 } },
    )
    workers.push(worker)
    expect(() => lock(dir, { heartbeatMs: 300 })).toThrow(DataDirInUseError)
    /* refused means untouched: the file still names what it named */
    const holder = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')) as { pid: number }
    expect(holder.pid).toBe(process.pid)
    await new Promise((resolve) => worker.once('exit', resolve))
  })

  it('reclaims a lock whose live pid stopped heartbeating, keeps refusing a beating one', () => {
    const dir = tmpdir()
    const pid = livePid()
    /* a live pid whose heartbeat is fresh is a real second server */
    writeLock(dir, { pid, host: os.hostname() })
    expect(() => acquireDataLock(dir)).toThrow(/process \d+ on this host/)
    /* the same live pid with a quiet heartbeat is a recycled pid the dead
       holder left behind */
    writeLock(dir, { pid, host: os.hostname() }, 90_000)
    expect(() => lock(dir)).not.toThrow()
  })

  it('takes a dead holder aside by rename — and puts back a file that changed under us', () => {
    const dir = tmpdir()
    /* the judged-dead content still in place: moved and deleted */
    writeLock(dir, { pid: deadPid(), host: os.hostname() })
    const dead = fs.readFileSync(lockFile(dir), 'utf8')
    expect(takeLockAside(lockFile(dir), dead)).toBe(true)
    expect(fs.existsSync(lockFile(dir))).toBe(false)
    /* the file changed underneath our read — we renamed a live claim, so
       it lands back in place and the dir is not freed under its holder */
    writeLock(dir, { pid: livePid(), host: os.hostname() })
    expect(takeLockAside(lockFile(dir), dead)).toBe(false)
    const holder = JSON.parse(fs.readFileSync(lockFile(dir), 'utf8')) as { pid: number }
    expect(holder.pid).not.toBe(process.pid)
  })

  it('detects a contender that replaced the fresh lock mid-write', async () => {
    const dir = tmpdir()
    /* a dead holder two simultaneous boots both reclaim */
    writeLock(dir, { pid: deadPid(), host: os.hostname() })
    const rival = livePid()
    /* the other boot: the moment our fresh lock lands, it overwrites the
       file with its own live holder. Without the post-write re-read we
       would claim a dir the rival just took */
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads')
       const fs = require('node:fs')
       const os = require('node:os')
       const buf = new Int32Array(new SharedArrayBuffer(4))
       parentPort.postMessage('polling')
       for (;;) {
         try {
           const h = JSON.parse(fs.readFileSync(workerData.file, 'utf8'))
           if (h.pid === workerData.targetPid) {
             fs.writeFileSync(
               workerData.file,
               JSON.stringify({ pid: workerData.rivalPid, host: os.hostname() }),
             )
             process.exit(0)
           }
         } catch {}
         Atomics.wait(buf, 0, 0, 1)
       }`,
      { eval: true, workerData: { file: lockFile(dir), targetPid: process.pid, rivalPid: rival } },
    )
    workers.push(worker)
    /* wait until the contender is polling, so it cannot miss the window */
    await new Promise((resolve) => worker.once('message', resolve))
    expect(() => acquireDataLock(dir)).toThrow(DataDirInUseError)
  })

  it('refuses a foreign-host lock while its heartbeat is fresh, reclaims it once stale', () => {
    const dir = tmpdir()
    writeLock(dir, { pid: deadPid(), host: 'some-container-elsewhere' })
    expect(() => acquireDataLock(dir)).toThrow(/another host|some-container-elsewhere/)
    /* heartbeat 90s quiet: the remote holder is presumed dead */
    writeLock(dir, { pid: deadPid(), host: 'some-container-elsewhere' }, 90_000)
    expect(() => lock(dir)).not.toThrow()
  })

  it('reclaims a foreign lock dated in the future — a stepped-back clock is still stale', () => {
    const dir = tmpdir()
    /* after a power cut the volume's clock may run ahead of ours; waiting
       for our clock to reach the file's date would refuse every boot */
    writeLock(dir, { pid: deadPid(), host: 'some-container-elsewhere' }, -300_000)
    expect(() => lock(dir)).not.toThrow()
  })

  it('reclaims an unreadable lock dated in the future for the same reason', () => {
    const dir = tmpdir()
    const file = lockFile(dir)
    fs.writeFileSync(file, 'not json')
    const future = new Date(Date.now() + 300_000)
    fs.utimesSync(file, future, future)
    expect(() => lock(dir)).not.toThrow()
  })

  it('refuses a fresh lock it cannot read, reclaims an unreadable stale one', () => {
    const dir = tmpdir()
    const file = lockFile(dir)
    fs.writeFileSync(file, 'not json')
    expect(() => acquireDataLock(dir)).toThrow(DataDirInUseError)
    const old = new Date(Date.now() - 90_000)
    fs.utimesSync(file, old, old)
    expect(() => lock(dir)).not.toThrow()
  })
})
