import fs, { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDb, pglite } from '../server/db/index.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * The PGlite migration guards in server/db/index.ts: a data dir stamped by
 * a newer migration set must refuse to boot (running the older build would
 * silently skip applied migrations — a downgrade), and a data dir with
 * pending migrations gets a backup under <data>/backups before the
 * migrator runs. Uses a real PGlite seeded with a fake
 * drizzle.__drizzle_migrations table.
 */

const dirs: string[] = []

function tmpDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guard-test-'))
  dirs.push(dir)
  stubEnv('DOOP_DATA_DIR', dir)
  /* the embedded path only; a developer's exported DATABASE_URL must not
     reroute this test to real Postgres */
  stubEnv('DATABASE_URL', '')
  return dir
}

/** Seed a data dir whose drizzle journal table claims `rows` were applied. */
async function seedMigrationsTable(dir: string, rows: { hash: string; created_at: number }[]): Promise<void> {
  const pgDir = path.join(dir, 'pg')
  fs.mkdirSync(pgDir, { recursive: true })
  const seed = new PGlite(pgDir)
  await seed.query('create schema if not exists drizzle')
  await seed.query(
    'create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)',
  )
  for (const row of rows) {
    await seed.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [
      row.hash,
      row.created_at,
    ])
  }
  await seed.close()
}

afterEach(async () => {
  unstubAllEnvs()
  await pglite()
    ?.close()
    .catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('migration guards (server/db/index.ts)', () => {
  it('refuses a data dir written by a newer migration set', async () => {
    const dir = tmpDataDir()
    await seedMigrationsTable(dir, [{ hash: 'future', created_at: Date.now() + 1e12 }])
    /* the guarded client is the one initDb opens and the guard closes —
       watched on the prototype because initDb never publishes it.
       Assert before restoring: mockReset inside mockRestore clears the
       recorded calls */
    const close = vi.spyOn(PGlite.prototype, 'close')
    await expect(initDb()).rejects.toThrow(/newer build/)
    expect(close).toHaveBeenCalledOnce()
    close.mockRestore()
    /* and no half-initialized handle leaked to callers */
    expect(pglite()).toBeUndefined()
  }, 120_000)

  it('warns and boots past a newer data dir when NODE_ENV=development', async () => {
    /* a dev checkout moves one data dir between branches — refusing here
       would strand anyone switching back from a branch with an extra
       migration */
    stubEnv('NODE_ENV', 'development')
    const dir = tmpDataDir()
    await seedMigrationsTable(dir, [{ hash: 'future', created_at: Date.now() + 1e12 }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(initDb()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('newer build'))
    warn.mockRestore()
  }, 120_000)

  it('backs the data dir up before applying pending migrations', async () => {
    const dir = tmpDataDir()
    /* a non-empty database behind every bundled migration -> all pending */
    await seedMigrationsTable(dir, [{ hash: 'old', created_at: 1 }])
    await initDb()
    const backups = fs.readdirSync(path.join(dir, 'backups'))
    expect(backups.filter((n) => n.endsWith('.tar.gz')).length).toBeGreaterThan(0)
    expect(backups.filter((n) => n.endsWith('.assets.json')).length).toBeGreaterThan(0)
  }, 240_000)

  it('backs up a populated database that has no journal yet', async () => {
    const dir = tmpDataDir()
    /* a database created by the pre-migration boot DDL: real tables, real
       rows, and no drizzle.__drizzle_migrations for appliedJournal to
       count — the first journaled migration must still get its backup */
    const pgDir = path.join(dir, 'pg')
    fs.mkdirSync(pgDir, { recursive: true })
    const seed = new PGlite(pgDir)
    await seed.query('create table legacy_frames (id text primary key, html text)')
    await seed.query("insert into legacy_frames values ('f1', '<p>real data</p>')")
    await seed.close()

    await initDb()
    const backups = fs.readdirSync(path.join(dir, 'backups'))
    expect(backups.filter((n) => n.endsWith('.tar.gz')).length).toBeGreaterThan(0)
    expect(backups.filter((n) => n.endsWith('.assets.json')).length).toBeGreaterThan(0)
    /* the legacy table survived the journaled migrations */
    const rows = await pglite()!.query<{ id: string }>('select id from legacy_frames')
    expect(rows.rows[0]?.id).toBe('f1')
  }, 240_000)

  it('boots an empty data dir without a backup — nothing to lose', async () => {
    const dir = tmpDataDir()
    await initDb()
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false)
  }, 240_000)
})
