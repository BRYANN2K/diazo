import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { backupNow, backupPgDir, fileBody, startDailyBackups } from '../server/backup.ts'
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

/** A fake client whose backup_label names a REAL WAL range — the shape
 *  Postgres actually returns — so the coverage check engages. `stopLsn`
 *  is where pg_backup_stop says backup mode ended. */
function fakeClientWithWal(opts: { segment: string; stopLsn: string; segSize?: string }) {
  const calls: string[] = []
  const label = [
    'START WAL LOCATION: 0/5000028 (file ' + opts.segment + ')',
    'CHECKPOINT LOCATION: 0/5000060',
    'BACKUP METHOD: streamed',
    'BACKUP FROM: primary',
    `START TIME: ${new Date().toISOString()}`,
    'LABEL: diazo-test',
  ].join('\n')
  const client = {
    calls,
    query: async (sql: string) => {
      calls.push(sql)
      if (sql.includes('pg_backup_start')) return { rows: [{ pg_backup_start: '0/5000028' }] }
      if (sql.includes('pg_backup_stop')) return { rows: [{ lsn: opts.stopLsn, labelfile: label, spcmapfile: '' }] }
      if (sql.includes('wal_segment_size')) return { rows: [{ wal_segment_size: opts.segSize ?? '16MB' }] }
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

/** Drain a byte generator into one buffer — fileBody yields piece by piece. */
async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of gen) parts.push(part)
  return Buffer.concat(parts)
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
    await fs.mkdir(path.join(backups, 'pg-2020-01-02T00-00-00-000Z.walhold'))
    await fs.writeFile(path.join(backups, 'pg-2020-01-02T00-00-00-000Z.walhold', '000000010000000000000001'), 'x')
    await fs.writeFile(path.join(backups, 'pg-2020-01-03T00-00-00-000Z.assets.json'), '{}')

    await backupPgDir(pg, 'pre-migration')

    const names = await fs.readdir(backups)
    expect(names.filter((n) => /\.(?:tmp|work|walhold)$/.test(n))).toEqual([])
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

  /* -- finding: the WAL the label needs could be recycled between
        pg_backup_stop and the copy, publishing an unrestorable archive -- */

  it('fails loudly when WAL the label requires was already recycled — nothing is published', async () => {
    const data = tmpDataDir()
    const pg = await seedPgDir(data)
    /* the postmaster's side: pg_wal exists but the start segment is gone —
       exactly what a checkpoint between stop and copy produces */
    await fs.mkdir(path.join(pg, 'pg_wal'), { recursive: true })
    await fs.writeFile(path.join(pg, 'pg_wal', '000000010000000000000006'), 'current-wal')

    /* label requires segment …05 through the stop lsn's segment …06 */
    await expect(
      backupNow(fakeClientWithWal({ segment: '000000010000000000000005', stopLsn: '0/6000100' }), 'daily'),
    ).rejects.toThrow(/required WAL was recycled/)

    /* no archive, no manifest, no leftovers — an unrestorable pair must
       never exist under a backup's name */
    const names = (await fs.readdir(path.join(data, 'backups'))).filter((n) => n.startsWith('pg-'))
    expect(names).toEqual([])
  })

  it('retains every WAL segment the label names — the range lands in the archive', async () => {
    const data = tmpDataDir()
    const pg = await seedPgDir(data)
    const wal = path.join(pg, 'pg_wal')
    await fs.mkdir(wal, { recursive: true })
    /* the two segments the range 0x05..0x06 spans — written mid-backup or
       not, the hoarder must hold both before the label is proved */
    await fs.writeFile(path.join(wal, '000000010000000000000005'), 'start-segment')
    await fs.writeFile(path.join(wal, '000000010000000000000006'), 'stop-segment')
    /* archive_status lives in pg_wal but is runtime state, not WAL */
    await fs.mkdir(path.join(wal, 'archive_status'))

    const { archive } = await backupNow(
      fakeClientWithWal({ segment: '000000010000000000000005', stopLsn: '0/6000100' }),
      'daily',
    )

    const raw = gunzipSync(await fs.readFile(archive))
    expect(raw.includes(Buffer.from('pg_wal/000000010000000000000005'))).toBe(true)
    expect(raw.includes(Buffer.from('pg_wal/000000010000000000000006'))).toBe(true)
    expect(raw.includes(Buffer.from('start-segment'))).toBe(true)
    /* and the hold dir is swept once the backup is done */
    expect((await fs.readdir(path.join(data, 'backups'))).filter((n) => n.endsWith('.walhold'))).toEqual([])
  })

  /* -- finding: backups were written world-readable under a permissive
        umask; dir, archive and manifest must be owner-only -- */

  it('keeps the backup tree private under a permissive umask — 0700 dir, 0600 files', async () => {
    const data = tmpDataDir()
    const pg = await seedPgDir(data)
    const wal = path.join(pg, 'pg_wal')
    await fs.mkdir(wal, { recursive: true })
    await fs.writeFile(path.join(wal, '000000010000000000000005'), 'wal')

    const saved = process.umask(0o022)
    try {
      const { archive, manifest } = await backupNow(
        fakeClientWithWal({ segment: '000000010000000000000005', stopLsn: '0/5000100' }),
        'daily',
      )
      expect(statSync(path.join(data, 'backups')).mode & 0o777).toBe(0o700)
      expect(statSync(archive).mode & 0o777).toBe(0o600)
      expect(statSync(manifest).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(saved)
    }
  })

  /* -- finding: a file changing while archived must yield exactly the
        statted bytes — grown tail ignored, shrunk body zero-padded -- */

  it('reads exactly the statted length of a file that grew after open', async () => {
    const data = tmpDataDir()
    const file = path.join(data, 'growing')
    await fs.writeFile(file, Buffer.alloc(70000, 0x62)) /* spans two stream chunks */
    const handle = await fs.open(file)
    try {
      const size = (await handle.stat()).size
      await fs.appendFile(file, Buffer.alloc(30000, 0x63)) /* grows under the open handle */
      const body = await collect(fileBody(handle, size))
      /* exactly `size` payload bytes, then tar padding to the 512 block —
         the grown tail never enters the archive */
      expect(body.length).toBe(70144)
      expect(body.subarray(0, 70000).every((b) => b === 0x62)).toBe(true)
      expect(body.subarray(70000).every((b) => b === 0)).toBe(true)
    } finally {
      await handle.close()
    }
  })

  it('zero-pads a file that shrank after open — pg_basebackup semantics', async () => {
    const data = tmpDataDir()
    const file = path.join(data, 'shrinking')
    await fs.writeFile(file, Buffer.alloc(600, 0x64))
    const handle = await fs.open(file)
    try {
      const size = (await handle.stat()).size
      await fs.truncate(file, 10)
      const body = await collect(fileBody(handle, size))
      /* still `size` payload + padding: a short file zero-fills rather
         than corrupting the tar's block alignment */
      expect(body.length).toBe(1024)
      expect(body.subarray(0, 10).every((b) => b === 0x64)).toBe(true)
      expect(body.subarray(10).every((b) => b === 0)).toBe(true)
    } finally {
      await handle.close()
    }
  })
})
