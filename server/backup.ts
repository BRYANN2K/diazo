import { createHash } from 'node:crypto'
import fsSync, { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import type { PGlite } from '@electric-sql/pglite'
import { buildInfo } from './buildInfo.ts'
import { appliedJournal } from './db/journal.ts'
import { backupsDir, dataDir } from './paths.ts'

/**
 * Local backups of the embedded install: a verified snapshot of PGlite's
 * data dir, streamed into a gzipped tar plus the manifest that describes
 * it — `pg-<date>.tar.gz` and `pg-<date>.manifest.json` under
 * `<data>/backups`. Taken before a boot applies pending migrations — a
 * bad migration must never be unrecoverable — and once a day while the
 * server runs, catching up at boot when the newest complete pair is
 * already a day old. The seven newest `daily` pairs and the three newest
 * of every other reason together are kept; the rest is pruned.
 *
 * PGlite-only by construction (a managed Postgres has its own backup
 * story), and every file lands under the data dir so the install stays
 * read-only. Everything is private to the owner — 0700 dirs, 0600
 * files, regardless of umask.
 *
 * How a backup stays restorable:
 *   1. the live data dir is copied under the database's own mutex —
 *      `client.runExclusive(fs.cp)`: no query can interleave with the
 *      copy, so nothing tears mid-page and no segment is needed twice;
 *      nothing else runs inside the section — no query, no hashing, no
 *      gzip;
 *   2. the STAGED copy is reopened with PGlite and its applied journal
 *      read before anything is published — an archive is only as good
 *      as the database it restores to;
 *   3. the pair goes out as two atomic renames, manifest first and
 *      archive last: the archive's name is the completion marker, so a
 *      torn publish never counts as a backup.
 *
 * Nothing buffers a whole member: the tar walks the stage one file at a
 * time, and the sha256 and byte count the manifest reports are measured
 * on the bytes that actually reach the archive stream.
 */

export interface BackupManifest {
  format: 1
  at: string
  reason: string
  /** the build that took it (the commit), null when none is recorded */
  build: string | null
  migrations: { count: number; newest: number }
  /** of the archive on disk — bytes are the gzipped stream's */
  archive: { bytes: number; sha256: string }
  assets: { key: string; bytes: number }[]
}

const DAY_MS = 24 * 60 * 60_000
const KEEP_DAILY = 7
const KEEP_OTHER = 3

/* backupNow calls are serialized on this chain: an overlapping second
   call queues behind the first rather than race the same staging names
   and retention sweeps */
let chain: Promise<unknown> = Promise.resolve()

export function backupNow(
  client: PGlite,
  reason: string,
  opts?: { onStaged?: (stage: string) => void | Promise<void> },
): Promise<{ archive: string; manifest: string }> {
  const run = chain.then(() => backupOnce(client, reason, opts))
  chain = run.catch(() => {})
  return run
}

async function backupOnce(
  client: PGlite,
  reason: string,
  opts?: { onStaged?: (stage: string) => void | Promise<void> },
): Promise<{ archive: string; manifest: string }> {
  const dir = backupsDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700).catch(() => {})
  await sweepLeftovers(dir)
  const stamp = await uniqueStamp(dir)
  const archive = path.join(dir, `pg-${stamp}.tar.gz`)
  const tmp = `${archive}.tmp`
  const stage = path.join(dir, `pg-${stamp}.stage`)
  const manifestFile = path.join(dir, `pg-${stamp}.manifest.json`)
  const manifestTmp = `${manifestFile}.tmp`
  const pgDir = path.join(dataDir(), 'pg')
  try {
    /* flush what it can so the copy carries less WAL — a refused
       checkpoint only makes the stage bigger, not wrong */
    await client
      .query('CHECKPOINT')
      .catch((error: unknown) => console.warn('[backup] CHECKPOINT failed — copying anyway', error))
    /* the critical section: Postgres cannot write inside the data dir
       while its mutex is held, so the copy is a consistent snapshot —
       the property pg_backup_start's WAL-retention dance approximated,
       here in one call. Nothing else inside: no query, no hashing, no
       gzip — every extra second in the section stalls the database. */
    await fs.mkdir(stage, { mode: 0o700 })
    await client.runExclusive(() =>
      fs.cp(pgDir, path.join(stage, 'pg'), { recursive: true, mode: fsSync.constants.COPYFILE_FICLONE }),
    )
    /* test seam: let a test corrupt the stage before verification */
    await opts?.onStaged?.(stage)
    /* reopen the COPY before anything is published: an archive of a dir
       PGlite cannot open is an unrestorable backup nobody asked for */
    const migrations = await verifyPgDir(path.join(stage, 'pg'))
    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        bytes += chunk.length
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.from(tarEntries(path.join(stage, 'pg'))),
      createGzip(),
      meter,
      createWriteStream(tmp, { mode: 0o600 }),
    )
    const manifest: BackupManifest = {
      format: 1,
      at: new Date().toISOString(),
      reason,
      build: buildInfo().sha,
      migrations,
      archive: { bytes, sha256: hash.digest('hex') },
      assets: await listAssets(path.join(dataDir(), 'assets')),
    }
    await fs.writeFile(manifestTmp, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    /* a creation mode still bows to a pathological umask — chmod makes
       the privacy unconditional before the names become public */
    await fs.chmod(manifestTmp, 0o600)
    await fs.rename(manifestTmp, manifestFile)
    /* the archive's name is the completion marker: it lands last */
    await fs.chmod(tmp, 0o600)
    await fs.rename(tmp, archive)
    console.log(`[backup] wrote ${path.basename(archive)} (+ ${manifest.assets.length} asset(s) in its manifest)`)
    return { archive, manifest: manifestFile }
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
    await fs.rm(manifestTmp, { force: true }).catch(() => {})
    await prune(dir).catch((error: unknown) => console.error('[backup] prune failed', error))
  }
}

/** The staged copy, reopened and asked for its applied journal — the
 *  verification every published pair passed. PGlite is imported lazily:
 *  a managed-Postgres install must never load it. */
export async function verifyPgDir(dir: string): Promise<{ count: number; newest: number }> {
  const { PGlite } = await import('@electric-sql/pglite')
  const client = new PGlite(dir)
  try {
    await client.query('select 1')
    return await appliedJournal(client)
  } finally {
    await client.close()
  }
}

interface BackupPair {
  stamp: string
  archive: string
  manifest: BackupManifest
}

/** Every complete pair under `dir`, oldest first — an archive only
 *  counts once its manifest exists beside it (the publish order's
 *  completion marker, read backwards). */
async function readPairs(dir: string): Promise<BackupPair[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const pairs: BackupPair[] = []
  for (const name of names) {
    const stamp = /^pg-(.+)\.tar\.gz$/.exec(name)?.[1]
    if (!stamp) continue
    const manifestFile = path.join(dir, `pg-${stamp}.manifest.json`)
    try {
      const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')) as BackupManifest
      pairs.push({ stamp, archive: path.join(dir, name), manifest })
    } catch {
      /* an unparseable manifest is not a backup — and its archive is
         never ours */
    }
  }
  return pairs.sort((a, b) => a.stamp.localeCompare(b.stamp))
}

export async function listBackups(): Promise<{ stamp: string; archive: string; manifest: BackupManifest }[]> {
  return readPairs(backupsDir())
}

/** A backup a day while running — and one right away when the newest
 *  complete pair is already a day old: an app opened for a workday never
 *  reaches a bare 24 h interval, so without the catch-up a desktop
 *  install's backups would only ever happen on migrating boots. The
 *  hourly tick logs failures and never throws out of the timer. */
export function startDailyBackups(client: PGlite): void {
  const check = () => {
    backupOverdue(client).catch((error: unknown) => console.error('[backup] overdue check failed', error))
  }
  check()
  const timer = setInterval(check, 60 * 60_000)
  timer.unref()
}

/** Back up when there is no complete pair yet, or the newest is older
 *  than a day. An archive without its manifest does not count — it is
 *  the torn half of a crash mid-publish, not a backup. */
async function backupOverdue(client: PGlite): Promise<void> {
  const pairs = await readPairs(backupsDir())
  const newest = pairs.reduce((acc, pair) => Math.max(acc, Date.parse(pair.manifest.at) || 0), 0)
  if (Date.now() - newest > DAY_MS) await backupNow(client, 'daily')
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-')

/** ISO-millisecond stamps collide when two backups land inside one —
 *  the serialized calls differ by the suffix, never the name. */
async function uniqueStamp(dir: string): Promise<string> {
  const base = stampNow()
  for (let i = 0; ; i++) {
    const stamp = i === 0 ? base : `${base}-${i}`
    const taken =
      (await exists(path.join(dir, `pg-${stamp}.tar.gz`))) ||
      (await exists(path.join(dir, `pg-${stamp}.manifest.json`))) ||
      (await exists(`${path.join(dir, `pg-${stamp}.tar.gz`)}.tmp`)) ||
      (await exists(path.join(dir, `pg-${stamp}.stage`)))
    if (!taken) return stamp
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

/** What crashed backups leave behind, swept before each attempt while
 *  the data lock guarantees only this server writes here: `.tmp` files
 *  torn mid-publish, `.stage` dirs from a backup that died mid-copy, and
 *  manifests whose archive never landed. An archive without a manifest
 *  is never ours — the manifest renames first, so it must have come from
 *  elsewhere — and is left alone. */
async function sweepLeftovers(dir: string): Promise<void> {
  for (const name of await fs.readdir(dir)) {
    const drop =
      /\.(?:tmp|stage)$/.test(name) ||
      (/^pg-.+\.manifest\.json$/.test(name) &&
        !(await exists(path.join(dir, name.replace(/\.manifest\.json$/, '.tar.gz')))))
    if (drop) await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})
  }
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

interface AssetEntry {
  key: string
  bytes: number
}

/** Retention: the KEEP_DAILY newest `daily` pairs plus the KEEP_OTHER
 *  newest of every other reason pooled — a burst of pre-migration boots
 *  must not evict a week of dailies. Only complete pairs count; a stray
 *  half is swept by the next attempt, not kept by retention. */
async function prune(dir: string): Promise<void> {
  const pairs = await readPairs(dir)
  const keep = new Set<string>()
  for (const pair of pairs.filter((p) => p.manifest.reason === 'daily').slice(-KEEP_DAILY)) keep.add(pair.stamp)
  for (const pair of pairs.filter((p) => p.manifest.reason !== 'daily').slice(-KEEP_OTHER)) keep.add(pair.stamp)
  for (const pair of pairs) {
    if (keep.has(pair.stamp)) continue
    await fs.rm(pair.archive, { force: true }).catch(() => {})
    await fs.rm(path.join(dir, `pg-${pair.stamp}.manifest.json`), { force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------- tar.gz
   The archive writer: a plain ustar stream over the STAGED copy, one
   file at a time — the stage is frozen (the snapshot was verified before
   a byte is read), so a file whose bytes differ from its stat is
   corruption, not a race, and fails the backup. Modes come from the
   files themselves — PGlite's data dirs are 0700 and must stay
   traversable on restore. */

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
      const stat = await fs.stat(full)
      yield tarHeader(`${name}/`, '5', 0, stat.mode & 0o777, stat.mtimeMs)
      yield* tarWalk(full, `${name}/`)
    } else if (entry.isFile()) {
      const stat = await fs.stat(full)
      yield tarHeader(name, '0', stat.size, stat.mode & 0o777, stat.mtimeMs)
      yield* fileBody(full, stat.size)
    } else {
      throw new Error(`[backup] cannot archive ${full} — not a regular file or directory`)
    }
  }
}

/** Exactly `size` bytes from the file, then the tar block pad. The stage
 *  is frozen — fewer bytes is corruption the archive must not silently
 *  pad out, more is a file we mismeasured: either way the pair fails. */
async function* fileBody(full: string, size: number): AsyncGenerator<Buffer> {
  let read = 0
  for await (const chunk of fsSync.createReadStream(full) as AsyncIterable<Buffer>) {
    read += chunk.length
    yield chunk
  }
  if (read !== size) {
    throw new Error(`[backup] ${full} changed under the archive — ${read} bytes read, ${size} announced`)
  }
  const pad = (512 - (size % 512)) % 512
  if (pad) yield Buffer.alloc(pad)
}

/** One 512-byte ustar header: name (with the 155/100 prefix split when
 *  long), the entry's real mode, nul ids, octal size and mtime, the
 *  'ustar' magic and the computed checksum. */
function tarHeader(name: string, type: '0' | '5', size: number, mode: number, mtimeMs = Date.now()): Buffer {
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
  header.write(`${(mode & 0o777).toString(8).padStart(7, '0')}\0`, 100)
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
