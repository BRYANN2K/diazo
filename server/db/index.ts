import { env } from '../env.ts'
import { dataDir } from '../paths.ts'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PGlite } from '@electric-sql/pglite'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema.ts'

/**
 * DATABASE_URL set   -> real Postgres (production: Railway/Fly managed PG)
 * DATABASE_URL unset -> PGlite, an embedded Postgres persisted to ./data/pg
 * Same dialect, same schema, same queries either way.
 *
 * Schema changes: edit schema.ts / auth-schema.ts, then `npx drizzle-kit
 * generate` — the SQL lands in ./migrations and is applied here at boot.
 * Migration 0000 doubles as a baseline: fully idempotent, so databases
 * created by the pre-migration boot DDL adopt the journal cleanly.
 */

export type Db = NodePgDatabase<typeof schema>

export let db: Db

let pgliteClient: PGlite | undefined

/** The embedded Postgres handle, when there is one — for the daily backup
 *  and a clean shutdown. */
export function pglite(): PGlite | undefined {
  return pgliteClient
}

/* resolved from this file, not process.cwd() — the server may be launched
   from anywhere (tests spawn it from a temp working directory). A bundled
   build moves import.meta.url, so DOOP_MIGRATIONS_DIR names the copy it ships. */
const MIGRATIONS = env.DOOP_MIGRATIONS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export async function initDb(): Promise<void> {
  const url = env.DATABASE_URL
  if (url) {
    const { drizzle } = await import('drizzle-orm/node-postgres')
    db = drizzle(url, { schema })
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    await migrate(db, { migrationsFolder: MIGRATIONS })
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    const { drizzle } = await import('drizzle-orm/pglite')
    const dir = path.join(dataDir(), 'pg')
    fs.mkdirSync(dir, { recursive: true }) // PGlite's own mkdir isn't recursive
    const client = new PGlite(dir)
    pgliteClient = client
    const pgliteDb = drizzle(client, { schema })
    await guardMigrations(client)
    const { migrate } = await import('drizzle-orm/pglite/migrator')
    await migrate(pgliteDb, { migrationsFolder: MIGRATIONS })
    db = pgliteDb as unknown as Db
  }
}

/* ------------------------------------------------ migration guards (PGlite)
   The relocatable install gets two guards before the migrator runs:
   refuse a data dir written by a newer build — silently skipping applied
   migrations is a downgrade — and back the data dir up before applying
   pending ones, so a bad migration never strands real data. A managed
   Postgres keeps its own story, so DATABASE_URL stays untouched. */

interface JournalEntry {
  tag: string
  when: number
}

function bundledJournal(): JournalEntry[] {
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[]
  }
  return journal.entries
}

async function appliedJournal(client: PGlite): Promise<{ count: number; newest: number }> {
  const exists = await client.query<{ t: string | null }>(`select to_regclass('drizzle.__drizzle_migrations') as t`)
  if (!exists.rows[0]?.t) return { count: 0, newest: 0 }
  const rows = await client.query<{ n: number; newest: number | string | null }>(
    'select count(*)::int as n, max(created_at) as newest from drizzle.__drizzle_migrations',
  )
  return { count: Number(rows.rows[0]?.n ?? 0), newest: Number(rows.rows[0]?.newest ?? 0) }
}

async function guardMigrations(client: PGlite): Promise<void> {
  const journal = bundledJournal()
  const applied = await appliedJournal(client)
  const bundledNewest = Math.max(0, ...journal.map((entry) => entry.when))
  /* timestamps normally order the two journals; the count catches the same
     newest `when` reached by extra entries the bundle does not carry */
  if (applied.newest > bundledNewest || applied.count > journal.length) {
    const message = `[db] this data dir was written by a newer build (applied migration at ${applied.newest} is past this bundle's ${bundledNewest})`
    /* a dev checkout moves the same data dir between branches — switching
       back to dev after a branch with an extra migration must not refuse
       to boot. Production and tests keep the hard refusal: an older build
       on newer data is a silent downgrade */
    if (env.isDev) {
      console.warn(`${message} — booting anyway, NODE_ENV=development tolerates it`)
    } else {
      await client.close().catch(() => {})
      throw new Error(`${message} — update Diazo instead of running an older build on it`)
    }
  }
  /* a first boot applies the whole journal to an empty database: pending,
     yes, but there is nothing to lose, so the backup can be skipped */
  if (applied.count > 0 && journal.some((entry) => entry.when > applied.newest)) {
    const { backupNow } = await import('../backup.ts')
    await backupNow(client, 'pre-migration')
  }
}
