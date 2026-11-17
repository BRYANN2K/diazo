import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataLock, DataDirInUseError, type AcquireOptions } from '../server/dataLock.ts'

/**
 * server/dataLock.ts: one live server per data directory, backed by the OS.
 * `<dir>/server.lock` is the claim file; `<dir>/server.lock.sock` a unix
 * socket the holder binds for its lifetime — a refused connection is the
 * kernel's proof the holder is gone, so no pid or hostname comparison
 * decides liveness (a same-pid neighbour in another container cannot fake
 * it). A live holder is refused before any protected state is touched; a
 * provably dead claim is moved aside and re-created under one O_EXCL gate.
 */

interface Lock {
  release(): void
}

const ROOT = process.cwd()
const HELPER = path.join(ROOT, 'tests', 'fixtures', 'dataLockHelper.ts')

/* spawn the holder as ONE node process — `--import tsx` loads the .ts
   helper in-process, so the child's pid is the socket's owner and a
   SIGKILL really kills the holder (a `tsx` wrapper would fork and leave
   a grandchild holding the lock) */
function spawnHelper(dir: string, heartbeatMs: number | string): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', HELPER, dir, String(heartbeatMs)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  return child
}

const dirs: string[] = []
const held: Lock[] = []
const children: ChildProcess[] = []

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'))
  dirs.push(dir)
  return dir
}

async function lock(dir: string, opts?: AcquireOptions): Promise<Lock> {
  const l = await acquireDataLock(dir, opts)
  held.push(l)
  return l
}

const claimFile = (dir: string) => path.join(dir, 'server.lock')
const sockFile = (dir: string) => `${claimFile(dir)}.sock`

function writeClaim(dir: string, body: object, mtimeMsAgo = 0): void {
  const file = claimFile(dir)
  fs.writeFileSync(file, JSON.stringify(body))
  const mtime = new Date(Date.now() - mtimeMsAgo)
  fs.utimesSync(file, mtime, mtime)
}

/** A socket file nothing listens on — the shape a dead holder leaves. */
async function deadSocket(file: string): Promise<void> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(file, resolve))
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/** Spawn the helper and wait for its `holding=` line or its refusal. */
function holdInChild(dir: string, heartbeatMs = 300): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawnHelper(dir, heartbeatMs)
  let refused = ''
  child.stderr!.on('data', (d: Buffer) => {
    refused += d.toString()
  })
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => {
      const m = /holding=(\d+)/.exec(d.toString())
      if (m) resolve({ child, pid: Number(m[1]) })
    })
    child.once('exit', (code) => reject(new Error(`helper exited ${code}: ${refused}`)))
    child.once('error', reject)
    setTimeout(() => reject(new Error('helper never took the lock')), 30_000)
  })
}

afterEach(() => {
  for (const l of held.splice(0)) l.release()
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('server/dataLock.ts', () => {
  it('claims the dir, binds the socket, and release removes both', async () => {
    const dir = tmpdir()
    const l = await lock(dir)
    const holder = JSON.parse(fs.readFileSync(claimFile(dir), 'utf8')) as { pid: number; host: string }
    expect(holder.pid).toBe(process.pid)
    expect(holder.host).toBe(os.hostname())
    expect(fs.statSync(sockFile(dir)).isSocket()).toBe(true)
    l.release()
    expect(fs.existsSync(claimFile(dir))).toBe(false)
    expect(fs.existsSync(sockFile(dir))).toBe(false)
  })

  it('refuses a second acquire while this process holds the socket', async () => {
    const dir = tmpdir()
    await lock(dir)
    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
  })

  it('frees the directory for the next boot after release', async () => {
    const dir = tmpdir()
    ;(await lock(dir)).release()
    await expect(lock(dir)).resolves.toBeDefined()
  })

  it('refuses a live holder in another process before touching the lock', async () => {
    const dir = tmpdir()
    const { pid } = await holdInChild(dir)
    /* what a refused contender must not disturb */
    const claim = fs.readFileSync(claimFile(dir), 'utf8')
    const sockIno = fs.statSync(sockFile(dir)).ino

    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
    await expect(acquireDataLock(dir)).rejects.toThrow(`process ${pid}`)

    expect(fs.readFileSync(claimFile(dir), 'utf8')).toBe(claim)
    expect(fs.statSync(sockFile(dir)).ino).toBe(sockIno)
  }, 45_000)

  it('reclaims the dir once the holder is dead — kill -9 included', async () => {
    const dir = tmpdir()
    const { child } = await holdInChild(dir)
    const gone = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await gone

    const l = await lock(dir)
    const holder = JSON.parse(fs.readFileSync(claimFile(dir), 'utf8')) as { pid: number }
    expect(holder.pid).toBe(process.pid)
    /* the dead holder's socket file was replaced by a live one */
    expect(fs.statSync(sockFile(dir)).isSocket()).toBe(true)
    l.release()
  }, 45_000)

  it('still refuses a live holder whose claim went quiet — the heartbeat is not liveness', async () => {
    const dir = tmpdir()
    /* a child holding the lock with a heartbeat that never fires while the
       test runs; aging its claim must change nothing — the socket is the
       proof it is alive, not the file's date */
    await holdInChild(dir, 60_000)
    const stale = new Date(Date.now() - 120_000)
    fs.utimesSync(claimFile(dir), stale, stale)
    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
    expect(fs.statSync(sockFile(dir)).isSocket()).toBe(true)
  }, 45_000)

  it('refuses a claim that names our own pid and host — the twin container', async () => {
    const dir = tmpdir()
    /* two containers sharing hostname, pid space and the volume: the claim
       reads exactly as if we wrote it, but the socket still belongs to the
       other process. The probe does not consult the pid at all */
    await holdInChild(dir, 60_000)
    writeClaim(dir, { pid: process.pid, host: os.hostname(), at: new Date().toISOString() })
    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
  }, 45_000)

  it('exactly one of two simultaneous boots wins the dir', async () => {
    const dir = tmpdir()
    /* a dead holder's leftovers both contenders race to reclaim */
    writeClaim(dir, { pid: 999_999, host: os.hostname() }, 120_000)
    await deadSocket(sockFile(dir))

    const outcomes = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<string>((resolve) => {
            const child = spawnHelper(dir, '300')
            let out = ''
            child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
            child.stderr!.on('data', (d: Buffer) => (out += d.toString()))
            const timer = setTimeout(() => resolve('timeout'), 45_000)
            child.once('exit', () => {
              clearTimeout(timer)
              resolve(out)
            })
            child.stdout!.on('data', (d: Buffer) => {
              if (d.toString().includes('holding=')) {
                clearTimeout(timer)
                resolve(out + 'WON')
              }
            })
          }),
      ),
    )
    const winners = outcomes.filter((o) => o.includes('WON'))
    expect(winners).toHaveLength(1)
    expect(outcomes.filter((o) => !o.includes('WON'))[0]).toMatch(/already in use|refused/)
  }, 60_000)

  it('a holder whose claim is stolen exits loudly instead of writing under a rival', async () => {
    const dir = tmpdir()
    /* a long heartbeat would leave the theft unnoticed past the timeout */
    const { child } = await holdInChild(dir, 150)
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    writeClaim(dir, { pid: 999_999, host: os.hostname(), at: new Date().toISOString() })
    expect(await exited).toBe(1)
    expect(stderr).toMatch(/lost the data-dir lock/)
  }, 45_000)

  it('a holder whose socket file is removed exits loudly — the dir reads socketless', async () => {
    const dir = tmpdir()
    /* our socket survives its file being unlinked — but every contender
       would then see a socketless claim and reclaim under us */
    const { child } = await holdInChild(dir, 150)
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    fs.rmSync(sockFile(dir))
    expect(await exited).toBe(1)
    expect(stderr).toMatch(/lost the data-dir lock/)
  }, 45_000)

  it('refuses a foreign-host claim while fresh, reclaims it once stale', async () => {
    const dir = tmpdir()
    await deadSocket(sockFile(dir))
    writeClaim(dir, { pid: 42, host: 'some-container-elsewhere' })
    await expect(acquireDataLock(dir)).rejects.toThrow(/some-container-elsewhere/)

    writeClaim(dir, { pid: 42, host: 'some-container-elsewhere' }, 120_000)
    await expect(lock(dir)).resolves.toBeDefined()
  })

  it('reclaims a foreign claim dated in the future — a stepped-back clock is still stale', async () => {
    const dir = tmpdir()
    await deadSocket(sockFile(dir))
    writeClaim(dir, { pid: 42, host: 'some-container-elsewhere' }, -300_000)
    await expect(lock(dir)).resolves.toBeDefined()
  })

  it('reclaims a dead claim with no socket — a claimant that crashed mid-claim', async () => {
    const dir = tmpdir()
    /* same-host claim, never bound: fresh means "mid-claim" for one window,
       then it is a dead claimant either way */
    writeClaim(dir, { pid: 999_999, host: os.hostname() })
    await expect(lock(dir, { midClaimMs: 150 })).resolves.toBeDefined()
  })

  it('reclaims an unreadable claim once the socket is proven dead', async () => {
    const dir = tmpdir()
    await deadSocket(sockFile(dir))
    fs.writeFileSync(claimFile(dir), 'not json')
    await expect(lock(dir)).resolves.toBeDefined()
  })

  it('release leaves a lock another holder wrote', async () => {
    const dir = tmpdir()
    const l = await lock(dir, { heartbeatMs: 60_000 })
    writeClaim(dir, { pid: 999_999, host: os.hostname(), at: new Date().toISOString() })
    l.release()
    /* a release that unlinks unconditionally would free the dir under the
       live server that just took it */
    const holder = JSON.parse(fs.readFileSync(claimFile(dir), 'utf8')) as { pid: number }
    expect(holder.pid).toBe(999_999)
  })
})
