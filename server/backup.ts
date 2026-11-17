import { createWriteStream, type Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import type { PGlite } from '@electric-sql/pglite'
import { backupsDir, dataDir } from './paths.ts'

/**
 * Local backups of the embedded install: a gzipped tar of PGlite's data
 * dir (`pg-<date>.tar.gz`) plus a manifest of the on-disk asset files the
 * dump does not contain (`pg-<date>.assets.json`). Written before a boot
 * applies pending migrations — a bad migration must never be
 * unrecoverable — and once a day while the server runs, catching up at
 * boot when the newest complete pair is already a day old. The KEEP
 * newest pairs are kept, the rest pruned.
 *
 * PGlite-only by construction (a managed Postgres has its own backup
 * story), and every file lands under the data dir so the install stays
 * read-only. A pair counts as a backup only once both files exist: the
 * manifest is renamed into place first and the archive last, so the
 * archive's name — what `backupOverdue` counts — is the completion
 * marker. Nothing is staged or buffered whole: the cold path tars the
 * quiescent dir in place, the daily one runs under `pg_backup_start` —
 * the checkpoint it forces and the full-page images it switches on are
 * what make a file-level copy of a LIVE data dir restorable (torn pages
 * replay from the archived WAL), where `dumpDataDir` would assemble the
 * whole tar in memory first and could OOM every boot on a big install.
 */

const KEEP = 7
const DAY_MS = 24 * 60 * 60_000

interface AssetEntry {
  key: string
  bytes: number
}

/** One backup pair, written under `<data>/backups`, from the RUNNING
 *  database: pg_backup_start .. pg_backup_stop bracket the file copy the
 *  way Postgres itself sanctions it. */
export async function backupNow(client: PGlite, reason: string): Promise<{ archive: string; manifest: string }> {
  const dir = backupsDir()
  await fs.mkdir(dir, { recursive: true })
  await sweepLeftovers(dir)
  const stamp = stampNow()
  const archive = path.join(dir, `pg-${stamp}.tar.gz`)
  const tmp = `${archive}.tmp`
  const pgDir = path.join(dataDir(), 'pg')
  const done = { stopped: false }
  await client.query(`select pg_backup_start('diazo-${reason}', true)`)
  try {
    await client.syncToFs()
    await pipeline(Readable.from(liveBackupEntries(client, pgDir, done)), createGzip(), createWriteStream(tmp))
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  } finally {
    /* the generator stops the backup on its own path; when the stream dies
       first, backup mode must still be left — it doubles WAL work until
       stopped, and a second start would error */
    if (!done.stopped) {
      await client
        .query('select pg_backup_stop(false)')
        .catch((stopError: unknown) => console.error('[backup] pg_backup_stop failed after a torn backup', stopError))
    }
  }
  return publish(dir, stamp, tmp, archive, reason)
}

/** The pre-migration boot backup — the cold twin of backupNow(). `pgDir`
 *  must be quiescent — the caller runs this while PGlite is not holding
 *  it — so it tars in place: no staging copy to strand disk space on
 *  ENOSPC or an abrupt exit, and the archive never holds more than a
 *  block in memory either way. */
export async function backupPgDir(pgDir: string, reason: string): Promise<{ archive: string; manifest: string }> {
  const dir = backupsDir()
  await fs.mkdir(dir, { recursive: true })
  await sweepLeftovers(dir)
  const stamp = stampNow()
  const archive = path.join(dir, `pg-${stamp}.tar.gz`)
  const tmp = `${archive}.tmp`
  try {
    await pipeline(Readable.from(tarEntries(pgDir)), createGzip(), createWriteStream(tmp))
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  return publish(dir, stamp, tmp, archive, reason)
}

/** A backup a day while running — and one right away when the newest
 *  complete pair is already a day old: an app opened for a workday never
 *  reaches a bare 24 h interval, so without the catch-up a desktop
 *  install's backups would only ever happen on migrating boots. */
export function startDailyBackups(client: PGlite): void {
  void backupOverdue(client).catch((error: unknown) => console.error('[backup] boot backup failed', error))
  const timer = setInterval(() => {
    backupNow(client, 'daily').catch((error: unknown) => console.error('[backup] daily backup failed', error))
  }, DAY_MS)
  timer.unref()
}

/** Back up when there is no complete pair yet, or the newest is older than
 *  a day. An archive without its manifest does not count — it is the torn
 *  half of a crash mid-publish, not a backup. */
async function backupOverdue(client: PGlite): Promise<void> {
  const dir = backupsDir()
  let newest = 0
  try {
    for (const name of await fs.readdir(dir)) {
      const stamp = /^pg-(.+)\.tar\.gz$/.exec(name)?.[1]
      if (!stamp || !(await exists(path.join(dir, `pg-${stamp}.assets.json`)))) continue
      const mtime = (await fs.stat(path.join(dir, name))).mtimeMs
      if (mtime > newest) newest = mtime
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (Date.now() - newest > DAY_MS) await backupNow(client, 'daily')
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-')

/** The manifest, the renames and the prune — the tail both paths share
 *  once the archive's bytes sit in their `.tmp`. The manifest is written
 *  atomically and renamed BEFORE the archive: the archive's name is the
 *  completion marker, so it only ever appears once the pair is whole. */
async function publish(dir: string, stamp: string, tmp: string, archive: string, reason: string) {
  const manifest = path.join(dir, `pg-${stamp}.assets.json`)
  const assets = await listAssets(path.join(dataDir(), 'assets'))
  await fs.writeFile(`${manifest}.tmp`, JSON.stringify({ at: new Date().toISOString(), reason, assets }, null, 2))
  await fs.rename(`${manifest}.tmp`, manifest)
  await fs.rename(tmp, archive)
  console.log(`[backup] wrote ${path.basename(archive)} (+ ${assets.length} asset(s) in its manifest)`)
  await prune(dir)
  return { archive, manifest }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

/** What crashed or older backups leave behind, swept before each attempt
 *  while the data lock guarantees only this server writes here: `.tmp`
 *  archives torn mid-write, `.work` staging dirs from the staging-copy
 *  version, and manifests whose archive never landed. */
async function sweepLeftovers(dir: string): Promise<void> {
  for (const name of await fs.readdir(dir)) {
    const drop =
      /\.(?:tmp|work)$/.test(name) ||
      (/^pg-.+\.assets\.json$/.test(name) &&
        !(await exists(path.join(dir, name.replace(/\.assets\.json$/, '.tar.gz')))))
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

/** Keep the KEEP newest complete `pg-<date>` pairs, drop the rest — and
 *  any stray half of a pair (an archive or a manifest on its own is not a
 *  backup and must not occupy a retention slot). */
async function prune(dir: string): Promise<void> {
  const names = await fs.readdir(dir)
  const stamps = [
    ...new Set(
      names
        .map((name) => /^pg-(.+?)\.tar\.gz$/.exec(name)?.[1])
        .filter((stamp): stamp is string => !!stamp)
        .filter((stamp) => names.includes(`pg-${stamp}.assets.json`)),
    ),
  ].sort()
  const keep = new Set(stamps.slice(-KEEP))
  for (const name of names) {
    const stamp = /^pg-(.+?)(?:\.tar\.gz|\.assets\.json)$/.exec(name)?.[1]
    if (stamp && !keep.has(stamp)) await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------- tar.gz
   The archive writer both paths share: a plain ustar stream so the data
   dir passes through one block at a time — the shape dumpDataDir
   produces (relative paths, gzip) without its in-memory buffer. A PGlite
   dir holds only regular files and directories, ASCII names well under a
   hundred chars; anything else is refused loudly rather than archived
   wrong. Modes come from the files themselves — PGlite's data dirs are
   0700 and must stay traversable on restore; a flat 0644 would extract a
   database nobody can open. */

/* runtime files a live postmaster leaves behind: postmaster.pid would
   make the restored dir look occupied; the rest Postgres rebuilds on
   boot — pg_basebackup skips the same set */
const SKIP_FILES = new Set(['postmaster.pid', 'postmaster.opts'])
const SKIP_DIR_CONTENTS = new Set(['pg_dynshmem', 'pg_notify', 'pg_serial', 'pg_snapshots', 'pg_stat_tmp'])
/* pass one of the live backup: pg_wal is archived by the second pass,
   after pg_backup_stop — its segments there are complete through the
   stop lsn */
const SKIP_WAL = new Set(['pg_wal'])

async function* tarEntries(root: string): AsyncGenerator<Buffer> {
  yield* tarWalk(root, '')
  yield Buffer.alloc(1024) /* end-of-archive: two zero blocks */
}

/** The live backup's stream, driven between pg_backup_start and
 *  pg_backup_stop: data files first (torn pages are repaired by WAL at
 *  restore — that is what backup mode is for), then the complete WAL,
 *  then the backup_label pg_backup_stop hands back so the restored dir
 *  does archive recovery instead of trusting a torn checkpoint. */
async function* liveBackupEntries(client: PGlite, pgDir: string, done: { stopped: boolean }): AsyncGenerator<Buffer> {
  try {
    yield* tarWalk(pgDir, '', SKIP_WAL)
    const stop = await client.query<{ lsn: string; labelfile: string; spcmapfile: string }>(
      'select lsn, labelfile, spcmapfile from pg_backup_stop(false)',
    )
    done.stopped = true
    /* the archive must carry the WAL from the start checkpoint to the
       stop lsn or a restore cannot reach consistency — so NO checkpoint
       here: once backup mode ends its WAL pinning is gone and a
       checkpoint would recycle the very segments this backup needs.
       pg_switch_wal flushes the stop record's segment to disk instead */
    await client.query('select pg_switch_wal()')
    await client.syncToFs()
    yield* tarWalk(path.join(pgDir, 'pg_wal'), 'pg_wal/')
    const label = stop.rows[0]?.labelfile
    if (label) yield tarFile('backup_label', Buffer.from(label))
    const map = stop.rows[0]?.spcmapfile
    if (map) yield tarFile('tablespace_map', Buffer.from(map))
  } finally {
    if (!done.stopped) {
      await client
        .query('select pg_backup_stop(false)')
        .then(() => {
          done.stopped = true
        })
        .catch(() => {})
    }
  }
  yield Buffer.alloc(1024)
}

async function* tarWalk(dir: string, prefix: string, skipTop?: Set<string>): AsyncGenerator<Buffer> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    /* a live dir loses files as Postgres rotates them — ENOENT is a skip,
       not a failure (pg_basebackup tolerates the same) */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const name = prefix + entry.name
    const full = path.join(dir, entry.name)
    if (prefix === '' && (SKIP_FILES.has(entry.name) || skipTop?.has(entry.name))) continue
    if (entry.isDirectory()) {
      const stat = await statOrNull(full)
      if (!stat) continue
      yield tarHeader(`${name}/`, '5', 0, stat.mode & 0o777, stat.mtimeMs)
      if (prefix === '' && SKIP_DIR_CONTENTS.has(entry.name)) continue /* the dir, not its runtime contents */
      yield* tarWalk(full, `${name}/`)
    } else if (entry.isFile()) {
      /* stat + open before the header leaves the generator: a file gone by
         the time it is read is skipped, never a torn entry in the archive */
      const stat = await statOrNull(full)
      const handle = stat ? await openOrNull(full) : null
      if (!stat || !handle) continue
      try {
        yield tarHeader(name, '0', stat.size, stat.mode & 0o777, stat.mtimeMs)
        let written = 0
        for await (const chunk of handle.createReadStream() as AsyncIterable<Buffer>) {
          written += chunk.length
          yield chunk
        }
        /* a file that changed size between stat and read would corrupt the
           archive — fail loudly rather than write a torn backup */
        if (written !== stat.size) throw new Error(`[backup] ${full} changed size while archiving`)
        const pad = (512 - (written % 512)) % 512
        if (pad) yield Buffer.alloc(pad)
      } finally {
        await handle.close()
      }
    } else {
      throw new Error(`[backup] cannot archive ${full} — not a regular file or directory`)
    }
  }
}

async function statOrNull(full: string) {
  try {
    return await fs.stat(full)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function openOrNull(full: string) {
  try {
    return await fs.open(full)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** A file generated for the archive (backup_label, tablespace_map). */
function tarFile(name: string, body: Buffer): Buffer {
  const pad = (512 - (body.length % 512)) % 512
  return Buffer.concat([tarHeader(name, '0', body.length, 0o600), body, Buffer.alloc(pad)])
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
