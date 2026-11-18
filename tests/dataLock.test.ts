import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataLock, DataDirInUseError, type AcquireOptions } from '../server/dataLock.ts'

/**
 * server/dataLock.ts: one live server per data directory, proven by the
 * kernel's file locking — `<dir>/server.lock` is a stable file, created
 * once and never unlinked, that the holder keeps an exclusive OS lock on
 * for its whole life (flock on POSIX, LockFileEx on Windows). Death of
 * ANY kind frees the lock; a suspended or quiet holder stays locked —
 * claim timestamps are never read for liveness. A claim written under
 * another machine identity is refused unconditionally: on a shared
 * filesystem its lock may be real but invisible, and age cannot prove a
 * remote holder dead.
 */

interface Lock {
  release(): void
}

const ROOT = process.cwd()
const HELPER = path.join(ROOT, 'tests', 'fixtures', 'dataLockHelper.ts')

/* spawn the holder as ONE node process — `--import tsx` loads the .ts
   helper in-process, so the child's pid is the lock's owner and a
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

/** A socket file nothing listens on — the shape the old design's dead
 *  holder leaves behind. */
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
  it('claims the dir, writes the claim, and release frees the lock', async () => {
    const dir = tmpdir()
    const l = await lock(dir)
    const holder = JSON.parse(fs.readFileSync(claimFile(dir), 'utf8')) as { pid: number; host: string }
    expect(holder.pid).toBe(process.pid)
    expect(holder.host).toBe(os.hostname())
    l.release()
    /* the claim file itself stays — stable, never unlinked — but the
       kernel lock is free, so the next boot relocks and overwrites */
    expect(fs.existsSync(claimFile(dir))).toBe(true)
    await expect(lock(dir)).resolves.toBeDefined()
  })

  it('refuses a second acquire while this process holds the lock', async () => {
    const dir = tmpdir()
    await lock(dir)
    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
  })

  it('refuses a live holder in another process without disturbing its claim', async () => {
    const dir = tmpdir()
    const { pid } = await holdInChild(dir)
    /* what a refused contender must not disturb */
    const claim = fs.readFileSync(claimFile(dir), 'utf8')

    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
    await expect(acquireDataLock(dir)).rejects.toThrow(`process ${pid}`)

    expect(fs.readFileSync(claimFile(dir), 'utf8')).toBe(claim)
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
    l.release()
  }, 45_000)

  it('still refuses a live holder whose claim went quiet — the heartbeat is not liveness', async () => {
    const dir = tmpdir()
    /* a child holding the lock with a heartbeat that never fires while the
       test runs; aging its claim must change nothing — the kernel lock is
       the proof it is alive, not the file's date */
    await holdInChild(dir, 60_000)
    const stale = new Date(Date.now() - 120_000)
    fs.utimesSync(claimFile(dir), stale, stale)
    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
  }, 45_000)

  /* SIGSTOP/SIGCONT are POSIX; Windows keeps a suspended holder's lock the
     same way, but there is no cross-platform way to suspend the child */
  it.skipIf(process.platform === 'win32')(
    'refuses a suspended holder — a stopped process still holds its lock',
    async () => {
      const dir = tmpdir()
      /* the suspended live holder: SIGSTOP keeps the fd open, so the kernel
       lock survives and the contender is refused — the case heartbeat-age
       liveness always got wrong */
      const { child } = await holdInChild(dir, 60_000)
      child.kill('SIGSTOP')
      try {
        await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
      } finally {
        child.kill('SIGCONT')
      }
    },
    45_000,
  )

  it('exactly one of two simultaneous boots wins the dir', async () => {
    const dir = tmpdir()
    /* a dead holder's claim file is all the leftovers a lock design needs:
       the kernel frees its lock with the process, both contenders race to
       relock, and flock decides — the delayed-contender window the socket
       design lost does not exist */
    writeClaim(dir, { pid: 999_999, host: os.hostname() }, 120_000)

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

  it('holds a data path longer than a unix socket name allows', async () => {
    /* server.lock.sock had to fit in sockaddr_un (~104 chars): a 70-char
       data dir under a scratch root already broke the first heartbeat.
       The file lock names nothing but the file itself */
    const dir = path.join(
      tmpdir(),
      'a-very-long-data-directory-name-that-keeps-going-and-going-past-what-sun-path-allows',
    )
    expect(path.join(dir, 'server.lock.sock').length).toBeGreaterThan(104)
    const { child } = await holdInChild(dir, 120)
    /* alive past the first beats — a stolen heartbeat exited the old holder */
    await new Promise((r) => setTimeout(r, 400))
    expect(child.exitCode).toBeNull()
    const holder = JSON.parse(fs.readFileSync(claimFile(dir), 'utf8')) as { pid: number }
    expect(holder.pid).toBe(child.pid)
  }, 45_000)

  it('a holder whose claim is rewritten exits loudly instead of writing under a rival', async () => {
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

  it('a holder whose lock file is deleted exits loudly — the path no longer names it', async () => {
    const dir = tmpdir()
    /* the lock survives on the unlinked inode — but the path is free for a
       new file a contender could lock, so the dir must look lost to us */
    const { child } = await holdInChild(dir, 150)
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    fs.rmSync(claimFile(dir))
    expect(await exited).toBe(1)
    expect(stderr).toMatch(/lost the data-dir lock/)
  }, 45_000)

  it('never retakes a claim written under a different machine identity — however old', async () => {
    const dir = tmpdir()
    /* the shared-filesystem case: the claim's holder may be alive on a
       machine whose lock we cannot see — age is not proof of death, so a
       foreign claim refuses unconditionally */
    writeClaim(dir, { pid: 42, host: 'some-container-elsewhere', mid: 'other-machine' })
    await expect(acquireDataLock(dir)).rejects.toThrow(/some-container-elsewhere|another machine/)

    writeClaim(dir, { pid: 42, host: 'some-container-elsewhere', mid: 'other-machine' }, 120_000)
    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)

    writeClaim(dir, { pid: 42, host: 'some-container-elsewhere', mid: 'other-machine' }, 7 * 86_400_000)
    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
  })

  it('refuses a foreign claim dated in the future — a stepped-back clock is not death either', async () => {
    const dir = tmpdir()
    writeClaim(dir, { pid: 42, host: 'some-container-elsewhere', mid: 'other-machine' }, -300_000)
    await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
  })

  it('relocks a dead same-host claim — leftover files need no proof of death beyond the free lock', async () => {
    const dir = tmpdir()
    writeClaim(dir, { pid: 999_999, host: os.hostname(), at: new Date().toISOString() })
    await expect(lock(dir)).resolves.toBeDefined()
  })

  it('relocks an unreadable claim — a power cut mid-write', async () => {
    const dir = tmpdir()
    fs.writeFileSync(claimFile(dir), 'not json')
    await expect(lock(dir)).resolves.toBeDefined()
    /* and the claim now names us */
    const holder = JSON.parse(fs.readFileSync(claimFile(dir), 'utf8')) as { pid: number }
    expect(holder.pid).toBe(process.pid)
  })

  /* the socket design was POSIX-only — a Windows install can never leave
     a .sock behind, and a named pipe is not a file existsSync sees */
  it.skipIf(process.platform === 'win32')(
    'sweeps a dead unix socket left by the old design, then holds the dir',
    async () => {
      const dir = tmpdir()
      await deadSocket(sockFile(dir))
      await expect(lock(dir)).resolves.toBeDefined()
      expect(fs.existsSync(sockFile(dir))).toBe(false)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'refuses when an old-design socket holder is still alive',
    async () => {
      const dir = tmpdir()
      /* an old-version holder has no file lock — only its socket proves it;
       the lock design sweeps dead sockets but a live one still owns the dir */
      const child = spawn(
        process.execPath,
        [
          '-e',
          `const s=require('net').createServer(c=>c.end(JSON.stringify({pid:process.pid,host:'${os.hostname()}'})+'\\n'));
         s.listen(${JSON.stringify(sockFile(dir))},()=>console.log('listening'));setInterval(()=>{},60000)`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      children.push(child)
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', (d: Buffer) => {
          if (d.toString().includes('listening')) resolve()
        })
        child.once('exit', () => reject(new Error('legacy holder exited early')))
        setTimeout(() => reject(new Error('socket never listened')), 15_000)
      })
      await expect(acquireDataLock(dir)).rejects.toThrow(DataDirInUseError)
      /* the live socket file must survive — it is the holder's proof */
      expect(fs.existsSync(sockFile(dir))).toBe(true)
    },
    30_000,
  )
})
