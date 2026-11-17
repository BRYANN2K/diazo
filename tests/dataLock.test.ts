import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataLock, DataDirInUseError } from '../server/dataLock.ts'

/**
 * server/dataLock.ts: one live server per data directory. A lock whose
 * holder is verifiably gone (dead pid on this host, or a foreign-host lock
 * whose heartbeat went stale) is reclaimed; a live one is refused so two
 * writers can never share PGlite's data dir.
 */

interface Lock {
  release(): void
}

const dirs: string[] = []
const held: Lock[] = []

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'))
  dirs.push(dir)
  return dir
}

function lock(dir: string): Lock {
  const l = acquireDataLock(dir)
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

afterEach(() => {
  for (const l of held.splice(0)) l.release()
  for (const c of children.splice(0)) c.kill('SIGKILL')
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
       "alive" (it is us) and must not refuse into a crash loop */
    writeLock(dir, { pid: process.pid, host: os.hostname() })
    expect(() => lock(dir)).not.toThrow()
  })

  it('reclaims a fresh lock naming pid 1 — a live init is not a holder', () => {
    const dir = tmpdir()
    /* the same container story: a server that was pid 1 died with its whole
       namespace; today's pid 1 is the new container's init */
    writeLock(dir, { pid: 1, host: os.hostname() })
    expect(() => lock(dir)).not.toThrow()
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

  it('refuses a foreign-host lock while its heartbeat is fresh, reclaims it once stale', () => {
    const dir = tmpdir()
    writeLock(dir, { pid: deadPid(), host: 'some-container-elsewhere' })
    expect(() => acquireDataLock(dir)).toThrow(/another host|some-container-elsewhere/)
    /* heartbeat 90s quiet: the remote holder is presumed dead */
    writeLock(dir, { pid: deadPid(), host: 'some-container-elsewhere' }, 90_000)
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
