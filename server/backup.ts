import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import { createGzip } from 'node:zlib'
import type { PGlite } from '@electric-sql/pglite'
import { backupsDir, dataDir } from './paths.ts'

/**
 * Local backups of the embedded install: a gzipped tar of PGlite's data
 * dir (`pg-<date>.tar.gz`) plus a manifest of the on-disk asset files the
 * dump does not contain (`pg-<date>.assets.json`). Written before a boot
 * applies pending migrations — a bad migration must never be
 * unrecoverable — and once a day while the server runs, catching up at
 * boot when the newest archive is already a day old. The KEEP newest
 * pairs are kept, the rest pruned.
 *
 * PGlite-only by construction (a managed Postgres has its own backup
 * story), and every file lands under the data dir so the install stays
 * read-only. Archives go through a `.tmp` name and a rename, so a crash
 * mid-write leaves a file nothing counts as a backup.
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
  const stamp = stampNow()
  const archive = path.join(dir, `pg-${stamp}.tar.gz`)
  const dump = await client.dumpDataDir('gzip')
  /* streamed, not buffered: arrayBuffer() would copy the whole data dir
     into memory twice over and a large install would OOM before the
     migration it is being backed up for. Written under a temp name and
     renamed: a crash mid-write must not leave a truncated archive that
     counts as today's backup and as one of the seven */
  const tmp = `${archive}.tmp`
  try {
    await pipeline(Readable.fromWeb(dump.stream() as ReadableStream), createWriteStream(tmp))
    await fs.rename(tmp, archive)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  return finish(dir, stamp, archive, reason)
}

/** The pre-migration boot backup — the cold twin of backupNow(). PGlite's
 *  own dumpDataDir builds the archive from one in-memory buffer, so a
 *  multi-GB data dir could OOM at boot; here the closed data dir is
 *  snapshotted with `fs.cp` instead and streamed into the same
 *  `pg-<date>.tar.gz` through a tar writer that never holds more than a
 *  block in memory. `pgDir` must be quiescent — the caller runs this
 *  while PGlite is not holding it. */
export async function backupPgDir(pgDir: string, reason: string): Promise<{ archive: string; manifest: string }> {
  const dir = backupsDir()
  await fs.mkdir(dir, { recursive: true })
  const stamp = stampNow()
  const staging = path.join(dir, `pg-${stamp}.work`)
  await fs.cp(pgDir, staging, { recursive: true })
  const archive = path.join(dir, `pg-${stamp}.tar.gz`)
  const tmp = `${archive}.tmp`
  try {
    await pipeline(Readable.from(tarEntries(staging)), createGzip(), createWriteStream(tmp))
    await fs.rename(tmp, archive)
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {})
    await fs.rm(staging, { recursive: true, force: true })
  }
  return finish(dir, stamp, archive, reason)
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

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-')

/** The manifest of on-disk assets, the log line and the prune — the tail
 *  both archive paths share once the `.tar.gz` is in place. */
async function finish(dir: string, stamp: string, archive: string, reason: string) {
  const manifest = path.join(dir, `pg-${stamp}.assets.json`)
  const assets = await listAssets(path.join(dataDir(), 'assets'))
  await fs.writeFile(manifest, JSON.stringify({ at: new Date().toISOString(), reason, assets }, null, 2))
  console.log(`[backup] wrote ${path.basename(archive)} (+ ${assets.length} asset(s) in its manifest)`)
  await prune(dir)
  return { archive, manifest }
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

/* ------------------------------------------------------------- tar.gz
   The cold backup's archive writer: a plain ustar stream so the data dir
   passes through one block at a time — the shape dumpDataDir produces
   (relative paths, gzip) without its in-memory buffer. A PGlite dir holds
   only regular files and directories, ASCII names well under a hundred
   chars; anything else is refused loudly rather than archived wrong. */

async function* tarEntries(root: string): AsyncGenerator<Buffer> {
  yield* tarWalk(root, '')
  yield Buffer.alloc(1024) /* end-of-archive: two zero blocks */
}

async function* tarWalk(dir: string, prefix: string): AsyncGenerator<Buffer> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const name = prefix + entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield tarHeader(`${name}/`, '5', 0)
      yield* tarWalk(full, `${name}/`)
    } else if (entry.isFile()) {
      const stat = await fs.stat(full)
      yield tarHeader(name, '0', stat.size, stat.mtimeMs)
      let written = 0
      for await (const chunk of createReadStream(full) as AsyncIterable<Buffer>) {
        written += chunk.length
        yield chunk
      }
      /* a file that changed size between stat and read would corrupt the
         archive — fail loudly rather than write a torn backup */
      if (written !== stat.size) throw new Error(`[backup] ${full} changed size while archiving`)
      const pad = (512 - (written % 512)) % 512
      if (pad) yield Buffer.alloc(pad)
    } else {
      throw new Error(`[backup] cannot archive ${full} — not a regular file or directory`)
    }
  }
}

/** One 512-byte ustar header: name (with the 155/100 prefix split when
 *  long), 0644, nul ids, octal size and mtime, the 'ustar' magic and the
 *  computed checksum. */
function tarHeader(name: string, type: '0' | '5', size: number, mtimeMs = Date.now()): Buffer {
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`[backup] non-ASCII path cannot be archived: ${name}`)
  let prefix = ''
  if (name.length > 100) {
    const cut = lastSlashWithin(name)
    if (cut === -1) throw new Error(`[backup] path too long for a tar entry: ${name}`)
    prefix = name.slice(0, cut)
    name = name.slice(cut + 1)
  }
  const header = Buffer.alloc(512)
  header.write(name, 0)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  header.write(
    `${Math.floor(mtimeMs / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
  )
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(prefix, 345)
  /* the checksum field itself counts as eight spaces */
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

/** The rightmost slash that splits `name` into a <=155 prefix and a
 *  <=100 remainder — ustar's only long-name escape. */
function lastSlashWithin(name: string): number {
  for (let i = Math.min(155, name.length - 1); i > 0; i--) {
    if (name[i] === '/' && name.length - i - 1 <= 100) return i
  }
  return -1
}
