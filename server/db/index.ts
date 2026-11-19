import { env } from '../env.ts'
import { dataDir } from '../paths.ts'
import { backupNow } from '../backup.ts'
import { completeInterruptedRestore } from '../restore.ts'
import { appliedJournal, bundledJournal, newerDataMessage } from './journal.ts'
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
    /* a crash mid-restore can leave the swap half done: a ready
       `pg.restore-*` waiting to become `pg`, or `pg` moved aside with
       nothing to take its place. Finish or refuse BEFORE the dir is
       created — mkdir first would hide the state behind a fresh pg */
    completeInterruptedRestore(dataDir())
    const dir = path.join(dataDir(), 'pg')
    fs.mkdirSync(dir, { recursive: true }) // PGlite's own mkdir isn't recursive
    const client = new PGlite(dir)
    await guardMigrations(client)
    pgliteClient = client
    const pgliteDb = drizzle(client, { schema })
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

/** Whether the database holds user tables — what separates a populated
 *  pre-journal database (created by the pre-migration boot DDL, real data
 *  and no `drizzle.__drizzle_migrations` journal to count) from a freshly
 *  initialized cluster where pending migrations have nothing to lose. */
async function hasUserTables(client: PGlite): Promise<boolean> {
  const rows = await client.query<{ n: number }>(
    `select count(*)::int as n from pg_catalog.pg_tables
     where schemaname not in ('pg_catalog', 'information_schema')`,
  )
  return Number(rows.rows[0]?.n ?? 0) > 0
}

async function guardMigrations(client: PGlite): Promise<void> {
  const journal = bundledJournal()
  const applied = await appliedJournal(client)
  const newer = newerDataMessage(applied, journal)
  if (newer) {
    /* a dev checkout moves the same data dir between branches — switching
       back to dev after a branch with an extra migration must not refuse
       to boot. Production and tests keep the hard refusal: an older build
       on newer data is a silent downgrade */
    if (env.isDev) {
      console.warn(`${newer} — booting anyway, NODE_ENV=development tolerates it`)
    } else {
      await client.close().catch(() => {})
      throw new Error(`${newer} — update Diazo instead of running an older build on it`)
    }
  }
  /* a first boot applies the whole journal to an empty database: pending,
     yes, but there is nothing to lose, so the backup can be skipped. A
     populated one is backed up whether or not a journal counted it —
     databases created before the journal existed hold real data too */
  if (journal.some((entry) => entry.when > applied.newest) && (await hasUserTables(client))) {
    /* the snapshot runs under the database's own mutex on THIS client —
       the open handle is the point: closing and reopening to copy a
       quiescent dir is what the backup's critical section replaced
       (server/backup.ts) */
    await backupNow(client, 'pre-migration')
  }
}
