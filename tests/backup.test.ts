import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { backupNow, listBackups, startDailyBackups, verifyPgDir } from '../server/backup.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * server/backup.ts: a verified snapshot of PGlite's data dir — copied
 * under the database's own runExclusive mutex, reopened before anything
 * is published — streamed into pg-<date>.tar.gz plus its
 * pg-<date>.manifest.json under <DOOP_DATA_DIR>/backups. A pair counts
 * once both files exist: manifest renamed first, archive last. Seven
 * dailies and three of every other reason pooled are kept.
 */

/* gzip writes stay small; the mock just counts chunk sizes for the
   64 MiB test — everything else passes straight through */
const writeChunks: number[] = []
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    createWriteStream: (
      file: Parameters<typeof real.createWriteStream>[0],
      options?: Parameters<typeof real.createWriteStream>[1],
    ) => {
      const stream = real.createWriteStream(file, options)
      const write = stream.write.bind(stream)
      stream.write = (chunk: unknown, ...rest: never[]) => {
        if (chunk instanceof Uint8Array) writeChunks.push(chunk.length)
        return write(chunk, ...rest)
      }
      return stream
    },
  }
})

const dirs: string[] = []
const pglites: PGlite[] = []

function tmpDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backup-test-'))
  dirs.push(dir)
  stubEnv('DOOP_DATA_DIR', dir)
  return dir
}

/** A client that checkpoints and runs the copy through its mutex and
 *  nothing else — the data dir on disk is a real one, so verifyPgDir
 *  reopens a genuine snapshot. */
function fakeClient() {
  const calls: string[] = []
  const client = {
    calls,
    query: async (sql: string) => {
      calls.push(sql)
      return { rows: [] }
    },
    runExclusive: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  } as unknown as PGlite & { calls: string[] }
  return client
}

/** A real PGlite data dir on disk — populated, then closed so only the
 *  backup's own client touches it. */
async function seedRealPgDir(data: string): Promise<void> {
  const pg = new PGlite(path.join(data, 'pg'))
  pglites.push(pg)
  await pg.query('create table keepme (id serial primary key, v text)')
  await pg.query("insert into keepme (v) values ('seeded')")
  await pg.query('CHECKPOINT')
  await pg.close()
  pglites.pop()
}

async function readManifest(file: string) {
  return JSON.parse(await fs.readFile(file, 'utf8')) as {
    format: number
    reason: string
    build: string | null
    migrations: { count: number; newest: number }
    archive: { bytes: number; sha256: string }
    assets: { key: string; bytes: number }[]
  }
}

/** Poll until `probe` yields — startDailyBackups' boot check is
 *  fire-and-forget, and probe errors (a dir that does not exist yet)
 *  just mean "not yet". */
async function waitFor<T>(probe: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
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
  writeChunks.length = 0
})

describe('server/backup.ts', () => {
  it('writes a verified snapshot pair — the manifest describes the archive on disk', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    await fs.mkdir(path.join(data, 'assets', 'canvas1'), { recursive: true })
    await fs.writeFile(path.join(data, 'assets', 'logo.png'), 'png-bytes')
    await fs.writeFile(path.join(data, 'assets', 'canvas1', 'font.woff2'), 'font-bytes')

    const client = fakeClient()
    const { archive, manifest } = await backupNow(client, 'daily')

    expect(path.dirname(archive)).toBe(path.join(data, 'backups'))
    expect(path.basename(manifest)).toMatch(/\.manifest\.json$/)
    expect(client.calls).toContain('CHECKPOINT')

    /* a real ustar.gz holding the snapshot relative to pg's root */
    const raw = gunzipSync(await fs.readFile(archive))
    expect(raw.subarray(257, 262).toString('latin1')).toBe('ustar')
    expect(raw.includes(Buffer.from('PG_VERSION'))).toBe(true)

    const body = await readManifest(manifest)
    expect(body.format).toBe(1)
    expect(body.reason).toBe('daily')
    /* sha256 and bytes are measured on the archive's own bytes */
    const onDisk = await fs.readFile(archive)
    expect(body.archive.sha256).toBe(createHash('sha256').update(onDisk).digest('hex'))
    expect(body.archive.bytes).toBe(onDisk.length)
    expect(body.assets).toEqual([
      { key: 'canvas1/font.woff2', bytes: 'font-bytes'.length },
      { key: 'logo.png', bytes: 'png-bytes'.length },
    ])
    expect(body.migrations.count).toBe(0)
  }, 60_000)

  /* AC-14: a live writer cannot race the snapshot */
  it('the restore carries exactly the commits that preceded the snapshot — a running writer proves it', async () => {
    const data = tmpDataDir()
    const pg = new PGlite(path.join(data, 'pg'))
    pglites.push(pg)
    await pg.query('create table accounts (id int primary key, cents int)')
    await pg.query('create table ledger (n int)')
    await pg.query('insert into accounts values (1, 0), (2, 0)')

    let commits = 0
    let stopped = false
    const writer = (async () => {
      while (!stopped) {
        commits++
        const n = commits
        await pg.transaction(async (tx) => {
          await tx.query('update accounts set cents = cents - 1 where id = 1')
          await tx.query('update accounts set cents = cents + 1 where id = 2')
          await tx.query(`insert into ledger (n) values (${n})`)
        })
        if (commits % 7 === 0) await pg.query('select pg_switch_wal()')
        if (commits % 11 === 0) await pg.query('CHECKPOINT')
        /* PGlite calls alone starve the timers this test needs — yield
           for real each turn */
        await new Promise((r) => setImmediate(r))
      }
    })()

    const backup = backupNow(pg, 'daily')
    const { archive } = await backup
    /* the mutex blocks the writer while the copy runs — commits at the
       snapshot cannot exceed this count */
    const snapshotCommits = commits
    for (let i = 0; i < 4; i++) {
      await pg.query('select pg_switch_wal()')
      await pg.query('CHECKPOINT')
      await new Promise((r) => setImmediate(r))
    }
    stopped = true
    await writer
    expect(snapshotCommits).toBeGreaterThan(0)

    /* unpack in a child process and reopen — the snapshot must show every
       commit before it and none after */
    const out = path.join(data, 'restored')
    await fs.mkdir(out)
    const tar = spawnSync('tar', ['-xzf', archive, '-C', out], { encoding: 'utf8' })
    expect(tar.status).toBe(0)
    const probe = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `(async () => {
          const { PGlite } = await import('@electric-sql/pglite')
          const pg = new PGlite(process.argv[1])
          const rows = await pg.query('select (select coalesce(max(n),0) from ledger) as m, (select count(*)::int from ledger) as c, (select coalesce(sum(cents),0) from accounts) as s')
          console.log(JSON.stringify(rows.rows[0]))
          await pg.close()
        })()`,
        out,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    )
    expect(probe.status, probe.stderr).toBe(0)
    const result = JSON.parse(probe.stdout.trim()) as { m: number | string; c: number; s: number | string }
    /* the invariant held through every snapshot: transfers are atomic */
    expect(Number(result.s)).toBe(0)
    /* no gaps — every commit in the ledger is whole — and none after the
       snapshot point */
    expect(Number(result.c)).toBe(Number(result.m))
    expect(Number(result.m)).toBeLessThanOrEqual(snapshotCommits)
  }, 180_000)

  /* AC-15: a published archive unpacks with the system tar and reopens */
  it.skipIf(process.platform === 'win32')(
    'a published archive unpacked by system tar xzf opens with PGlite',
    async () => {
      const data = tmpDataDir()
      await seedRealPgDir(data)
      const { archive } = await backupNow(fakeClient(), 'daily')
      const out = path.join(data, 'unpack')
      await fs.mkdir(out)
      const tar = spawnSync('tar', ['-xzf', archive, '-C', out], { encoding: 'utf8' })
      expect(tar.status, tar.stderr).toBe(0)
      const restored = new PGlite(out)
      pglites.push(restored)
      const rows = await restored.query<{ v: string }>('select v from keepme')
      expect(rows.rows[0]?.v).toBe('seeded')
    },
    120_000,
  )

  /* AC-16: a stage that cannot reopen is never published */
  it('a stage the verification cannot reopen publishes nothing — no archive, manifest or stage', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    const backups = path.join(data, 'backups')
    await expect(
      backupNow(fakeClient(), 'daily', {
        onStaged: async (stage) => {
          /* pg_control is the first thing Postgres reads — a zeroed one
             is unambiguously dead */
          await fs.writeFile(path.join(stage, 'pg', 'global', 'pg_control'), Buffer.alloc(8192, 0))
        },
      }),
    ).rejects.toThrow()
    const names = (await fs.readdir(backups)).filter((n) => n.startsWith('pg-'))
    expect(names).toEqual([])
  }, 60_000)

  /* AC-17: the write stream is bounded — no 64 MiB member lands in one chunk */
  it('no chunk reaching the write stream exceeds 1 MiB on a 64 MiB relation', async () => {
    const data = tmpDataDir()
    const pg = new PGlite(path.join(data, 'pg'))
    pglites.push(pg)
    /* 64 MiB of hex-random bytes — incompressible, so the archive itself
       is big enough that a buffered whole-member stream would show up */
    await pg.query('create table big (v bytea)')
    await pg.query(
      `insert into big select decode(repeat(md5(random()::text), 131072), 'hex') from generate_series(1, 32)`,
    )
    await pg.query('CHECKPOINT')
    await pg.close()
    pglites.pop()

    await backupNow(fakeClient(), 'daily')
    expect(writeChunks.length).toBeGreaterThan(0)
    expect(Math.max(...writeChunks)).toBeLessThanOrEqual(1024 * 1024)
  }, 240_000)

  /* AC-18: overlapping calls are serialized — both publish, never race */
  it('two backupNow calls started together both resolve to complete, distinct pairs', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    const [a, b] = await Promise.all([backupNow(fakeClient(), 'daily'), backupNow(fakeClient(), 'manual')])
    expect(a.archive).not.toBe(b.archive)
    expect(a.manifest).not.toBe(b.manifest)
    const pairs = await listBackups()
    expect(pairs.map((p) => p.archive).sort()).toEqual([a.archive, b.archive].sort())
    for (const file of [a.archive, a.manifest, b.archive, b.manifest]) {
      expect(await fs.stat(file).then(() => true)).toBe(true)
    }
  }, 60_000)

  /* AC-19: torn leftovers are swept; an archive alone is never ours */
  it('sweeps a manifest without archive, a .tmp and a .stage — keeps the archive without manifest', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    await fs.writeFile(path.join(backups, 'pg-2020-01-01T00-00-00-000Z.tar.gz.tmp'), 'torn')
    await fs.mkdir(path.join(backups, 'pg-2020-01-02T00-00-00-000Z.stage'))
    await fs.writeFile(path.join(backups, 'pg-2020-01-02T00-00-00-000Z.stage', 'file'), 'x')
    await fs.writeFile(path.join(backups, 'pg-2020-01-03T00-00-00-000Z.manifest.json'), '{}')
    await fs.writeFile(path.join(backups, 'pg-2020-01-04T00-00-00-000Z.tar.gz'), 'not-ours')

    startDailyBackups(fakeClient())
    /* no complete pair exists — the overdue check must back up */
    const fresh = await waitFor(async () =>
      (await fs.readdir(backups)).find(
        (n) => n.endsWith('.tar.gz') && !n.startsWith('pg-2020-01-04') && !n.endsWith('.tmp'),
      ),
    )
    expect(fresh).toBeTruthy()
    /* the backup's own stage is removed in its finally — wait for the
       cleanup, not just the published name */
    await waitFor(async () => ((await fs.readdir(backups)).some((n) => /\.(?:tmp|stage)$/.test(n)) ? undefined : true))

    const names = await fs.readdir(backups)
    expect(names.filter((n) => /\.(?:tmp|stage)$/.test(n))).toEqual([])
    expect(names).not.toContain('pg-2020-01-03T00-00-00-000Z.manifest.json')
    /* the archive without a manifest is never ours — kept, uncounted */
    expect(names).toContain('pg-2020-01-04T00-00-00-000Z.tar.gz')
    const pairs = (await listBackups()).map((p) => p.stamp)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toBe(fresh!.replace(/^pg-/, '').replace(/\.tar\.gz$/, ''))
  }, 60_000)

  /* AC-20: privacy survives a permissive umask */
  it.skipIf(process.platform === 'win32')(
    'keeps the backup tree private under umask 000 — 0700 dir, 0600 files',
    async () => {
      const data = tmpDataDir()
      await seedRealPgDir(data)
      const saved = process.umask(0o000)
      try {
        const { archive, manifest } = await backupNow(fakeClient(), 'daily')
        expect(statSync(path.join(data, 'backups')).mode & 0o777).toBe(0o700)
        expect(statSync(archive).mode & 0o777).toBe(0o600)
        expect(statSync(manifest).mode & 0o777).toBe(0o600)
      } finally {
        process.umask(saved)
      }
    },
    60_000,
  )

  /* AC-21: retention — seven dailies plus three of every other reason */
  it('keeps the seven newest dailies and the three newest of the other reasons', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    const manifest = (reason: string) =>
      JSON.stringify({
        format: 1,
        at: '2020-01-01T00:00:00Z',
        reason,
        build: null,
        migrations: { count: 0, newest: 0 },
        archive: { bytes: 1, sha256: 'x' },
        assets: [],
      })
    for (let i = 1; i <= 9; i++) {
      const stamp = `2020-01-0${i}T00-00-00-000Z`
      await fs.writeFile(path.join(backups, `pg-${stamp}.tar.gz`), 'old')
      await fs.writeFile(path.join(backups, `pg-${stamp}.manifest.json`), manifest('daily'))
    }
    for (let i = 1; i <= 4; i++) {
      const stamp = `2020-02-0${i}T00-00-00-000Z`
      await fs.writeFile(path.join(backups, `pg-${stamp}.tar.gz`), 'old')
      await fs.writeFile(path.join(backups, `pg-${stamp}.manifest.json`), manifest('pre-migration'))
    }

    await backupNow(fakeClient(), 'daily')

    const pairs = await listBackups()
    const dailyStamps = pairs.filter((p) => p.manifest.reason === 'daily').map((p) => p.stamp)
    const otherStamps = pairs.filter((p) => p.manifest.reason === 'pre-migration').map((p) => p.stamp)
    expect(dailyStamps).toHaveLength(7)
    expect(otherStamps).toEqual(['2020-02-02T00-00-00-000Z', '2020-02-03T00-00-00-000Z', '2020-02-04T00-00-00-000Z'])
    /* the pruned pairs lost both files */
    expect((await fs.readdir(backups)).length).toBe(pairs.length * 2)
  }, 60_000)

  it('backs up at boot when the newest complete pair is older than a day', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    const stamp = '2020-01-01T00-00-00-000Z'
    await fs.writeFile(path.join(backups, `pg-${stamp}.tar.gz`), 'old')
    await fs.writeFile(
      path.join(backups, `pg-${stamp}.manifest.json`),
      JSON.stringify({ format: 1, at: '2020-01-01T00:00:00.000Z', reason: 'daily' }),
    )

    startDailyBackups(fakeClient())
    const name = await waitFor(async () =>
      (await fs.readdir(backups)).find((n) => n.endsWith('.tar.gz') && n !== `pg-${stamp}.tar.gz`),
    )
    expect(name).toBeTruthy()
  }, 60_000)

  it('backs up at boot when no backup exists yet', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    startDailyBackups(fakeClient())
    const name = await waitFor(async () =>
      (await fs.readdir(path.join(data, 'backups'))).find((n) => n.endsWith('.tar.gz')),
    )
    expect(name).toBeTruthy()
  }, 60_000)

  it('skips the boot backup while the newest complete pair is fresh', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.writeFile(path.join(backups, `pg-${stamp}.tar.gz`), 'recent')
    await fs.writeFile(
      path.join(backups, `pg-${stamp}.manifest.json`),
      JSON.stringify({ format: 1, at: new Date().toISOString(), reason: 'daily' }),
    )

    startDailyBackups(fakeClient())
    /* give the overdue check a real chance to run — then the only pair
       is still the fresh one */
    await waitFor(async () => {
      const pairs = await listBackups()
      return pairs.length === 1 ? true : undefined
    })
    await new Promise((r) => setTimeout(r, 500))
    expect((await fs.readdir(backups)).filter((n) => n.endsWith('.tar.gz'))).toEqual([`pg-${stamp}.tar.gz`])
  }, 60_000)

  it('refuses a non-regular member in the stage and publishes nothing', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    /* a symlink is not a regular file — the stage is archived whole, so
       the tar refuses it rather than archive it wrong */
    await fs.symlink('elsewhere', path.join(data, 'pg', 'stray-link'))
    await expect(backupNow(fakeClient(), 'daily')).rejects.toThrow(/cannot archive/)
    const names = (await fs.readdir(path.join(data, 'backups'))).filter((n) => n.startsWith('pg-'))
    expect(names).toEqual([])
  }, 60_000)

  it('verifyPgDir reports the applied journal of a live copy', async () => {
    const data = tmpDataDir()
    await seedRealPgDir(data)
    const result = await verifyPgDir(path.join(data, 'pg'))
    /* the seeded dir has user tables but no drizzle journal yet */
    expect(result).toEqual({ count: 0, newest: 0 })
  }, 60_000)
})
