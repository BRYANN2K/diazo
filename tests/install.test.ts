import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* scripts/install.sh, the all-in-one install, against stub `uname`,
   `sw_vers`, `container`, `launchctl`, `curl`, `open` and `osascript` on PATH.
   It runs the real install-local.sh (its container calls go to the stub) and
   a stand-in install-desktop.sh that logs its arguments and makes or removes
   Diazo.app: that script has its own tests (installDesktop.test.ts). Nothing
   is installed and no container is started; every stub logs to calls.log. */

const SCRIPTS = path.resolve(import.meta.dirname, '..', 'scripts')
const SCRIPT = path.join(SCRIPTS, 'install.sh')
const RAW = 'https://raw.githubusercontent.com/BRYANN2K/diazo/main/scripts'

let root: string
let home: string
let bin: string
let lib: string
let apps: string
let links: string

function stub(name: string, body: string) {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

function baseEnv(env: Record<string, string>) {
  return {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin`,
    HOME: home,
    TMPDIR: root,
    STUB_DIR: root,
    DOOP_HEALTH_TIMEOUT: '4',
    DOOP_DESKTOP_SYSTEM_APPS: apps,
    DIAZO_LIB: lib,
    DIAZO_LINK_DIRS: links,
    ...env,
  }
}

function collect(child: ReturnType<typeof spawn>): Promise<{ code: number | null; out: string }> {
  let out = ''
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()))
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })
}

/* detached: no controlling terminal, so a prompt finds no /dev/tty */
function run(args: string[], env: Record<string, string> = {}, script = SCRIPT) {
  return collect(
    spawn('sh', [script, ...args], { env: baseEnv(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  )
}

/* as `curl -fsSL …/install.sh | sh -s -- args`: the script on stdin */
function runPiped(args: string[], env: Record<string, string> = {}) {
  const child = spawn('sh', ['-s', '--', ...args], {
    env: baseEnv(env),
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin?.end(readFileSync(SCRIPT))
  return collect(child)
}

const calls = () => (existsSync(path.join(root, 'calls.log')) ? readFileSync(path.join(root, 'calls.log'), 'utf8') : '')
const clearCalls = () => writeFileSync(path.join(root, 'calls.log'), '')
const appData = () => path.join(home, 'Library', 'Application Support', 'dev.bryann2k.diazo')
const serverJson = () => path.join(appData(), 'server.json')
const plist = () => path.join(home, 'Library', 'LaunchAgents', 'dev.bryann2k.diazo.server.plist')
const diazoHome = () => path.join(home, '.diazo')

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'diazo-all-in-one-'))
  home = path.join(root, 'home')
  bin = path.join(root, 'bin')
  lib = path.join(root, 'lib')
  apps = path.join(root, 'Applications')
  links = path.join(home, '.local', 'bin')
  for (const dir of [home, bin, lib, apps]) mkdirSync(dir, { recursive: true })
  /* lib/ is also what the stub curl serves as the raw scripts */
  copyFileSync(SCRIPT, path.join(lib, 'install.sh'))
  copyFileSync(path.join(SCRIPTS, 'install-local.sh'), path.join(lib, 'install-local.sh'))
  writeFileSync(
    path.join(lib, 'install-desktop.sh'),
    `echo "desktop $*" >> "$STUB_DIR/calls.log"
case "$*" in
  *--uninstall*) rm -rf "$DOOP_DESKTOP_SYSTEM_APPS/Diazo.app" ;;
  *) mkdir -p "$DOOP_DESKTOP_SYSTEM_APPS/Diazo.app/Contents" ;;
esac
`,
  )
  stub('uname', 'case $1 in -s) echo "${STUB_OS:-Darwin}" ;; -m) echo "${STUB_ARCH:-arm64}" ;; esac')
  stub('sw_vers', 'echo "${STUB_MACOS:-26.1}"')
  stub(
    'curl',
    `out=; url=
while [ $# -gt 0 ]; do
  case $1 in -o) out=$2; shift ;; --proto|--retry|--max-time) shift ;; -*) ;; *) url=$1 ;; esac
  shift
done
case $url in
  ${RAW}/*) echo "curl $url" >> "$STUB_DIR/calls.log"; cp "$STUB_DIR/lib/\${url#${RAW}/}" "$out" ;;
  */healthz) [ -z "$STUB_DOWN" ] ;;
  *) exit 22 ;;
esac`,
  )
  stub(
    'container',
    `[ "$1" = --version ] && { echo "container CLI version \${STUB_CONTAINER:-1.0.0} (build: release)"; exit 0; }
echo "$*" >> "$STUB_DIR/calls.log"
case "$1 $2" in
  "system status") exit 0 ;;
  "image pull") exit 0 ;;
  "inspect doop") exit 1 ;;
  inspect*) [ -f "$STUB_DIR/exists" ] ;;
  run*) touch "$STUB_DIR/exists" ;;
  "delete --force") rm -f "$STUB_DIR/exists" ;;
esac`,
  )
  stub('launchctl', 'echo "launchctl $*" >> "$STUB_DIR/calls.log"')
  stub('open', 'echo "open $*" >> "$STUB_DIR/calls.log"')
  stub('osascript', 'echo "osascript $*" >> "$STUB_DIR/calls.log"')
  stub('sleep', 'exit 0')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/* script-driven tests: each run() spawns a fresh sh; a loaded machine
   pushes whole-test time past the 5s default */
describe('install.sh', { timeout: 30_000 }, () => {
  it('prints help and rejects what it does not know, touching nothing', async () => {
    const help = await run(['--help'])
    expect(help.code).toBe(0)
    expect(help.out).toMatch(/--app-only/)
    expect((await run(['--nope'])).code).not.toBe(0)
    expect((await run(['--app-only', '--server-only'])).out).toMatch(/nothing to install/)
    expect((await run(['--purge'])).out).toMatch(/--purge goes with --uninstall/)
    expect(calls()).toBe('')
    expect(existsSync(diazoHome())).toBe(false)
  })

  it('installs the server, the LaunchAgent, the app and the command, and opens the app', async () => {
    const { code, out } = await run([])
    expect(code, out).toBe(0)

    /* the server, by install-local.sh, on loopback, trusting the app's origin */
    const runLine = calls()
      .split('\n')
      .find((line) => line.startsWith('run ')) as string
    expect(runLine).toContain('--publish 127.0.0.1:4400:4400')
    expect(runLine).toContain('--env TRUSTED_ORIGINS=http://127.0.0.1:4400')
    expect(existsSync(path.join(diazoHome(), 'diazo.env'))).toBe(true)
    expect(out).toMatch(/starts again at login/)

    /* the LaunchAgent, loaded in the person's GUI domain */
    const agent = readFileSync(plist(), 'utf8')
    expect(agent).toContain('<string>dev.bryann2k.diazo.server</string>')
    expect(agent).toContain(`<string>${diazoHome()}/bin/diazo</string>`)
    expect(agent).toContain('<string>autostart</string>')
    expect(agent).toContain(`${home}/Library/Logs/Diazo/server.log`)
    expect(agent).toContain('<key>RunAtLoad</key>')
    expect(existsSync(path.join(home, 'Library', 'Logs', 'Diazo'))).toBe(true)
    const uid = spawnSync('id', ['-u']).stdout.toString().trim()
    expect(calls()).toContain(`launchctl bootout gui/${uid}/dev.bryann2k.diazo.server`)
    expect(calls()).toContain(`launchctl bootstrap gui/${uid} ${plist()}`)

    /* the app, set to open this Mac's server, then opened */
    expect(calls()).toMatch(/^desktop $/m)
    expect(JSON.parse(readFileSync(serverJson(), 'utf8'))).toEqual({ url: 'http://127.0.0.1:4400' })
    expect(calls()).toMatch(/^open -b dev\.bryann2k\.diazo$/m)
    expect(out).toMatch(/first one on this server is its admin/)

    /* the command and its scripts, linked onto the PATH */
    expect(readFileSync(path.join(diazoHome(), 'bin', 'diazo'), 'utf8')).toBe(readFileSync(SCRIPT, 'utf8'))
    expect(existsSync(path.join(diazoHome(), 'lib', 'install-local.sh'))).toBe(true)
    expect(existsSync(path.join(diazoHome(), 'lib', 'install-desktop.sh'))).toBe(true)
    expect(lstatSync(path.join(links, 'diazo')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path.join(links, 'diazo'))).toBe(path.join(diazoHome(), 'bin', 'diazo'))
    expect(out).toMatch(/add .*\.local\/bin to your PATH/)
    expect(readFileSync(path.join(diazoHome(), 'install.conf'), 'utf8')).toBe('server=1\napp=1\n')
  })

  it('updates both on a re-run, keeping the secrets and the server choice', async () => {
    expect((await run([])).code).toBe(0)
    const secrets = readFileSync(path.join(diazoHome(), 'diazo.env'), 'utf8')
    clearCalls()
    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(calls()).toMatch(/^delete --force diazo$/m)
    expect(calls()).toMatch(/^run /m)
    expect(calls()).toMatch(/^desktop $/m)
    expect(calls()).toMatch(/launchctl bootstrap/)
    expect(out).toMatch(/already opens this Mac's server/)
    expect(readFileSync(path.join(diazoHome(), 'diazo.env'), 'utf8')).toBe(secrets)
  })

  it('respects another server already chosen, unless --use-local', async () => {
    mkdirSync(appData(), { recursive: true })
    writeFileSync(serverJson(), '{"url":"https://diazo.example.com"}')
    const kept = await run([])
    expect(kept.code, kept.out).toBe(0)
    expect(kept.out).toMatch(/keeps the server it was set to \(https:\/\/diazo\.example\.com\)/)
    expect(readFileSync(serverJson(), 'utf8')).toContain('diazo.example.com')

    const switched = await run(['--use-local'])
    expect(switched.code, switched.out).toBe(0)
    expect(JSON.parse(readFileSync(serverJson(), 'utf8'))).toEqual({ url: 'http://127.0.0.1:4400' })
  })

  it('counts the pre-rename app’s choice while Diazo has not copied it over', async () => {
    const old = path.join(home, 'Library', 'Application Support', 'design.doop.desktop')
    mkdirSync(old, { recursive: true })
    writeFileSync(path.join(old, 'server.json'), '{"url":"https://redoop.example.com"}')
    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(out).toMatch(/keeps the server it was set to \(https:\/\/redoop\.example\.com\)/)
    /* the new folder stays empty, so the app's first launch still migrates */
    expect(existsSync(appData())).toBe(false)
    expect(readFileSync(path.join(old, 'server.json'), 'utf8')).toContain('redoop')
  })

  it('installs the app alone with --app-only, on any Mac', async () => {
    const { code, out } = await run(['--app-only'], { STUB_ARCH: 'x86_64', STUB_MACOS: '15.4' })
    expect(code, out).toBe(0)
    expect(calls()).toMatch(/^desktop $/m)
    expect(calls()).not.toMatch(/^run /m)
    expect(calls()).not.toMatch(/launchctl/)
    expect(existsSync(plist())).toBe(false)
    expect(existsSync(serverJson())).toBe(false)
    expect(calls()).toMatch(/^open -b dev\.bryann2k\.diazo$/m)
    expect(readFileSync(path.join(diazoHome(), 'install.conf'), 'utf8')).toBe('server=0\napp=1\n')
  })

  it('installs the server alone with --server-only', async () => {
    const { code, out } = await run(['--server-only'])
    expect(code, out).toBe(0)
    expect(calls()).toMatch(/^run /m)
    expect(existsSync(plist())).toBe(true)
    expect(calls()).not.toMatch(/^desktop/m)
    expect(calls()).not.toMatch(/^open /m)
    expect(existsSync(serverJson())).toBe(false)
  })

  it('passes --version to the app installer', async () => {
    expect((await run(['--app-only', '--version', '0.16.0'])).code).toBe(0)
    expect(calls()).toMatch(/^desktop --version 0\.16\.0$/m)
  })

  it('says what the server needs and installs nothing when the Mac cannot run it', async () => {
    rmSync(path.join(bin, 'container'))
    const missing = await run([])
    expect(missing.code).not.toBe(0)
    expect(missing.out).toMatch(/github\.com\/apple\/container\/releases/)
    expect(missing.out).toMatch(/--app-only/)

    stub('container', 'echo "container CLI version 0.6.0 (build: release)"')
    expect((await run([])).out).toMatch(/container is 0\.6; the server needs 1\.0 or later/)
    expect((await run([], { STUB_MACOS: '15.5' })).out).toMatch(/needs macOS 26 or later/)
    expect((await run([], { STUB_ARCH: 'x86_64' })).out).toMatch(/Apple silicon only/)
    expect((await run([], { STUB_OS: 'Linux' })).out).toMatch(/for macOS/)
    expect(calls()).toBe('')
    expect(existsSync(diazoHome())).toBe(false)
  })

  it('prints the steps and changes nothing with --dry-run', async () => {
    const { code, out } = await run(['--dry-run'])
    expect(code, out).toBe(0)
    expect(out).toMatch(/\[dry run\]/)
    expect(out).toMatch(/dev\.bryann2k\.diazo\.server\.plist/)
    expect(out).toMatch(/set the app's server to http:\/\/127\.0\.0\.1:4400/)
    expect(calls()).toBe('')
    expect(existsSync(diazoHome())).toBe(false)
    expect(existsSync(plist())).toBe(false)
  })

  it('downloads its two installers when piped into sh', async () => {
    const { code, out } = await runPiped(['--server-only'], { DIAZO_LIB: '' })
    expect(code, out).toBe(0)
    expect(calls()).toContain(`curl ${RAW}/install-local.sh`)
    expect(calls()).toContain(`curl ${RAW}/install-desktop.sh`)
    expect(calls()).toContain(`curl ${RAW}/install.sh`)
    expect(readFileSync(path.join(diazoHome(), 'bin', 'diazo'), 'utf8')).toBe(readFileSync(SCRIPT, 'utf8'))
  })

  it('keeps a pre-rename ~/.doop where it is', async () => {
    const old = path.join(home, '.doop')
    mkdirSync(path.join(old, 'data'), { recursive: true })
    writeFileSync(path.join(old, 'doop.env'), 'BETTER_AUTH_SECRET=old\nSECRETS_ENCRYPTION_KEYS=local:old\n', {
      mode: 0o600,
    })
    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(existsSync(diazoHome())).toBe(false)
    expect(calls()).toContain(`--volume ${old}/data:/app/data`)
    expect(readFileSync(plist(), 'utf8')).toContain(`<string>${old}/bin/diazo</string>`)
    expect(existsSync(path.join(old, 'bin', 'diazo'))).toBe(true)
  })

  it('uninstalls everything but the data, and everything with --purge', async () => {
    expect((await run([])).code).toBe(0)
    clearCalls()
    const kept = await run(['--uninstall'])
    expect(kept.code, kept.out).toBe(0)
    expect(calls()).toMatch(/launchctl bootout/)
    expect(existsSync(plist())).toBe(false)
    expect(calls()).toMatch(/^delete --force diazo$/m)
    expect(calls()).toMatch(/^desktop --uninstall$/m)
    expect(existsSync(path.join(apps, 'Diazo.app'))).toBe(false)
    expect(existsSync(path.join(links, 'diazo'))).toBe(false)
    expect(existsSync(path.join(diazoHome(), 'bin', 'diazo'))).toBe(false)
    expect(existsSync(path.join(diazoHome(), 'diazo.env'))).toBe(true)
    expect(existsSync(serverJson())).toBe(true)

    expect((await run([])).code).toBe(0)
    const purged = await run(['--uninstall', '--purge'])
    expect(purged.code, purged.out).toBe(0)
    expect(existsSync(diazoHome())).toBe(false)
    expect(existsSync(appData())).toBe(false)
    expect(existsSync(path.join(home, 'Library', 'Logs', 'Diazo'))).toBe(false)
  })
})

describe('the diazo command', { timeout: 30_000 }, () => {
  const command = () => path.join(diazoHome(), 'bin', 'diazo')
  /* the installed copy, using the scripts it installed beside it */
  const diazo = (args: string[], env: Record<string, string> = {}) => run(args, { DIAZO_LIB: '', ...env }, command())

  beforeEach(async () => {
    const { code, out } = await run([])
    expect(code, out).toBe(0)
    clearCalls()
  })

  it('does nothing unasked', async () => {
    const { code, out } = await diazo([])
    expect(code).toBe(0)
    expect(out).toMatch(/Commands/)
    expect(calls()).toBe('')
  })

  it('starts, stops and restarts the container', async () => {
    expect((await diazo(['stop'])).code).toBe(0)
    expect(calls()).toMatch(/^stop diazo$/m)
    clearCalls()
    const started = await diazo(['start'])
    expect(started.code, started.out).toBe(0)
    expect(calls()).toMatch(/^start diazo$/m)
    expect(started.out).toMatch(/starts again at login/)
    clearCalls()
    expect((await diazo(['restart'])).code).toBe(0)
    expect(calls()).toMatch(/^stop diazo\n(.*\n)*start diazo$/m)
  })

  it('reports the server, the LaunchAgent and the app', async () => {
    const { code, out } = await diazo(['status'])
    expect(code, out).toBe(0)
    expect(out).toMatch(/answering on http:\/\/localhost:4400/)
    expect(out).toMatch(/starts at login/)
    expect(out).toMatch(/Diazo\.app is installed, set to http:\/\/127\.0\.0\.1:4400/)
    expect(calls()).toMatch(/launchctl print gui\/\d+\/dev\.bryann2k\.diazo\.server/)
  })

  it('opens the app, or the server in a browser without it', async () => {
    expect((await diazo(['open'])).code).toBe(0)
    expect(calls()).toMatch(/^open -b dev\.bryann2k\.diazo$/m)
    rmSync(path.join(apps, 'Diazo.app'), { recursive: true })
    clearCalls()
    expect((await diazo(['open'])).code).toBe(0)
    expect(calls()).toMatch(/^open http:\/\/localhost:4400$/m)
  })

  it('starts the server at login only when it is not answering', async () => {
    const up = await diazo(['autostart'])
    expect(up.code, up.out).toBe(0)
    expect(up.out).toMatch(/already answering/)
    expect(calls()).not.toMatch(/^start diazo$/m)

    await diazo(['autostart'], { STUB_DOWN: '1' })
    expect(calls()).toMatch(/^start diazo$/m)
  })

  it('updates with freshly downloaded scripts, keeping what this Mac has', async () => {
    const { code, out } = await diazo(['update'])
    expect(code, out).toBe(0)
    for (const script of ['install.sh', 'install-local.sh', 'install-desktop.sh']) {
      expect(calls()).toContain(`curl ${RAW}/${script}`)
    }
    expect(calls()).toMatch(/^run /m)
    expect(calls()).toMatch(/^desktop $/m)
    expect(calls()).not.toMatch(/^open /m)
    expect(readFileSync(command(), 'utf8')).toBe(readFileSync(SCRIPT, 'utf8'))
  })

  it('updates the app alone after an --app-only install, and refuses server commands', async () => {
    expect((await run(['--uninstall', '--purge'])).code).toBe(0)
    expect((await run(['--app-only'])).code).toBe(0)
    clearCalls()
    expect((await diazo(['update'])).code).toBe(0)
    expect(calls()).toMatch(/^desktop $/m)
    expect(calls()).not.toMatch(/^run /m)
    const start = await diazo(['start'])
    expect(start.code).not.toBe(0)
    expect(start.out).toMatch(/no Diazo server \(installed with --app-only\)/)
  })

  it('keeps diazo-local and doop-local working', async () => {
    const local = path.join(diazoHome(), 'bin', 'diazo-local')
    expect(existsSync(local)).toBe(true)
    expect(readlinkSync(path.join(diazoHome(), 'bin', 'doop-local'))).toBe('diazo-local')
    expect((await run(['stop'], {}, local)).code).toBe(0)
    expect(calls()).toMatch(/^stop diazo$/m)
  })

  it('uninstalls with --purge', async () => {
    expect((await diazo(['uninstall', '--purge'])).code).toBe(0)
    expect(existsSync(diazoHome())).toBe(false)
    expect(existsSync(plist())).toBe(false)
  })
})
