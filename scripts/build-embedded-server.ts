/**
 * Builds the embedded-server folder the desktop shell ships: one ESM bundle
 * plus the pieces it resolves by path at runtime.
 *
 *   bun run build:embedded-server                            # -> out/embedded-server/
 *   bun run build:embedded-server -- --no-web                # reuse the existing dist/
 *   bun run build:embedded-server -- --web-src <dir>         # serve a prebuilt web root (tests)
 *   bun run build:embedded-server -- --os linux --cpu x64    # stage node_modules for another target (bun)
 *
 * Produces:
 *   out/embedded-server/
 *     server.mjs       the whole server (express, ws, drizzle, auth, mcp), minified
 *     node_modules/    only the externals the bundle does not carry — sharp
 *                      with the target's @img/* packages and libvips,
 *                      @electric-sql/pglite (finds its .wasm and data files by
 *                      URL, so it cannot be inlined), and fs-ext — the native
 *                      module behind the data-dir lock (build/Release/*.node).
 *     migrations/      the drizzle SQL + journal applied at boot (the meta
 *                      snapshots are drizzle-kit's, not the migrator's — dropped)
 *     backgrounds.json the catalog server/backgrounds.ts seeds from
 *     dist/            the web build the production server serves (no .map)
 *
 * `pg` and `@aws-sdk/client-s3` are left external but not shipped: they are
 * only imported when DATABASE_URL or BUCKET is set, and the embedded install
 * sets neither.
 *
 * Boot it (a read-only install dir is fine — everything stateful lands in
 * DOOP_DATA_DIR):
 *   DOOP_DATA_DIR=<data> DOOP_LISTEN_HOST=127.0.0.1 DOOP_EMBEDDED=1 DOOP_INSTALL=desktop \
 *   NODE_ENV=production BETTER_AUTH_URL=http://127.0.0.1:4400 BETTER_AUTH_SECRET=<secret> \
 *   node <out>/server.mjs        # prints `ready <port>` once listening
 *
 * The shell sets NODE_COMPILE_CACHE=<app cache dir> for the V8 compile cache
 * (Node honours the variable itself — nothing here wires it).
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(path.join(ROOT, 'package.json'))

/* ------------------------------------------------------------------ */
/* arguments                                                           */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2).filter((arg) => arg !== '--')
const has = (name: string) => args.includes(name)
const option = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const outDir = path.resolve(ROOT, option('--out') ?? 'out/embedded-server')
const targetOs = option('--os') // npm platform names: darwin, linux, win32
const targetCpu = option('--cpu') // x64, arm64
const webSrc = option('--web-src') ? path.resolve(ROOT, option('--web-src')!) : undefined
if ((targetOs === undefined) !== (targetCpu === undefined)) {
  console.error('--os and --cpu go together')
  process.exit(1)
}

/* the packages the bundle leaves out; of those, only these ship beside it.
   drizzle-orm/node-postgres must stay external too: bundling it hoists its
   `import 'pg'` to the top of server.mjs, where it resolves eagerly — under a
   bare install dir (no parent node_modules) the boot then dies on the missing
   package even though the embedded path never calls it */
const EXTERNALS = [
  'sharp',
  '@electric-sql/pglite',
  'pg',
  '@aws-sdk/client-s3',
  'drizzle-orm/node-postgres',
  'drizzle-orm/node-postgres/migrator',
  'fs-ext',
]
const SHIPPED = ['sharp', '@electric-sql/pglite', 'fs-ext']

/* ------------------------------------------------------------------ */
/* steps                                                               */
/* ------------------------------------------------------------------ */

function run(cmd: string, cmdArgs: string[], cwd = ROOT) {
  const result = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`${cmd} ${cmdArgs.join(' ')} failed (${result.status})`)
    process.exit(result.status ?? 1)
  }
}

function sizeOf(file: string): number {
  const stat = statSync(file)
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const entry of readdirSync(file, { withFileTypes: true })) {
    const full = path.join(file, entry.name)
    total += entry.isDirectory() ? sizeOf(full) : statSync(full).size
  }
  return total
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/* the web build the server serves in production */
if (!has('--no-web') && !webSrc) run('bun', ['run', 'build'])
const distSrc = webSrc ?? path.join(ROOT, 'dist')
if (!existsSync(path.join(distSrc, 'index.html'))) {
  console.error('dist/index.html is missing — run `bun run build`, drop --no-web, or pass --web-src')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

/* 1. the bundle itself. Minified — the shipped file's stack traces are
   already opaque to a user; keepNames keeps the error classes the code
   matches on (renderer checks error.name, puppeteer errors included). */
await build({
  entryPoints: [path.join(ROOT, 'server/index.ts')],
  outfile: path.join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  keepNames: true,
  external: EXTERNALS,
  /* bundled CommonJS deps keep dynamic require() calls (conditionals,
     optionals) that ESM has no answer for — give them a real one, named so it
     cannot collide with a createRequire import a dep may carry */
  banner: {
    js: "import { createRequire as __embeddedCreateRequire } from 'node:module'\nglobalThis.require = __embeddedCreateRequire(import.meta.url)",
  },
  logLevel: 'info',
})

/* 2. node_modules for the externals */
const nodeModulesOut = path.join(outDir, 'node_modules')
if (targetOs && targetCpu) {
  /* fs-ext ships no prebuild — it compiles at install, which --ignore-scripts
     skips and a host build would produce for the wrong target anyway. A
     cross-staged bundle needs `npm rebuild fs-ext` (or node-gyp) run on the
     target itself; native per-OS builds are unaffected. */
  console.warn(
    `warn: fs-ext is built at install — the staged node_modules lack its .node for ${targetOs}/${targetCpu}; rebuild it on the target`,
  )
  /* another platform: `bun install --os --cpu` resolves the matching optional
     deps (@img/*) where npm's same flags skip them entirely */
  const staged = mkdtempSync(path.join(tmpdir(), 'diazo-bundle-nm-'))
  writeFileSync(path.join(staged, 'package.json'), JSON.stringify({ name: 'embedded-server-nm', private: true }))
  const pins = SHIPPED.map((name) => {
    const version = (JSON.parse(readFileSync(req.resolve(`${name}/package.json`), 'utf8')) as { version: string })
      .version
    return `${name}@${version}`
  })
  run('bun', ['add', '--ignore-scripts', `--os=${targetOs}`, `--cpu=${targetCpu}`, ...pins], staged)
  cpSync(path.join(staged, 'node_modules'), nodeModulesOut, { recursive: true })
  rmSync(staged, { recursive: true, force: true })
} else {
  /* this platform: walk the installed tree and copy each reachable package */
  const queue = [...SHIPPED]
  const seen = new Set<string>()
  while (queue.length) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    let pkgPath: string | undefined
    try {
      pkgPath = req.resolve(`${name}/package.json`)
    } catch {
      try {
        /* exports maps may hide ./package.json (@electric-sql/pglite does):
           resolve the entry and walk up to the manifest that names itself */
        let dir = path.dirname(req.resolve(name))
        for (;;) {
          const candidate = path.join(dir, 'package.json')
          if (existsSync(candidate)) {
            const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }
            if (manifest.name === name) {
              pkgPath = candidate
              break
            }
          }
          const up = path.dirname(dir)
          if (up === dir) break
          dir = up
        }
      } catch {
        /* resolve failed: an optional dep of another platform */
      }
    }
    /* binary-only packages (@img/*) export nothing at all: find them by
       name under this install's node_modules */
    if (!pkgPath) {
      const direct = path.join(ROOT, 'node_modules', name, 'package.json')
      if (existsSync(direct)) pkgPath = direct
    }
    if (!pkgPath) continue
    cpSync(path.dirname(pkgPath), path.join(nodeModulesOut, name), { recursive: true, dereference: true })
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    queue.push(...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}))
  }
}
pruneNodeModules(nodeModulesOut)

/* 3. the pieces the code resolves by path. The migrator needs the .sql files
   and the journal only — meta/*.json snapshots are drizzle-kit's inputs, not
   runtime state (6.4 MB of the folder). dist/*.map are browser devtools
   material the server never sends unprompted. */
cpSync(path.join(ROOT, 'server/db/migrations'), path.join(outDir, 'migrations'), {
  recursive: true,
  filter: (src) =>
    statSync(src).isDirectory() ||
    src.endsWith('.sql') ||
    src === path.join(ROOT, 'server/db/migrations/meta/_journal.json'),
})
cpSync(path.join(ROOT, 'server/backgrounds.json'), path.join(outDir, 'backgrounds.json'))
cpSync(distSrc, path.join(outDir, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') })

/* prune after copying so a removed file can never be re-added by a
   dependency's own subtree */
function pruneNodeModules(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      /* PGlite ships per-extension tarballs and subpath trees the server
         never loads (no CREATE EXTENSION in the journal; worker/live/
         templating are other entry points), plus a browser-only fs. */
      const inside = path.relative(nodeModulesOut, full).split(path.sep).join('/')
      const deadDirs = [
        'sharp/src',
        '@electric-sql/pglite/dist/contrib',
        '@electric-sql/pglite/dist/live',
        '@electric-sql/pglite/dist/worker',
        /* node-gyp's object files — only Release/fs_ext.node is loaded */
        'fs-ext/build/Release/obj.target',
        'fs-ext/build/Release/.deps',
        'fs-ext/tests',
      ]
      if (deadDirs.includes(inside)) {
        rmSync(full, { recursive: true, force: true })
        continue
      }
      pruneNodeModules(full)
      continue
    }
    const name = entry.name
    const inPglite = full.includes(`${path.sep}@electric-sql${path.sep}pglite${path.sep}`)
    if (
      name.endsWith('.map') ||
      name.endsWith('.d.ts') ||
      name.endsWith('.d.cts') ||
      (inPglite &&
        (name.endsWith('.cjs') ||
          name.endsWith('.tar.gz') ||
          name.startsWith('templating.') ||
          name.startsWith('opfs-ahp.')))
    ) {
      unlinkSync(full)
    }
  }
}

/* 4. the bill */
const parts: [string, number][] = [
  ['server.mjs', sizeOf(path.join(outDir, 'server.mjs'))],
  ['node_modules', sizeOf(nodeModulesOut)],
  ['migrations', sizeOf(path.join(outDir, 'migrations'))],
  ['backgrounds.json', sizeOf(path.join(outDir, 'backgrounds.json'))],
  ['dist', sizeOf(path.join(outDir, 'dist'))],
]
console.log('\nBundle at', outDir)
for (const [name, bytes] of parts) console.log(`  ${name.padEnd(18)} ${mb(bytes)}`)
console.log(`  ${'total'.padEnd(18)} ${mb(parts.reduce((sum, [, bytes]) => sum + bytes, 0))}`)
