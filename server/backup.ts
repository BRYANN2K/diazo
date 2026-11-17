import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import type { PGlite } from '@electric-sql/pglite'
import { backupsDir, dataDir } from './paths.ts'

/**
 * Local backups of the embedded install: PGlite's own data-dir dump as a
 * gzipped tar (`pg-<date>.tar.gz`) plus a manifest of the on-disk asset
 * files the dump does not contain (`pg-<date>.assets.json`). Written before
 * a boot applies pending migrations — a bad migration must never be
 * unrecoverable — and once a day while the server runs, catching up at
 * boot when the newest archive is already a day old. The KEEP newest
 * pairs are kept, the rest pruned.
 *
 * PGlite-only by construction (a managed Postgres has its own backup story),
 * and every file lands under the data dir so the install stays read-only.
 */

const KEEP = 7
const DAY_MS = 24 * 60 * 60_000

interface AssetEntry {
  key: string
  bytes: number
}

/** One backup pair, written under `<data>/backups`. */
export async function backupNow(client: PGlite, reason: string): Promise<{ archive: string; manifest: string }> {
  const dir = backupsDir()
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archive = path.join(dir, `pg-${stamp}.tar.gz`)
  const dump = await client.dumpDataDir('gzip')
  /* streamed, not buffered: arrayBuffer() would copy the whole data dir
     into memory twice over and a large install would OOM before the
     migration it is being backed up for */
  await pipeline(Readable.fromWeb(dump.stream() as ReadableStream), createWriteStream(archive))

  const manifest = path.join(dir, `pg-${stamp}.assets.json`)
  const assets = await listAssets(path.join(dataDir(), 'assets'))
  await fs.writeFile(manifest, JSON.stringify({ at: new Date().toISOString(), reason, assets }, null, 2))
  console.log(`[backup] wrote ${path.basename(archive)} (+ ${assets.length} asset(s) in its manifest)`)
  await prune(dir)
  return { archive, manifest }
}

/** A backup a day while running — and one right away when the newest
 *  archive is already a day old: an app opened for a workday never
 *  reaches a bare 24 h interval, so without the catch-up a desktop
 *  install's backups would only ever happen on migrating boots. */
export function startDailyBackups(client: PGlite): void {
  void backupOverdue(client).catch((error: unknown) => console.error('[backup] boot backup failed', error))
  const timer = setInterval(() => {
    backupNow(client, 'daily').catch((error: unknown) => console.error('[backup] daily backup failed', error))
  }, DAY_MS)
  timer.unref()
}

/** Back up when there is no archive yet, or the newest is older than a day. */
async function backupOverdue(client: PGlite): Promise<void> {
  let newest = 0
  try {
    for (const name of await fs.readdir(backupsDir())) {
      if (!/^pg-.*\.tar\.gz$/.test(name)) continue
      const mtime = (await fs.stat(path.join(backupsDir(), name))).mtimeMs
      if (mtime > newest) newest = mtime
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (Date.now() - newest > DAY_MS) await backupNow(client, 'daily')
}

async function listAssets(dir: string): Promise<AssetEntry[]> {
  const out: AssetEntry[] = []
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      const key = prefix + entry.name
      if (entry.isDirectory()) await walk(full, `${key}/`)
      else if (entry.isFile()) out.push({ key, bytes: (await fs.stat(full)).size })
    }
  }
  try {
    await walk(dir, '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return out
}

/** Keep the KEEP newest `pg-<date>` groups, drop the rest (both files). */
async function prune(dir: string): Promise<void> {
  const stamps = [
    ...new Set(
      (await fs.readdir(dir))
        .map((name) => /^pg-(.+?)(?:\.tar\.gz|\.assets\.json)$/.exec(name)?.[1])
        .filter((stamp): stamp is string => !!stamp),
    ),
  ].sort()
  for (const stamp of stamps.slice(0, Math.max(0, stamps.length - KEEP))) {
    await fs.rm(path.join(dir, `pg-${stamp}.tar.gz`), { force: true })
    await fs.rm(path.join(dir, `pg-${stamp}.assets.json`), { force: true })
  }
}
