import { env } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the server's files live. Every stateful write lands under the data
 * dir (PGlite, assets, backups, the lock file, the browser's profile), so a
 * packaged install can sit in a read-only folder and nothing else is ever
 * touched. Read at call time so tests can flip the variables.
 */

/** State: PGlite, uploaded assets (no BUCKET), backups, server.lock, the
 *  legacy store.json import. Unset = ./data under the working directory, the
 *  layout the checkout and the container use. */
export function dataDir(): string {
  return env.DOOP_DATA_DIR ?? path.join(process.cwd(), 'data')
}

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The built client the production server serves. A bundle ships dist/
 *  beside server.mjs — import.meta.url resolves there whatever the working
 *  directory; a source checkout keeps ./dist under the repo root. */
export function distDir(): string {
  if (env.DOOP_DIST_DIR) return env.DOOP_DIST_DIR
  const beside = path.join(HERE, 'dist')
  return fs.existsSync(beside) ? beside : path.join(HERE, '..', 'dist')
}

/** The downloaded headless renderer and its profile dirs. Unset =
 *  <data>/browser, keeping browser state inside the data dir. */
export function browserDir(): string {
  return env.DOOP_BROWSER_DIR ?? path.join(dataDir(), 'browser')
}

/** `pg-<date>.tar.gz` dumps plus their asset manifests. */
export function backupsDir(): string {
  return path.join(dataDir(), 'backups')
}
