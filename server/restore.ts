import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fsSync, { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { listBackups, verifyPgDir, type BackupManifest } from './backup.ts'
import { newerDataMessage } from './db/journal.ts'
import { dataDir } from './paths.ts'

/**
 * Restore a backup pair onto the data dir. The caller holds the data
 * lock — the server must not be running.
 *
 * Order of operations, each step verified before the next:
 *   1. the archive's sha256 is checked against its manifest (a pair
 *      always carries one; a manifestless archive came from elsewhere
 *      and gets a warning, not a veto);
 *   2. the archive is unpacked into `<data>/pg.restore-<stamp>/` with a
 *      streaming ustar reader — 512-byte headers, the prefix field,
 *      regular files and directories only, and no member may name an
 *      absolute path or a `..` segment;
 *   3. the staged dir is reopened with PGlite and its applied journal
 *      read — a backup that cannot reopen is never installed, and data
 *      newer than this build is refused in every NODE_ENV (the same
 *      downgrade the boot guard blocks);
 *   4. only then the swap: a `.ready` marker first (a crash between
 *      moving `pg` aside and moving the restore in leaves a completable
 *      state — `completeInterruptedRestore` finishes it at the next
 *      boot), `pg` renamed to `pg.replaced-<stamp>`, the restore renamed
 *      to `pg`, the marker removed. The live dir is never edited in
 *      place.
 */

export async function restoreBackup(archive: string): Promise<{ restoredFrom: string; replaced: string | null }> {
  const data = dataDir()
  let file = archive
  if (archive === 'latest') {
    const pairs = await listBackups()
    file = pairs[pairs.length - 1]?.archive ?? ''
    if (!file) throw new Error('[data] no complete backup pair to restore')
  }

  /* the manifest beside the archive is its checksum — verify the bytes
     before they are unpacked */
  let expected: string | undefined
  try {
    const manifest = JSON.parse(
      await fs.readFile(file.replace(/\.tar\.gz$/, '.manifest.json'), 'utf8'),
    ) as BackupManifest
    expected = manifest.archive?.sha256
  } catch {
    /* no readable manifest — a foreign archive still gets its chance */
  }
  if (expected === undefined) {
    console.warn(`[data] no manifest beside ${path.basename(file)} — restoring without a checksum`)
  } else {
    const hash = createHash('sha256')
    await pipeline(fsSync.createReadStream(file), hash)
    const actual = hash.digest('hex')
    if (actual !== expected) {
      throw new Error(
        `[data] ${path.basename(file)} failed its sha256 check — the archive does not match its manifest; nothing was restored`,
      )
    }
  }

  /* leftovers of restores that died before their marker — not data,
     swept; a pg.replaced-* is a former live dir and stays */
  const stamp = /^pg-(.+)\.tar\.gz$/.exec(path.basename(file))?.[1] ?? new Date().toISOString().replace(/[:.]/g, '-')
  for (const name of fsSync.readdirSync(data)) {
    if (/^pg\.restore-.+/.test(name)) fsSync.rmSync(path.join(data, name), { recursive: true, force: true })
  }

  const stage = path.join(data, `pg.restore-${stamp}`)
  const ready = `${stage}.ready`
  const pg = path.join(data, 'pg')
  try {
    await untar(file, stage)
    /* the staged dir must reopen AND not be newer than this build —
       the same refusal the boot guard applies, without the development
       tolerance: restoring newer data onto an older build is the same
       downgrade */
    const applied = await verifyPgDir(stage)
    const newer = newerDataMessage(applied)
    if (newer) {
      throw new Error(`${newer} — update Diazo instead of restoring this backup onto an older build`)
    }

    /* the swap: mark ready first so a crash in the two renames is
       completable, then move the live dir aside and the restore in */
    fsSync.writeFileSync(ready, '')
    let replaced: string | null = null
    if (fsSync.existsSync(pg)) {
      replaced = path.join(data, `pg.replaced-${stamp}`)
      fsSync.rmSync(replaced, { recursive: true, force: true })
      fsSync.renameSync(pg, replaced)
    }
    fsSync.renameSync(stage, pg)
    fsSync.rmSync(ready)
    pruneReplaced(data, replaced === null ? null : path.basename(replaced))
    return { restoredFrom: file, replaced }
  } catch (error) {
    fsSync.rmSync(stage, { recursive: true, force: true })
    fsSync.rmSync(ready, { force: true })
    throw error
  }
}

/** Called in initDb's PGlite branch BEFORE the data dir is created or
 *  opened — finishes or refuses the half-swapped state a crash mid-
 *  restore leaves:
 *   - `pg` present: nothing happened mid-swap; return.
 *   - `pg` missing and one `pg.restore-<stamp>` with its `.ready`:
 *     the crash landed between the two renames — finish it.
 *   - `pg` missing and only `pg.replaced-*`: the live dir was moved
 *     aside and nothing ready stands beside it — refuse, loudly. */
export function completeInterruptedRestore(dataDirPath: string): void {
  let names: string[]
  try {
    names = fsSync.readdirSync(dataDirPath)
  } catch {
    return /* no data dir yet — nothing to finish */
  }
  if (fsSync.existsSync(path.join(dataDirPath, 'pg'))) return
  const marker = names.find((name) => /^pg\.restore-.+\.ready$/.test(name))
  if (marker) {
    const stage = path.join(dataDirPath, marker.slice(0, -'.ready'.length))
    fsSync.renameSync(stage, path.join(dataDirPath, 'pg'))
    fsSync.rmSync(path.join(dataDirPath, marker))
    console.log(`[data] finished an interrupted restore — ${path.basename(stage)} became the data dir`)
    return
  }
  const replaced = names.find((name) => /^pg\.replaced-/.test(name))
  if (replaced) {
    throw new Error(
      `[data] a restore was interrupted — rename ${path.join(dataDirPath, replaced)} back to ${path.join(dataDirPath, 'pg')} or run the restore again`,
    )
  }
}

/** Keep the `pg.replaced-*` this restore just made — it is the recovery
 *  path for the CURRENT operation and the path the caller gets back,
 *  so pruning must never eat it. Its name sorts by the restored
 *  archive's stamp, not by recency: restoring an older archive names
 *  an older dir, and "keep the lexically newest" would keep the stale
 *  one. When this restore produced none, keep the newest existing. */
function pruneReplaced(data: string, keep: string | null): void {
  const names = fsSync
    .readdirSync(data)
    .filter((name) => /^pg\.replaced-/.test(name))
    .sort()
  const fallback = names[names.length - 1]
  for (const old of names) {
    if (old === (keep ?? fallback)) continue
    fsSync.rmSync(path.join(data, old), { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------- untar
   A streaming ustar reader over gunzip: 512-byte headers, the 155/100
   prefix split undone, regular files (type 0) and directories (type 5)
   only — a symlink, device or fifo member is refused rather than
   recreated. No member may name an absolute path or a `..` segment:
   the archive writes inside the restore dir and nowhere else. Members
   are written chunk by chunk — a file body is never buffered whole. */

interface TarHeader {
  name: string
  size: number
  mode: number
  type: string
}

const cstr = (buf: Buffer) => {
  const end = buf.indexOf(0)
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8')
}

function parseTarHeader(block: Buffer): TarHeader {
  if (block.subarray(257, 263).toString('latin1') !== 'ustar\0') {
    throw new Error('[data] the archive is not a ustar tar')
  }
  const flag = block[156] ?? 0
  const type = flag === 0 ? '0' : String.fromCharCode(flag)
  if (type !== '0' && type !== '5') {
    throw new Error(`[data] the archive holds a type-${flag} member — only files and directories are restored`)
  }
  const prefix = cstr(block.subarray(345, 500))
  const name = prefix ? `${prefix}/${cstr(block.subarray(0, 100))}` : cstr(block.subarray(0, 100))
  if (
    !name ||
    /^[\\/]/.test(name) ||
    /^[A-Za-z]:/.test(name) ||
    name.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    throw new Error(`[data] the archive member '${name || '<empty>'}' escapes the restore dir`)
  }
  const mode = Number.parseInt(cstr(block.subarray(100, 108)).trim(), 8)
  const size = Number.parseInt(cstr(block.subarray(124, 136)).trim(), 8)
  if (!Number.isFinite(mode) || !Number.isFinite(size)) {
    throw new Error(`[data] a bad tar header for '${name}'`)
  }
  return { name, size, mode, type }
}

async function untar(file: string, dest: string): Promise<void> {
  fsSync.mkdirSync(dest, { recursive: true, mode: 0o700 })
  const reader = fsSync.createReadStream(file).pipe(createGunzip())[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  /* consume exactly n decompressed bytes; a short stream is a truncated
     archive, not a member ending early */
  const take = async (n: number): Promise<Buffer> => {
    while (pending.length < n) {
      const next = await reader.next()
      if (next.done) throw new Error('[data] the archive ended mid-member — truncated')
      pending = Buffer.concat([pending, next.value])
    }
    const out = pending.subarray(0, n)
    pending = pending.subarray(n)
    return out
  }
  for (;;) {
    const block = await take(512)
    if (block.every((byte) => byte === 0)) break /* end-of-archive marker */
    const header = parseTarHeader(block)
    const full = path.join(dest, header.name)
    if (header.type === '5') {
      fsSync.mkdirSync(full, { recursive: true })
      fsSync.chmodSync(full, header.mode & 0o777)
      continue
    }
    fsSync.mkdirSync(path.dirname(full), { recursive: true })
    const out = createWriteStream(full, { mode: header.mode & 0o777 })
    let remaining = header.size
    while (remaining > 0) {
      const part = await take(Math.min(remaining, 64 * 1024))
      if (!out.write(part)) await once(out, 'drain')
      remaining -= part.length
    }
    out.end()
    await once(out, 'finish')
    /* apply the header's mode after writing — a creation mode bows to
       umask, the archive's is the contract */
    fsSync.chmodSync(full, header.mode & 0o777)
    const pad = (512 - (header.size % 512)) % 512
    if (pad) await take(pad)
  }
}
