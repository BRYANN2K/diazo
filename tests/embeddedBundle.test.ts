import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { freePort } from './harness.ts'

/**
 * The relocatable-install contract, end to end on the real bundle:
 *   scripts/build-embedded-server.ts -> copy to a fresh dir -> make the
 *   install read-only -> boot `node server.mjs` from yet another cwd with
 *   DOOP_DATA_DIR elsewhere -> `ready <port>` on stdout, answers on
 *   127.0.0.1, refuses non-loopback, writes nothing outside the data dir,
 *   and exits when stdin closes (the sidecar handshake for the desktop
 *   shell).
 *
 * --web-src skips the vite build: production-serving only needs an
 * index.html for BUILD_ID and static hosting, and the bundle itself is
 * what this test is about.
 */

const ROOT = process.cwd()
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx')
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build-embedded-server.ts')

let base: string
let installDir: string
let dataDir: string
let workDir: string
let proc: ChildProcess | undefined

/* relative path -> byte size, for the "install dir untouched" assertion */
function snapshot(dir: string, prefix = '', into = new Map<string, number>()): Map<string, number> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) snapshot(full, `${rel}/`, into)
    else into.set(rel, fs.statSync(full).size)
  }
  return into
}

function chmodTree(dir: string, fileMode: number, dirMode: number): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      fs.chmodSync(full, dirMode)
      chmodTree(full, fileMode, dirMode)
    } else {
      fs.chmodSync(full, fileMode)
    }
  }
}

/** The machine's non-loopback IPv4 addresses — what "listens on 127.0.0.1
 *  only" is tested against. Empty on hosts with no external interface. */
function externalAddrs(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port })
    s.setTimeout(3_000)
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
    s.once('timeout', () => {
      s.destroy()
      resolve(false)
    })
  })
}

let installSnapshot: Map<string, number>
let port: number

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-test-'))
  const webDir = path.join(base, 'web')
  const buildDir = path.join(base, 'build')
  installDir = path.join(base, 'install')
  dataDir = path.join(base, 'data')
  workDir = path.join(base, 'work')
  fs.mkdirSync(webDir, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>embedded test</title><div id="root"></div>')

  const build = spawnSync(TSX, [BUILD_SCRIPT, '--out', buildDir, '--web-src', webDir], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300_000,
  })
  if (build.status !== 0) {
    throw new Error(`build-embedded-server failed:\n${build.stdout}\n${build.stderr}`)
  }

  /* the installed copy is what runs: built elsewhere, then relocated and
     frozen read-only like a packaged app */
  fs.cpSync(buildDir, installDir, { recursive: true, dereference: true })
  chmodTree(installDir, 0o444, 0o555)
  installSnapshot = snapshot(installDir)

  port = await freePort()
}, 360_000)

afterAll(() => {
  if (proc && proc.exitCode === null) proc.kill('SIGKILL')
  if (base) {
    try {
      chmodTree(installDir, 0o644, 0o755)
      fs.rmSync(base, { recursive: true, force: true })
    } catch {
      /* temp dir cleanup is best effort */
    }
  }
})

describe('embedded bundle boot (scripts/build-embedded-server.ts)', () => {
  it('ships the server and the data tool — no native lock module, no stray .node', () => {
    /* the sidecar and the restore command line are both in the bundle */
    expect(fs.existsSync(path.join(installDir, 'server.mjs'))).toBe(true)
    expect(fs.existsSync(path.join(installDir, 'data-tool.mjs'))).toBe(true)
    /* the data lock is node:sqlite — a Node built-in: no fs-ext module,
       and no .node binary anywhere outside sharp's own packages */
    expect(fs.existsSync(path.join(installDir, 'node_modules', 'fs-ext'))).toBe(false)
    const stray: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.node')) stray.push(path.relative(installDir, full))
      }
    }
    walk(path.join(installDir, 'node_modules'))
    for (const file of stray) {
      expect(file, `${file} is a native module outside sharp`).toMatch(/^node_modules[/\\](sharp|@img)[/\\]/)
    }
  })

  it('boots a read-only install on loopback, prints ready, writes only under DOOP_DATA_DIR, dies with stdin', async () => {
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      /* blank, not absent — DOOP_EMBEDDED alone must bind loopback even
         when the shell forgot (or exported) DOOP_LISTEN_HOST */
      DOOP_LISTEN_HOST: '',
      DOOP_DATA_DIR: dataDir,
      DOOP_EMBEDDED: '1',
      DOOP_INSTALL: 'desktop',
      DOOP_UPDATE_CHECK: 'false',
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      BETTER_AUTH_SECRET: 'embedded-test-secret-not-real-0123456789',
      DATABASE_URL: '',
      BUCKET: '',
      POSTHOG_KEY: '',
      VITE_POSTHOG_KEY: '',
    }
    proc = spawn('node', [path.join(installDir, 'server.mjs')], {
      cwd: workDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout!.on('data', (c: Buffer) => (stdout += c.toString()))
    proc.stderr!.on('data', (c: Buffer) => (stderr += c.toString()))
    const exited = new Promise<number | null>((r) => proc!.once('exit', (code) => r(code)))

    /* the sidecar handshake: one `ready <port>` line once listening */
    const ready = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready line in 90s\n${stdout}\n${stderr}`)), 90_000)
      const seen = () => {
        const m = /^ready (\d+)$/m.exec(stdout)
        if (m) {
          clearTimeout(timer)
          resolve(Number(m[1]))
        }
        void exited.then((code) => reject(new Error(`server exited (${code}) before ready\n${stdout}\n${stderr}`)))
      }
      proc!.stdout!.on('data', seen)
      seen()
    })
    expect(ready).toBe(port)

    /* serving on loopback */
    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(health.ok).toBe(true)

    /* and ONLY loopback: every external interface refuses the same port */
    for (const addr of externalAddrs()) {
      expect(await canConnect(addr, port), `port ${port} reachable on ${addr}`).toBe(false)
    }

    /* the parent going away = stdin closing = clean shutdown */
    proc.stdin!.end()
    const code = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 30_000))])
    expect(code, `server did not exit after stdin closed\n${stdout}\n${stderr}`).toBe(0)

    /* nothing outside the data dir: install dir byte-identical, cwd empty */
    expect(snapshot(installDir)).toEqual(installSnapshot)
    expect(fs.readdirSync(workDir)).toEqual([])

    /* state really did land in the data dir, and the clean exit left
       its released-<N> marker for the next boot */
    expect(fs.existsSync(path.join(dataDir, 'pg'))).toBe(true)
    const lockEntries = fs.readdirSync(path.join(dataDir, 'lock'))
    expect(lockEntries.some((n) => /^released-\d+$/.test(n))).toBe(true)

    /* the released lock means the same data dir boots again at once —
       the restart path a packaged install takes on every relaunch */
    const port2 = await freePort()
    const env2 = { ...env, PORT: String(port2), BETTER_AUTH_URL: `http://127.0.0.1:${port2}` }
    proc = spawn('node', [path.join(installDir, 'server.mjs')], {
      cwd: workDir,
      env: env2,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    stdout = ''
    stderr = ''
    proc.stdout!.on('data', (c: Buffer) => (stdout += c.toString()))
    proc.stderr!.on('data', (c: Buffer) => (stderr += c.toString()))
    const exited2 = new Promise<number | null>((r) => proc!.once('exit', (code) => r(code)))
    const ready2 = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready line on restart in 90s\n${stdout}\n${stderr}`)), 90_000)
      const seen = () => {
        const m = /^ready (\d+)$/m.exec(stdout)
        if (m) {
          clearTimeout(timer)
          resolve(Number(m[1]))
        }
        void exited2.then((c) =>
          reject(new Error(`server exited (${c}) before ready on restart\n${stdout}\n${stderr}`)),
        )
      }
      proc!.stdout!.on('data', seen)
      seen()
    })
    expect(ready2).toBe(port2)
    const health2 = await fetch(`http://127.0.0.1:${port2}/healthz`)
    expect(health2.ok).toBe(true)
    proc.stdin!.end()
    const code2 = await Promise.race([exited2, new Promise<null>((r) => setTimeout(() => r(null), 30_000))])
    expect(code2, `server did not exit after stdin closed on restart\n${stdout}\n${stderr}`).toBe(0)
  }, 240_000)
})
