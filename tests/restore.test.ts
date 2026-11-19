import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { backupNow } from '../server/backup.ts'
import { completeInterruptedRestore, restoreBackup } from '../server/restore.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * server/restore.ts: a backup pair goes back onto the data dir — sha256
 * checked against its manifest, unpacked into pg.restore-<stamp> by a
 * ustar reader that refuses anything but regular files and directories,
 * reopened with PGlite and refused when newer than this build, then
 * swapped for pg/ by rename — the live dir is never edited in place.
 */

const ROOT = process.cwd()
const HELPER = path.join(ROOT, 'tests', 'fixtures', 'dataLockHelper.ts')

const dirs: string[] = []
const pglites: PGlite[] = []
const children: ChildProcess[] = []

function tmpDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'restore-test-'))
  dirs.push(dir)
  stubEnv('DOOP_DATA_DIR', dir)
  return dir
}

/** A populated pg dir, closed — the backup's own client opens it. */
async function seedRealPgDir(data: string): Promise<void> {
  const pg = new PGlite(path.join(data, 'pg'))
  await pg.query('create table keepme (id serial primary key, v text)')
  await pg.query("insert into keepme (v) values ('seeded')")
  await pg.query('CHECKPOINT')
  await pg.close()
}

/* one ustar member — the restore's reader is fed hand-made archives */
function tarMember(name: string, type: string, body: Buffer = Buffer.alloc(0), linkname = ''): Buffer {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 99), 0)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.write('        ', 148) /* checksum field is spaces while summed */
  header.write(type, 156)
  header.write(linkname.slice(0, 99), 157)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const sum = header.reduce((a, b) => a + b, 0)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  const pad = (512 - (body.length % 512)) % 512
  return Buffer.concat([header, body, Buffer.alloc(pad)])
}

function makeTarGz(members: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]))
}

afterEach(async () => {
  unstubAllEnvs()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const pg of pglites.splice(0)) await pg.close().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('server/restore.ts', () => {
  /* AC-23: the snapshot comes back; the damaged dir is kept aside */
  it('restore puts back the snapshot — the damaged pg moves to pg.replaced-*', async () => {
    const data = tmpDataDir()
    const pg = new PGlite(path.join(data, 'pg'))
    pglites.push(pg)
    await pg.query('create table keepme (id serial primary key, v text)')
    await pg.query("insert into keepme (v) values ('seeded')")
    const { archive } = await backupNow(pg, 'manual')

    /* damage the live dir: rows gone, the table dropped outright */
    await pg.query('delete from keepme')
    await pg.query('drop table keepme')
    await pg.query('create table stray (x int)')
    await pg.close()
    pglites.pop()

    const { replaced } = await restoreBackup(archive)
    expect(replaced).toMatch(/pg\.replaced-/)

    const reopened = new PGlite(path.join(data, 'pg'))
    pglites.push(reopened)
    const rows = await reopened.query<{ v: string }>('select v from keepme')
    expect(rows.rows[0]?.v).toBe('seeded')
    await expect(reopened.query('select * from stray')).rejects.toThrow()
    await reopened.close()
    pglites.pop()

    /* the damaged dir sits beside, intact — keepme is still dropped */
    const damaged = new PGlite(replaced!)
    pglites.push(damaged)
    await expect(damaged.query('select * from keepme')).rejects.toThrow()
    await damaged.close()
    pglites.pop()
  }, 180_000)

  /* AC-24: a flipped archive byte fails the sha256 — pg is untouched */
  it('a corrupted archive fails the sha256 check and leaves pg alone', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    const pg = new PGlite(path.join(data, 'pg'))
    pglites.push(pg)
    const { archive } = await backupNow(pg, 'manual')
    await pg.close()
    pglites.pop()

    const bytes = await fs.readFile(archive)
    const mid = bytes.length >> 1
    bytes[mid] = (bytes[mid] ?? 0) ^ 0xff /* one flipped byte deep inside */
    await fs.writeFile(archive, bytes)

    await expect(restoreBackup(archive)).rejects.toThrow(/sha256/)
    expect(readdirSync(data).filter((n) => /^pg\.replaced-/.test(n))).toEqual([])
    const reopened = new PGlite(path.join(data, 'pg'))
    pglites.push(reopened)
    const rows = await reopened.query<{ v: string }>('select v from keepme')
    expect(rows.rows[0]?.v).toBe('seeded')
  }, 120_000)

  /* AC-25: data newer than this build is refused — every NODE_ENV */
  it('a backup whose journal is newer than the bundle is refused, pg untouched', async () => {
    const data = tmpDataDir()
    const pg = new PGlite(path.join(data, 'pg'))
    pglites.push(pg)
    await pg.query('create schema drizzle')
    await pg.query('create table drizzle.__drizzle_migrations (id serial primary key, hash text, created_at bigint)')
    /* a journal row far past anything this build bundles */
    await pg.query(`insert into drizzle.__drizzle_migrations (hash, created_at) values ('future', ${Date.now() * 10})`)
    await pg.query('create table keepme (id serial primary key, v text)')
    await pg.query('CHECKPOINT')
    const { archive } = await backupNow(pg, 'manual')
    await pg.close()
    pglites.pop()

    await expect(restoreBackup(archive)).rejects.toThrow(/newer build/)
    expect(readdirSync(data).filter((n) => /^pg\.(?:replaced|restore)-/.test(n))).toEqual([])
    const reopened = new PGlite(path.join(data, 'pg'))
    pglites.push(reopened)
    await reopened.query('select 1')
  }, 120_000)

  /* AC-26: traversal and non-file members are refused wholesale */
  it.each([
    ['a ../x member', [tarMember('../x', '0', Buffer.from('escape'))], 'x'],
    ['an absolute member', [tarMember('/etc/diazo-planted', '0', Buffer.from('escape'))], undefined],
    ['a symlink member', [tarMember('link', '2', Buffer.alloc(0), 'pg')], undefined],
  ])(
    'refuses %s and writes nothing outside the restore dir',
    async (_label, members, escaped) => {
      const data = tmpDataDir()
      await seedRealPgDir(data)
      const archive = path.join(data, 'backups', 'pg-2020-01-01T00-00-00-000Z.tar.gz')
      await fs.mkdir(path.dirname(archive), { recursive: true })
      await fs.writeFile(archive, makeTarGz(members))

      await expect(restoreBackup(archive)).rejects.toThrow()
      /* nothing landed outside the restore dir, the stage is swept, pg stays */
      expect(readdirSync(data).filter((n) => /^pg\.(?:replaced|restore)-/.test(n))).toEqual([])
      if (escaped) expect(readdirSync(path.dirname(data))).not.toContain(escaped)
      const reopened = new PGlite(path.join(data, 'pg'))
      pglites.push(reopened)
      const rows = await reopened.query<{ v: string }>('select v from keepme')
      expect(rows.rows[0]?.v).toBe('seeded')
    },
    120_000,
  )

  /* an archive that holds no cluster must leave the live state intact:
     a staged dir without PG_VERSION would let PGlite initdb a fresh
     empty database that then "verifies" — and the swap would install
     nothing over real data */
  it.each([
    ['an empty archive', []],
    [
      'a torn cluster — PG_VERSION but no base/ or global/',
      [tarMember('PG_VERSION', '0', Buffer.from('16')), tarMember('postgresql.conf', '0', Buffer.from('# stub'))],
    ],
  ])(
    'refuses %s and keeps the live pg',
    async (_label, members) => {
      const data = tmpDataDir()
      await seedRealPgDir(data)
      const archive = path.join(data, 'backups', 'pg-2020-01-01T00-00-00-000Z.tar.gz')
      await fs.mkdir(path.dirname(archive), { recursive: true })
      await fs.writeFile(archive, makeTarGz(members))

      await expect(restoreBackup(archive)).rejects.toThrow(/cluster/)
      /* nothing staged, nothing moved aside — pg exactly as seeded */
      expect(readdirSync(data).filter((n) => /^pg\.(?:replaced|restore)-/.test(n))).toEqual([])
      const reopened = new PGlite(path.join(data, 'pg'))
      pglites.push(reopened)
      const rows = await reopened.query<{ v: string }>('select v from keepme')
      expect(rows.rows[0]?.v).toBe('seeded')
    },
    120_000,
  )

  /* restoring an older archive after a newer one: the replaced dir the
     CURRENT operation produced is kept — and the returned path exists */
  it('keeps the replaced dir of the current restore even when its stamp sorts older', async () => {
    const data = tmpDataDir()
    const pg = new PGlite(path.join(data, 'pg'))
    pglites.push(pg)
    await pg.query('create table keepme (id serial primary key, v text)')
    await pg.query("insert into keepme (v) values ('v1')")
    const older = await backupNow(pg, 'manual')
    await pg.query("insert into keepme (v) values ('v2')")
    const newer = await backupNow(pg, 'manual')
    await pg.close()
    pglites.pop()

    /* pin the pairs to fixed stamps — the older archive's stamp must
       sort BELOW a replaced dir a later restore already made */
    const olderStamp = '2020-01-01T00-00-00-000Z'
    const newerStamp = '2025-01-01T00-00-00-000Z'
    const backups = path.join(data, 'backups')
    const restamp = (file: string, stamp: string) =>
      fs.rename(file, path.join(backups, `pg-${stamp}${/\.manifest\.json$/.test(file) ? '.manifest.json' : '.tar.gz'}`))
    await restamp(older.archive, olderStamp)
    await restamp(older.manifest, olderStamp)
    await restamp(newer.archive, newerStamp)
    await restamp(newer.manifest, newerStamp)

    /* the newer archive first: its restore makes pg.replaced-<newer> */
    const first = await restoreBackup(path.join(backups, `pg-${newerStamp}.tar.gz`))
    expect(path.basename(first.replaced!)).toBe(`pg.replaced-${newerStamp}`)

    /* now the OLDER archive: it produces pg.replaced-<older>, which
       sorts BEFORE the existing one — the pruning must not eat it */
    const second = await restoreBackup(path.join(backups, `pg-${olderStamp}.tar.gz`))
    expect(second.replaced).not.toBeNull()
    expect(readdirSync(data)).toContain(`pg.replaced-${olderStamp}`)
    expect(readdirSync(data)).not.toContain(`pg.replaced-${newerStamp}`)
    /* and the path it hands back is real */
    expect(statSync(second.replaced!).isDirectory()).toBe(true)

    /* the restored database really is the older snapshot */
    const reopened = new PGlite(path.join(data, 'pg'))
    pglites.push(reopened)
    const rows = await reopened.query<{ n: number }>('select count(*)::int as n from keepme')
    expect(Number(rows.rows[0]?.n)).toBe(1)
  }, 180_000)

  /* AC-27: the interrupted swap completes or refuses — never limps */
  it('completeInterruptedRestore finishes a ready swap and refuses a lost pg', async () => {
    const data = tmpDataDir()
    const stamp = '2020-01-01T00-00-00-000Z'
    await fs.mkdir(path.join(data, `pg.restore-${stamp}`, 'base'), { recursive: true })
    await fs.writeFile(path.join(data, `pg.restore-${stamp}`, 'PG_VERSION'), '16')
    writeFileSync(path.join(data, `pg.restore-${stamp}.ready`), '')

    completeInterruptedRestore(data)
    expect(readdirSync(data)).toContain('pg')
    expect(readdirSync(path.join(data, 'pg'))).toEqual(['PG_VERSION', 'base'])
    expect(readdirSync(data)).not.toContain(`pg.restore-${stamp}.ready`)

    /* pg missing with only a moved-aside dir: refuse, create nothing */
    rmSync(path.join(data, 'pg'), { recursive: true })
    await fs.mkdir(path.join(data, 'pg.replaced-x'), { recursive: true })
    expect(() => completeInterruptedRestore(data)).toThrow(/interrupted/)
    expect(readdirSync(data)).not.toContain('pg')
  })

  /* AC-28: the data tool refuses while a server holds the lock */
  it('dataTool restore exits non-zero and changes nothing while the lock is held', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    const pg = new PGlite(path.join(data, 'pg'))
    pglites.push(pg)
    await backupNow(pg, 'manual')
    await pg.close()
    pglites.pop()

    const holder = spawn(
      process.execPath,
      ['--import', 'tsx', HELPER, JSON.stringify({ dir: data, mode: 'takeover' })],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(holder)
    let out = ''
    holder.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`holder never held: ${out}`)), 30_000)
      holder.stdout!.on('data', () => {
        if (/holding=\d+/.test(out)) {
          clearTimeout(t)
          resolve()
        }
      })
    })
    /* the holder's own lock/ is already in place — snapshot after it so
       the comparison measures the TOOL, not the holder */
    const before = readdirSync(data).sort()

    const tool = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(ROOT, 'server', 'dataTool.ts'), 'restore', 'latest'],
      { encoding: 'utf8', env: { ...process.env, DOOP_DATA_DIR: data, NODE_ENV: 'development' }, timeout: 60_000 },
    )
    expect(tool.status, tool.stdout + tool.stderr).not.toBe(0)
    expect(tool.stderr + tool.stdout).toMatch(/held|data dir/)
    expect(readdirSync(data).sort()).toEqual(before)
    holder.kill('SIGKILL')
  }, 120_000)
})
