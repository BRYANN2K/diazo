/**
 * Bundles the server for an embedded install: one ESM file plus the pieces it
 * resolves by path at runtime.
 *
 *   bun run build:server-bundle                            # -> out/embedded-server/
 *   bun run build:server-bundle -- --no-web                # reuse the existing dist/
 *   bun run build:server-bundle -- --os linux --cpu x64    # stage node_modules for another target (npm)
 *
 * Produces:
 *   out/embedded-server/
 *     server.mjs       the whole server (express, ws, drizzle, auth, mcp)
 *     node_modules/    only the externals the bundle does not carry — sharp
 *                      with the target's @img/* packages and libvips, and
 *                      @electric-sql/pglite (finds its .wasm and data files by
 *                      URL, so it cannot be inlined)
 *     migrations/      the drizzle SQL + journal applied at boot
 *     backgrounds.json the catalog server/backgrounds.ts seeds from
 *     dist/            the web build the production server serves
 *
 * `pg` and `@aws-sdk/client-s3` are left external but not shipped: they are
 * only imported when DATABASE_URL or BUCKET is set, and the embedded install
 * sets neither.
 *
 * Boot it:
 *   DOOP_DATA_DIR=<data> DOOP_DIST_DIR=<out>/dist DOOP_MIGRATIONS_DIR=<out>/migrations \
 *   DOOP_LISTEN_HOST=127.0.0.1 NODE_ENV=production BETTER_AUTH_URL=http://127.0.0.1:4400 \
 *   BETTER_AUTH_SECRET=<secret> node <out>/server.mjs
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
if ((targetOs === undefined) !== (targetCpu === undefined)) {
  console.error('--os and --cpu go together')
  process.exit(1)
}

/* the packages the bundle leaves out; of those, only these ship beside it */
const EXTERNALS = ['sharp', '@electric-sql/pglite', 'pg', '@aws-sdk/client-s3']
const SHIPPED = ['sharp', '@electric-sql/pglite']

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
if (!has('--no-web')) run('bun', ['run', 'build'])
if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing — run `bun run build` or drop --no-web')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

/* 1. the bundle itself */
await build({
  entryPoints: [path.join(ROOT, 'server/index.ts')],
  outfile: path.join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
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
  /* another platform: npm resolves the matching optional deps (@img/*) */
  const staged = mkdtempSync(path.join(tmpdir(), 'diazo-bundle-nm-'))
  writeFileSync(path.join(staged, 'package.json'), JSON.stringify({ name: 'embedded-server-nm', private: true }))
  const pins = SHIPPED.map((name) => {
    const version = (JSON.parse(readFileSync(req.resolve(`${name}/package.json`), 'utf8')) as { version: string })
      .version
    return `${name}@${version}`
  })
  run(
    'npm',
    ['install', '--no-save', '--omit=dev', '--ignore-scripts', `--os=${targetOs}`, `--cpu=${targetCpu}`, ...pins],
    staged,
  )
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
    let pkgPath: string
    try {
      pkgPath = req.resolve(`${name}/package.json`)
    } catch {
      continue /* an optional dep of another platform */
    }
    cpSync(path.dirname(pkgPath), path.join(nodeModulesOut, name), { recursive: true, dereference: true })
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    queue.push(...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}))
  }
}

/* 3. the pieces the code resolves by path */
cpSync(path.join(ROOT, 'server/db/migrations'), path.join(outDir, 'migrations'), { recursive: true })
cpSync(path.join(ROOT, 'server/backgrounds.json'), path.join(outDir, 'backgrounds.json'))
cpSync(path.join(ROOT, 'dist'), path.join(outDir, 'dist'), { recursive: true })

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
