import { mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, it } from 'vitest'
import { backupNow, startDailyBackups } from '../server/backup.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * server/backup.ts: a PGlite data-dir dump plus a manifest of the on-disk
 * assets the dump cannot contain, under <DOOP_DATA_DIR>/backups, keeping
 * only the newest seven pairs. The client is stubbed — what is tested is
 * where the backup lands and what survives pruning.
 */

const dirs: string[] = []

function tmpDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'backup-test-'))
  dirs.push(dir)
  stubEnv('DOOP_DATA_DIR', dir)
  return dir
}

const fakeClient = (payload = 'pgdump') => ({ dumpDataDir: async () => new Blob([payload]) }) as unknown as PGlite

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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('server/backup.ts', () => {
  it('writes a tar.gz dump and an asset manifest under <data>/backups only', async () => {
    const data = tmpDataDir()
    await fs.mkdir(path.join(data, 'assets', 'canvas1'), { recursive: true })
    await fs.writeFile(path.join(data, 'assets', 'logo.png'), 'png-bytes')
    await fs.writeFile(path.join(data, 'assets', 'canvas1', 'font.woff2'), 'font-bytes')

    const { archive, manifest } = await backupNow(fakeClient('PGDATA'), 'daily')

    expect(path.dirname(archive)).toBe(path.join(data, 'backups'))
    expect(path.dirname(manifest)).toBe(path.join(data, 'backups'))
    expect(await fs.readFile(archive, 'utf8')).toBe('PGDATA')

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

  it('keeps only the seven newest backup pairs', async () => {
    const data = tmpDataDir()
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
    tmpDataDir()
    const { manifest } = await backupNow(fakeClient(), 'pre-migration')
    const body = JSON.parse(await fs.readFile(manifest, 'utf8')) as { assets: unknown[] }
    expect(body.assets).toEqual([])
  })

  it('streams the dump to disk instead of buffering it whole', async () => {
    tmpDataDir()
    /* a dump whose arrayBuffer() blows up: the only safe way to write it is
       its stream — buffering copies the whole data dir into memory twice */
    const blob = new Blob(['PGDATA'])
    blob.arrayBuffer = () => Promise.reject(new Error('the dump must be streamed, not buffered'))
    const { archive } = await backupNow({ dumpDataDir: async () => blob } as unknown as PGlite, 'daily')
    expect(await fs.readFile(archive, 'utf8')).toBe('PGDATA')
  })

  it('backs up at boot when the newest archive is older than a day', async () => {
    const data = tmpDataDir()
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    const stale = path.join(backups, 'pg-2020-01-01T00-00-00-000Z.tar.gz')
    await fs.writeFile(stale, 'old')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000)
    await fs.utimes(stale, twoDaysAgo, twoDaysAgo)

    startDailyBackups(fakeClient('FRESH'))

    const name = await waitFor(async () =>
      (await fs.readdir(backups)).find((n) => n.endsWith('.tar.gz') && !n.startsWith('pg-2020-01-01')),
    )
    expect(await fs.readFile(path.join(backups, name), 'utf8')).toBe('FRESH')
  })

  it('backs up at boot when no archive exists yet', async () => {
    const data = tmpDataDir()
    startDailyBackups(fakeClient('FIRST'))
    const name = await waitFor(async () =>
      (await fs.readdir(path.join(data, 'backups'))).find((n) => n.endsWith('.tar.gz')),
    )
    expect(name).toBeTruthy()
  })

  it('skips the boot backup while the newest archive is fresh', async () => {
    const data = tmpDataDir()
    const backups = path.join(data, 'backups')
    await fs.mkdir(backups, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.writeFile(path.join(backups, `pg-${stamp}.tar.gz`), 'recent')

    startDailyBackups(fakeClient('SHOULD-NOT-APPEAR'))
    await new Promise((r) => setTimeout(r, 300))

    const dumps = (await fs.readdir(backups)).filter((n) => n.endsWith('.tar.gz'))
    expect(dumps).toEqual([`pg-${stamp}.tar.gz`])
  })
})
