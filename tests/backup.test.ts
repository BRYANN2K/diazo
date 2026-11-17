import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { backupNow, backupPgDir, startDailyBackups } from '../server/backup.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * server/backup.ts: a tar.gz of PGlite's data dir plus a manifest of the
 * on-disk assets the dump cannot contain, under <DOOP_DATA_DIR>/backups —
 * complete pairs only, newest seven kept. The hot path runs on the LIVE
 * database through pg_backup_start/stop and streams the files, so a big
 * install never lands in memory and a restore replays its WAL; the cold
 * path tars the quiescent dir in place. Clients are real or stubbed —
 * never dumpDataDir, which would buffer the whole dir.
 */

const dirs: string[] = []
const pglites: PGlite[] = []

function tmpDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backup-test-'))
  dirs.push(dir)
  stubEnv('DOOP_DATA_DIR', dir)
  return dir
}

/** A client that answers the live-backup SQL and nothing else — if the
 *  backup ever went back to dumpDataDir there is no such method to call. */
function fakeClient() {
  const calls: string[] = []
  const client = {
    calls,
    query: async (sql: string) => {
      calls.push(sql)
      if (sql.includes('pg_backup_start')) return { rows: [{ pg_backup_start: '0/0' }] }
      if (sql.includes('pg_backup_stop')) return { rows: [{ lsn: '0/0', labelfile: 'BACKUP LABEL\n', spcmapfile: '' }] }
      return { rows: [] }
    },
    syncToFs: async () => {},
  } as unknown as PGlite & { calls: string[] }
  return client
}

/** A small on-disk pg dir — backupNow and backupPgDir both read real files. */
async function seedPgDir(data: string): Promise<string> {
  const pg = path.join(data, 'pg')
  await fs.mkdir(path.join(pg, 'base', '16384'), { recursive: true })
  await fs.writeFile(path.join(pg, 'PG_VERSION'), '16\n')
  await fs.writeFile(path.join(pg, 'base', '16384', '12345'), Buffer.alloc(1500, 0x61))
  return pg
}

/** Poll until `probe` yields — startDailyBackups' boot check is
 *  fire-and-forget, and probe errors (a dir that does not exist yet)
 *  just mean "not yet". */
async function waitFor<T>(probe: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const found = await probe().catch(() => undefined)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${ms}ms`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

afterEach(async () => {
  unstubAllEnvs()
  for (const pg of pglites.splice(0)) await pg.close().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('server/backup.ts', () => {
  it('writes a tar.gz of the live dir and an asset manifest, in backup mode', async () => {
    const data = tmpDataDir()
    await seedPgDir(data)
    await fs.mkdir(path.join(data, 'assets', 'canvas1'), { recursive: true })
    await fs.writeFile(path.join(data, 'assets', 'logo.png'), 'png-bytes')
    await fs.writeFile(path.join(data, 'assets', 'canvas1', 'font.woff2'), 'font-bytes')

    const client = fakeClient()
    const { archive, manifest } = await backupNow(client, 'daily')

    expect(path.dirname(archive)).toBe(path.join(data, 'backups'))
    expect(path.dirname(manifest)).toBe(path.join(data, 'backups'))
    /* backup mode bracketed the copy and produced the label */
    expect(client.calls[0]).toContain('pg_backup_start')
    expect(client.calls.some((sql) => sql.includes('pg_backup_stop'))).toBe(true)
    /* the archive is a real ustar.gz holding the dir's files relative to
       pg's root, plus the backup_label pg_backup_stop hands back */
    const raw = gunzipSync(await fs.readFile(archive))
    expect(raw.subarray(257, 262).toString('latin1')).toBe('ustar')
    expect(raw.includes(Buffer.from('PG_VERSION'))).toBe(true)
    expect(raw.includes(Buffer.from('base/16384/12345'))).toBe(true)
    expect(raw.includes(Buffer.from('backup_label'))).toBe(true)

    const body = JSON.parse(await fs.readFile(manifest, 'utf8')) as {
      reason: string
      assets: { key: string; bytes: number }[]
    }
    expect(body.reason).toBe('daily')
    expect(body.assets).toEqual([
      { key: 'canvas1/font.woff2', bytes: 'font-bytes'.length },
      { key: 'logo.png', bytes: 'png-bytes'.length },
    ])
  })

  it('keeps only the seven newest complete pairs', async () => {
    const data = tmpDataDir()
    await seedPgDir(data)
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    for (let i = 1; i <= 8; i++) {
      const stamp = `2020-01-0${i}T00-00-00-000Z`
      await fs.writeFile(path.join(backups, `pg-${stamp}.tar.gz`), 'old')
      await fs.writeFile(path.join(backups, `pg-${stamp}.assets.json`), '{}')
    }

    await backupNow(fakeClient(), 'pre-migration')

    const names = (await fs.readdir(backups)).sort()
    const stamps = [...new Set(names.map((n) => /^pg-(.+?)(?:\.tar\.gz|\.assets\.json)$/.exec(n)?.[1]))]
    expect(stamps).toHaveLength(7)
    /* the two oldest pre-existing pairs are the ones dropped */
    expect(stamps).not.toContain('2020-01-01T00-00-00-000Z')
    expect(stamps).not.toContain('2020-01-02T00-00-00-000Z')
    expect(stamps).toContain('2020-01-08T00-00-00-000Z')
    /* every surviving stamp has both files */
    expect(names.length).toBe(14)
  })

  it('records an empty manifest when no assets exist yet', async () => {
    const data = tmpDataDir()
    await seedPgDir(data)
    const { manifest } = await backupNow(fakeClient(), 'pre-migration')
    const body = JSON.parse(await fs.readFile(manifest, 'utf8')) as { assets: unknown[] }
    expect(body.assets).toEqual([])
  })

  it('leaves no archive at all when the copy dies mid-write', async () => {
    const data = tmpDataDir()
    const pg = await seedPgDir(data)
    const backups = path.join(data, 'backups')
    /* a symlink is not a regular file — the tar refuses it mid-walk, and
       the torn .tmp must not masquerade as a backup */
    await fs.mkdir(path.join(pg, 'pg_xact'))
    await fs.symlink('elsewhere', path.join(pg, 'pg_xact', 'link'))
    await expect(backupNow(fakeClient(), 'daily')).rejects.toThrow(/cannot archive/)
    expect((await fs.readdir(backups)).filter((n) => n.startsWith('pg-'))).toEqual([])
  })

  it('preserves directory modes a restore can traverse — a real unpack', async () => {
    const data = tmpDataDir()
    const pg = await seedPgDir(data)
    /* PGlite's data dirs are 0700: a flat 0644 in the archive would
       extract a database nobody can open */
    await fs.chmod(path.join(pg, 'base'), 0o700)
    await fs.chmod(path.join(pg, 'base', '16384'), 0o700)

    const { archive } = await backupPgDir(pg, 'pre-migration')

    const out = path.join(data, 'unpack')
    await fs.mkdir(out)
    const tar = spawnSync('tar', ['-xzf', archive, '-C', out], { encoding: 'utf8' })
    expect(tar.status).toBe(0)
    expect((await fs.stat(path.join(out, 'base'))).mode & 0o700).toBe(0o700)
    expect((await fs.stat(path.join(out, 'base', '16384'))).mode & 0o700).toBe(0o700)
    /* the nested marker reads as an ordinary user — not Permission denied */
    expect((await fs.readFile(path.join(out, 'base', '16384', '12345'))).length).toBe(1500)
  })

  it('backs up a live database through pg_backup_start — and the restore replays it', async () => {
    const data = tmpDataDir()
    const pg = new PGlite(path.join(data, 'pg'))
    pglites.push(pg)
    await pg.query('create table keepme (id serial primary key, v text)')
    await pg.query("insert into keepme (v) values ('before-backup')")

    const backup = backupNow(pg, 'daily')
    /* a write that commits while the archive streams still makes it into
       the backup — the second WAL pass carries it */
    await pg.query("insert into keepme (v) values ('during-backup')")
    const { archive } = await backup

    /* unpack by hand — the documented restore — and reopen the dir */
    const out = path.join(data, 'unpack')
    await fs.mkdir(out)
    const tar = spawnSync('tar', ['-xzf', archive, '-C', out], { encoding: 'utf8' })
    expect(tar.status).toBe(0)
    const restored = new PGlite(out)
    pglites.push(restored)
    const rows = await restored.query<{ v: string }>('select v from keepme order by id')
    expect(rows.rows.map((r) => r.v)).toEqual(['before-backup', 'during-backup'])
  }, 120_000)

  it('sweeps torn .tmp/.work leftovers and orphaned manifests under the data lock', async () => {
    const data = tmpDataDir()
    const pg = await seedPgDir(data)
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    await fs.writeFile(path.join(backups, 'pg-2020-01-01T00-00-00-000Z.tar.gz.tmp'), 'torn')
    await fs.mkdir(path.join(backups, 'pg-2020-01-02T00-00-00-000Z.work'))
    await fs.writeFile(path.join(backups, 'pg-2020-01-02T00-00-00-000Z.work', 'file'), 'x')
    await fs.writeFile(path.join(backups, 'pg-2020-01-03T00-00-00-000Z.assets.json'), '{}')

    await backupPgDir(pg, 'pre-migration')

    const names = await fs.readdir(backups)
    expect(names.filter((n) => /\.(?:tmp|work)$/.test(n))).toEqual([])
    expect(names).not.toContain('pg-2020-01-03T00-00-00-000Z.assets.json')
  })

  it('does not count an archive without its manifest as a backup', async () => {
    const data = tmpDataDir()
    await seedPgDir(data)
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    /* a crash mid-publish leaves exactly this: an archive whose manifest
       never landed — it is torn state, not today's backup */
    const stamp = '2020-06-01T00-00-00-000Z'
    await fs.writeFile(path.join(backups, `pg-${stamp}.tar.gz`), 'archive-only')
    const fresh = new Date()
    await fs.utimes(path.join(backups, `pg-${stamp}.tar.gz`), fresh, fresh)

    startDailyBackups(fakeClient())

    const name = await waitFor(async () =>
      (await fs.readdir(backups)).find((n) => n.endsWith('.tar.gz') && n !== `pg-${stamp}.tar.gz`),
    )
    expect(name).toBeTruthy()
  })

  it('backs up at boot when the newest complete pair is older than a day', async () => {
    const data = tmpDataDir()
    await seedPgDir(data)
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    const stamp = '2020-01-01T00-00-00-000Z'
    await fs.writeFile(path.join(backups, `pg-${stamp}.tar.gz`), 'old')
    await fs.writeFile(path.join(backups, `pg-${stamp}.assets.json`), '{}')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000)
    await fs.utimes(path.join(backups, `pg-${stamp}.tar.gz`), twoDaysAgo, twoDaysAgo)

    startDailyBackups(fakeClient())

    const name = await waitFor(async () =>
      (await fs.readdir(backups)).find((n) => n.endsWith('.tar.gz') && n !== `pg-${stamp}.tar.gz`),
    )
    expect(name).toBeTruthy()
  })

  it('backs up at boot when no backup exists yet', async () => {
    const data = tmpDataDir()
    await seedPgDir(data)
    startDailyBackups(fakeClient())
    const name = await waitFor(async () =>
      (await fs.readdir(path.join(data, 'backups'))).find((n) => n.endsWith('.tar.gz')),
    )
    expect(name).toBeTruthy()
  })

  it('skips the boot backup while the newest complete pair is fresh', async () => {
    const data = tmpDataDir()
    await seedPgDir(data)
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.writeFile(path.join(backups, `pg-${stamp}.tar.gz`), 'recent')
    await fs.writeFile(path.join(backups, `pg-${stamp}.assets.json`), '{}')

    startDailyBackups(fakeClient())
    await new Promise((r) => setTimeout(r, 300))

    expect((await fs.readdir(backups)).filter((n) => n.endsWith('.tar.gz'))).toEqual([`pg-${stamp}.tar.gz`])
  })
})
