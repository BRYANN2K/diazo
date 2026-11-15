import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/* scripts/install-desktop.sh against stub `uname`, `curl`, `pgrep`,
   `osascript`, `xattr`, `open` and `minisign` on PATH: nothing is downloaded
   and no app is launched. The stub `curl` serves files from serve/, keyed by
   the URL's path below releases/download/, and every stub logs to calls.log. */

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'install-desktop.sh')
const RELEASES = 'https://github.com/BRYANN2K/redoop/releases/download'
const CONF = path.resolve(import.meta.dirname, '..', 'desktop', 'src-tauri', 'tauri.conf.json')
const PUBKEY = (JSON.parse(readFileSync(CONF, 'utf8')) as { plugins: { updater: { pubkey: string } } }).plugins.updater
  .pubkey

let root: string
let home: string
let bin: string
let serve: string
let apps: string

function stub(name: string, body: string) {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const child = spawn('sh', [SCRIPT, ...args], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: root,
      STUB_DIR: root,
      DOOP_DESKTOP_SYSTEM_APPS: apps,
      DOOP_DESKTOP_QUIT_TIMEOUT: '2',
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

const plist = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key>
\t<string>design.doop.desktop</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${version}</string>
</dict>
</plist>
`

/* a doop.app whose binary carries `key` (the updater pubkey it trusts) */
function writeApp(dir: string, version: string, key = PUBKEY) {
  mkdirSync(path.join(dir, 'doop.app', 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(path.join(dir, 'doop.app', 'Contents', 'Info.plist'), plist(version))
  writeFileSync(path.join(dir, 'doop.app', 'Contents', 'MacOS', 'doop-desktop'), `binary ${key} ${version}\n`)
}

/* publishes desktop-v<version> in serve/, and names it in the feed when `latest` */
function publish(version: string, { latest = true, corrupt = false } = {}) {
  const build = mkdtempSync(path.join(root, 'build-'))
  writeApp(build, version)
  const asset = `doop_${version}_universal.app.tar.gz`
  const release = path.join(serve, `desktop-v${version}`)
  mkdirSync(release, { recursive: true })
  spawnSync('tar', ['-czf', path.join(release, asset), '-C', build, 'doop.app'])
  const sum = createHash('sha256')
    .update(readFileSync(path.join(release, asset)))
    .digest('hex')
  writeFileSync(path.join(release, 'SHA256SUMS'), `${corrupt ? '0'.repeat(64) : sum}  ${asset}\n`)
  writeFileSync(path.join(release, `${asset}.sig`), Buffer.from('signature').toString('base64'))
  if (latest) {
    mkdirSync(path.join(serve, 'desktop-updates'), { recursive: true })
    writeFileSync(
      path.join(serve, 'desktop-updates', 'latest.json'),
      JSON.stringify({ version, platforms: { 'darwin-aarch64': { url: 'x', signature: 'y' } } }, null, 2),
    )
  }
}

const installed = (dir = apps) => {
  const file = path.join(dir, 'doop.app', 'Contents', 'Info.plist')
  return existsSync(file) ? (/<string>(\d[^<]*)<\/string>\s*<\/dict>/.exec(readFileSync(file, 'utf8'))?.[1] ?? '') : ''
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'doop-desktop-install-'))
  home = path.join(root, 'home')
  bin = path.join(root, 'bin')
  serve = path.join(root, 'serve')
  apps = path.join(root, 'Applications')
  for (const dir of [home, bin, serve, apps]) mkdirSync(dir, { recursive: true })
  stub('uname', 'case $1 in -s) echo "${STUB_OS:-Darwin}" ;; -m) echo "${STUB_ARCH:-arm64}" ;; esac')
  stub(
    'curl',
    `out=; url=
while [ $# -gt 0 ]; do
  case $1 in -o) out=$2; shift ;; --proto|--retry) shift ;; -*) ;; *) url=$1 ;; esac
  shift
done
echo "curl $url" >> "$STUB_DIR/calls.log"
file="$STUB_DIR/serve/\${url#${RELEASES}/}"
[ -f "$file" ] || exit 22
cp "$file" "$out"`,
  )
  stub('pgrep', '[ -f "$STUB_DIR/running" ]')
  stub('osascript', 'echo "osascript $*" >> "$STUB_DIR/calls.log"; [ -n "$STUB_STUCK" ] || rm -f "$STUB_DIR/running"')
  stub('xattr', 'echo "xattr $*" >> "$STUB_DIR/calls.log"')
  stub('open', 'echo "open $*" >> "$STUB_DIR/calls.log"')
  stub('sleep', 'exit 0')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('install-desktop.sh', () => {
  it('rejects an unknown argument and a malformed version', async () => {
    expect((await run(['--nope'])).code).not.toBe(0)
    const bad = await run(['--version', '../../evil'])
    expect(bad.code).not.toBe(0)
    expect(bad.out).toMatch(/not a release version/)
    expect(calls()).toBe('')
  })

  it('prints help without touching anything', async () => {
    const { code, out } = await run(['--help'])
    expect(code).toBe(0)
    expect(out).toMatch(/--uninstall/)
    expect(calls()).toBe('')
  })

  it('refuses anything but macOS', async () => {
    const { code, out } = await run([], { STUB_OS: 'Linux' })
    expect(code).not.toBe(0)
    expect(out).toMatch(/for macOS/)
    expect(calls()).toBe('')
  })

  it('installs the latest release from the feed, checked, and unquarantined', async () => {
    publish('0.14.0')
    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(installed()).toBe('0.14.0')
    expect(calls()).toContain(`curl ${RELEASES}/desktop-updates/latest.json`)
    expect(calls()).toContain(`curl ${RELEASES}/desktop-v0.14.0/doop_0.14.0_universal.app.tar.gz`)
    expect(out).toMatch(/checksum verified/)
    expect(calls()).toMatch(/^xattr -dr com\.apple\.quarantine .*doop\.app$/m)
    expect(out).toMatch(/click the cog/)
    /* nothing left behind next to the app */
    expect(spawnSync('ls', ['-A', apps]).stdout.toString().trim()).toBe('doop.app')
  })

  it('installs into ~/Applications when /Applications is not writable', async () => {
    publish('0.14.0')
    chmodSync(apps, 0o555)
    try {
      expect((await run([])).code).toBe(0)
      expect(installed(path.join(home, 'Applications'))).toBe('0.14.0')
      expect(installed()).toBe('')
    } finally {
      chmodSync(apps, 0o755)
    }
  })

  it('installs a pinned version, and refuses a tampered package', async () => {
    publish('0.14.0', { latest: false })
    expect((await run(['--version', 'desktop-v0.14.0'])).code).toBe(0)
    expect(installed()).toBe('0.14.0')
    expect(calls()).not.toContain('latest.json')

    publish('0.15.0', { latest: false, corrupt: true })
    const { code, out } = await run(['--version=0.15.0'])
    expect(code).not.toBe(0)
    expect(out).toMatch(/checksum mismatch/)
    expect(installed()).toBe('0.14.0')
  })

  it('says so when the release does not exist', async () => {
    const { code, out } = await run(['--version', '9.9.9'])
    expect(code).not.toBe(0)
    expect(out).toMatch(/could not download/)
  })

  it('is idempotent, but replaces a shell installed from doop.design', async () => {
    publish('0.14.0')
    expect((await run([])).code).toBe(0)
    writeFileSync(path.join(root, 'calls.log'), '')
    const again = await run([])
    expect(again.out).toMatch(/already installed/)
    expect(calls()).not.toContain('.tar.gz')

    /* the same version number, but upstream's key: replaced */
    rmSync(path.join(apps, 'doop.app'), { recursive: true })
    writeApp(apps, '0.14.0', 'upstream-key')
    expect((await run([])).out).toMatch(/replacing doop 0\.14\.0/)
    expect(readFileSync(path.join(apps, 'doop.app', 'Contents', 'MacOS', 'doop-desktop'), 'utf8')).toContain(PUBKEY)
  })

  it('quits a running app, keeps its data, and opens it again', async () => {
    publish('0.14.0')
    writeApp(apps, '0.13.0', 'upstream-key')
    const data = path.join(home, 'Library', 'Application Support', 'design.doop.desktop')
    mkdirSync(data, { recursive: true })
    writeFileSync(path.join(data, 'server.json'), '{"origin":"https://doop.example"}')
    writeFileSync(path.join(root, 'running'), '')

    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(calls()).toMatch(/^osascript -e quit app id "design\.doop\.desktop"$/m)
    expect(calls()).toMatch(/^open .*doop\.app$/m)
    expect(installed()).toBe('0.14.0')
    expect(readFileSync(path.join(data, 'server.json'), 'utf8')).toContain('doop.example')
  })

  it('gives up, leaving the old app, when doop will not quit', async () => {
    publish('0.14.0')
    writeApp(apps, '0.13.0', 'upstream-key')
    writeFileSync(path.join(root, 'running'), '')
    const { code, out } = await run([], { STUB_STUCK: '1' })
    expect(code).not.toBe(0)
    expect(out).toMatch(/still running/)
    expect(installed()).toBe('0.13.0')
  })

  it('checks the release signature with minisign when it is installed', async () => {
    publish('0.14.0')
    stub('minisign', 'echo "minisign $*" >> "$STUB_DIR/calls.log"; [ -z "$STUB_BAD_SIG" ]')
    expect((await run([])).out).toMatch(/signature verified/)
    expect(calls()).toContain(`curl ${RELEASES}/desktop-v0.14.0/doop_0.14.0_universal.app.tar.gz.sig`)
    expect(calls()).toMatch(/^minisign -V -q -p .*doop\.pub -x .*\.minisig -m .*\.app\.tar\.gz$/m)

    rmSync(path.join(apps, 'doop.app'), { recursive: true })
    const { code, out } = await run([], { STUB_BAD_SIG: '1' })
    expect(code).not.toBe(0)
    expect(out).toMatch(/does not verify/)
    expect(installed()).toBe('')
  })

  it('uninstalls the app and keeps the data', async () => {
    writeApp(apps, '0.14.0')
    writeApp(path.join(home, 'Applications'), '0.14.0')
    const data = path.join(home, 'Library', 'Application Support', 'design.doop.desktop')
    mkdirSync(data, { recursive: true })
    const { code, out } = await run(['--uninstall'])
    expect(code, out).toBe(0)
    expect(existsSync(path.join(apps, 'doop.app'))).toBe(false)
    expect(existsSync(path.join(home, 'Applications', 'doop.app'))).toBe(false)
    expect(existsSync(data)).toBe(true)
    expect(out).toMatch(/kept/)
  })
})
