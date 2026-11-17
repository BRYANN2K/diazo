import { env } from './env.ts'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the server's files live. Every stateful write lands under the data
 * dir (PGlite, assets, backups, the lock file; the renderer and its
 * profiles too on the installs that manage them), so a packaged install
 * can sit in a read-only folder and nothing else is ever touched. Read at
 * call time so tests can flip the variables.
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

/** The downloaded headless renderer. Unset = <data>/browser. */
export function browserDir(): string {
  return env.DOOP_BROWSER_DIR ?? path.join(dataDir(), 'browser')
}

/** Parent dir for the per-launch `profile-*` dirs, where we manage it:
 *  always inside the (locked) data dir — never inside the browser dir
 *  itself, which DOOP_BROWSER_DIR may share between two servers for the
 *  download, and a sweep there would delete the other's live profile.
 *  Managed for the embedded install or an explicit DOOP_BROWSER_DIR;
 *  undefined anywhere else — the profile then stays on puppeteer's
 *  temp-dir default, the behaviour Docker and a source checkout had
 *  before the data-dir layout (Chrome's singleton socket and locks are
 *  unreliable on the volume's bind mounts and PVCs). */
export function browserProfileDir(): string | undefined {
  return env.DOOP_BROWSER_DIR || env.DOOP_EMBEDDED ? path.join(dataDir(), 'browser-profiles') : undefined
}

/** `pg-<date>.tar.gz` dumps plus their asset manifests. */
export function backupsDir(): string {
  return path.join(dataDir(), 'backups')
}
