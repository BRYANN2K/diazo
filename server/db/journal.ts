import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PGlite } from '@electric-sql/pglite'
import { env } from '../env.ts'

/* resolved from this file, not process.cwd() — the server may be launched
   from anywhere (tests spawn it from a temp working directory). A bundled
   build moves import.meta.url, so DOOP_MIGRATIONS_DIR names the copy it
   ships. Shared by the boot migration guard and by restore, which must
   compare against exactly the same journal. */
const MIGRATIONS = env.DOOP_MIGRATIONS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export interface JournalEntry {
  tag: string
  when: number
}

export function bundledJournal(): JournalEntry[] {
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[]
  }
  return journal.entries
}

/** The applied journal a live database reports — count of rows and the
 *  newest `when`, so a populated pre-journal database (no
 *  `drizzle.__drizzle_migrations` table at all) reads as {0, 0}. */
export async function appliedJournal(client: PGlite): Promise<{ count: number; newest: number }> {
  const exists = await client.query<{ t: string | null }>(`select to_regclass('drizzle.__drizzle_migrations') as t`)
  if (!exists.rows[0]?.t) return { count: 0, newest: 0 }
  const rows = await client.query<{ n: number; newest: number | string | null }>(
    'select count(*)::int as n, max(created_at) as newest from drizzle.__drizzle_migrations',
  )
  return { count: Number(rows.rows[0]?.n ?? 0), newest: Number(rows.rows[0]?.newest ?? 0) }
}

/** The refusal message when an applied journal is newer than this
 *  build's bundled one — null when it is not. The boot guard tolerates
 *  it in development (a checkout moves one data dir between branches);
 *  restore refuses it in every NODE_ENV. Timestamps normally order the
 *  two journals; the count catches the same newest `when` reached by
 *  extra entries the bundle does not carry. */
export function newerDataMessage(
  applied: { count: number; newest: number },
  journal: JournalEntry[] = bundledJournal(),
): string | null {
  const bundledNewest = Math.max(0, ...journal.map((entry) => entry.when))
  if (applied.newest <= bundledNewest && applied.count <= journal.length) return null
  return `[db] this data dir was written by a newer build (applied migration at ${applied.newest} is past this bundle's ${bundledNewest})`
}
