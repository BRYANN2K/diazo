import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* scripts/install-local.sh against stub `uname`, `sw_vers`, `container` and
   `curl` on PATH: the whole flow runs on any CI runner, and no real container
   is ever started. The stub `container` logs each call to calls.log. */

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'install-local.sh')

let root: string
let home: string
let bin: string

function stub(name: string, body: string) {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  /* detached: a new session with no controlling terminal, so the uninstall
     prompt finds no /dev/tty and cannot block */
  const child = spawn('sh', [SCRIPT, ...args], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: root,
      DOOP_HEALTH_TIMEOUT: '4',
      STUB_DIR: root,
      ...env,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()))
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })
}

const calls = () => (existsSync(path.join(root, 'calls.log')) ? readFileSync(path.join(root, 'calls.log'), 'utf8') : '')
const envFile = () => path.join(home, '.doop', 'doop.env')
const runLine = () =>
  calls()
    .split('\n')
    .find((line) => line.startsWith('run ')) ?? ''

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'doop-install-'))
  home = path.join(root, 'home')
  bin = path.join(root, 'bin')
  spawnSync('mkdir', ['-p', home, bin])
  stub('uname', 'case $1 in -s) echo "${STUB_OS:-Darwin}" ;; -m) echo "${STUB_ARCH:-arm64}" ;; esac')
  stub('sw_vers', 'echo 26.0')
  stub('curl', 'exit 0')
  stub(
    'container',
    `echo "$*" >> "$STUB_DIR/calls.log"
case "$1 $2" in
  "system status") exit 0 ;;
  "image pull") case "$*" in *linux/arm64*) [ -z "$STUB_NO_ARM64" ] ;; *) exit 0 ;; esac ;;
  inspect*) [ -f "$STUB_DIR/exists" ] ;;
  run*) touch "$STUB_DIR/exists" ;;
  delete*) rm -f "$STUB_DIR/exists" ;;
esac`,
  )
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('install-local.sh', () => {
  it('rejects an unknown argument and a bad port', async () => {
    expect((await run(['--nope'])).code).not.toBe(0)
    expect((await run([], { DOOP_PORT: 'abc' })).out).toMatch(/DOOP_PORT must be a port number/)
    expect((await run([], { DOOP_PORT: '70000' })).code).not.toBe(0)
    expect(calls()).toBe('')
  })

  it('prints help without touching anything', async () => {
    const { code, out } = await run(['--help'])
    expect(code).toBe(0)
    expect(out).toMatch(/uninstall/)
    expect(existsSync(path.join(home, '.doop'))).toBe(false)
  })

  it('refuses anything but macOS on Apple silicon', async () => {
    expect((await run([], { STUB_OS: 'Linux' })).out).toMatch(/needs macOS/)
    expect((await run([], { STUB_ARCH: 'x86_64' })).out).toMatch(/Apple silicon/)
    expect(calls()).toBe('')
  })

  it('says how to install container when it is missing', async () => {
    rmSync(path.join(bin, 'container'))
    const { code, out } = await run([])
    expect(code).not.toBe(0)
    expect(out).toMatch(/github\.com\/apple\/container\/releases/)
  })

  it('generates secrets once, mode 600, and runs on localhost only', async () => {
    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(out).toMatch(/http:\/\/localhost:4400/)

    expect(statSync(envFile()).mode & 0o777).toBe(0o600)
    const env = readFileSync(envFile(), 'utf8')
    expect(env).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/m)
    expect(env).toMatch(/^SECRETS_ENCRYPTION_KEYS=local:[A-Za-z0-9+/]{43}=$/m)
    expect(existsSync(path.join(home, '.doop', 'data'))).toBe(true)
    expect(existsSync(path.join(home, '.doop', 'bin', 'doop-local'))).toBe(true)

    const line = runLine()
    expect(line).toContain('--publish 127.0.0.1:4400:4400')
    expect(line).toContain(`--volume ${home}/.doop/data:/app/data`)
    expect(line).toContain('--env BETTER_AUTH_URL=http://localhost:4400')
    /* the update card tells this install to run `doop-local update` */
    expect(line).toContain('--env DOOP_INSTALL=local')
    expect(line).not.toContain('--rosetta')
    expect(line.endsWith('ghcr.io/bryann2k/redoop:main')).toBe(true)
  })

  it('keeps the secrets and replaces the container on a re-run', async () => {
    expect((await run([])).code).toBe(0)
    const before = readFileSync(envFile(), 'utf8')
    writeFileSync(path.join(root, 'calls.log'), '')
    expect((await run([], { DOOP_PORT: '4500' })).code).toBe(0)
    expect(readFileSync(envFile(), 'utf8')).toBe(before)
    expect(calls()).toMatch(/^stop doop$/m)
    expect(calls()).toMatch(/^delete --force doop$/m)
    expect(runLine()).toContain('--publish 127.0.0.1:4500:4400')
  })

  it('falls back to the amd64 image under Rosetta when no arm64 one is published', async () => {
    expect((await run([], { STUB_NO_ARM64: '1' })).code).toBe(0)
    expect(runLine()).toContain('--platform linux/amd64 --rosetta')
  })

  it('fails when doop never answers', async () => {
    stub('curl', 'exit 7')
    const { code, out } = await run([])
    expect(code).not.toBe(0)
    expect(out).toMatch(/did not answer/)
  })

  it('stops, and uninstalls keeping the data unless told otherwise', async () => {
    expect((await run([])).code).toBe(0)
    expect((await run(['--stop'])).out).toMatch(/stopped/)

    expect((await run(['--uninstall'])).out).toMatch(/kept/)
    expect(existsSync(envFile())).toBe(true)
    expect(calls()).toMatch(/^image delete ghcr\.io\/bryann2k\/redoop:main$/m)

    expect((await run(['uninstall', '--yes'])).code).toBe(0)
    expect(existsSync(path.join(home, '.doop'))).toBe(false)
  })
})
