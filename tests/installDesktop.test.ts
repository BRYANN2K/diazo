import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubPath } from './stubPath'

/* scripts/install-desktop.sh against stub `uname`, `curl`, `pgrep`,
   `osascript`, `xattr`, `open`, `minisign`, `sudo` and the package commands
   (`apt`, `dpkg`, `dnf`, `zypper`, `rpm`) on PATH: nothing is downloaded and
   no app is launched. The stub `curl` serves files from serve/, keyed by the
   URL's path below releases/download/, and every stub logs to calls.log.
   PATH holds only the stub dir and symlinks to basic tools (stubPath): a
   runner's own package tools can never answer where a test removed the
   stub. */

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'install-desktop.sh')

/* real installer runs: a machine with slow exec needs more than the 5s default */
vi.setConfig({ testTimeout: 60000 })
const RELEASES = 'https://github.com/BRYANN2K/diazo/releases/download'
const CONF = path.resolve(import.meta.dirname, '..', 'desktop', 'src-tauri', 'tauri.conf.json')
const PUBKEY = (JSON.parse(readFileSync(CONF, 'utf8')) as { plugins: { updater: { pubkey: string } } }).plugins.updater
  .pubkey

let root: string
let home: string
let bin: string
let serve: string
let apps: string
let testPath: string

function stub(name: string, body: string) {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  const child = spawn('sh', [SCRIPT, ...args], {
    env: {
      PATH: testPath,
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

const DIAZO = { app: 'Diazo.app', id: 'dev.bryann2k.diazo' }
/* the pre-rename redoop shell, and the official doop app: same name and id */
const DOOP = { app: 'doop.app', id: 'design.doop.desktop' }

const plist = (version: string, id: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key>
\t<string>${id}</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${version}</string>
</dict>
</plist>
`

/* an app bundle whose binary carries `key` (the updater pubkey it trusts) */
function writeApp(dir: string, version: string, key = PUBKEY, kind = DIAZO) {
  mkdirSync(path.join(dir, kind.app, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(path.join(dir, kind.app, 'Contents', 'Info.plist'), plist(version, kind.id))
  writeFileSync(path.join(dir, kind.app, 'Contents', 'MacOS', 'doop-desktop'), `binary ${key} ${version}\n`)
}

/* publishes desktop-v<version> in serve/ (the macOS tarball really packed,
   the Linux packages as stand-ins), and names it in the feed when `latest` */
function publish(version: string, { latest = true, corrupt = false } = {}) {
  const build = mkdtempSync(path.join(root, 'build-'))
  writeApp(build, version)
  const release = path.join(serve, `desktop-v${version}`)
  mkdirSync(release, { recursive: true })
  const tarball = `Diazo_${version}_universal.app.tar.gz`
  spawnSync('tar', ['-czf', path.join(release, tarball), '-C', build, 'Diazo.app'])
  const assets = [
    tarball,
    `Diazo_${version}_amd64.deb`,
    `Diazo-${version}-1.x86_64.rpm`,
    `Diazo_${version}_amd64.AppImage`,
    `Diazo_${version}_x64-setup.exe`,
  ]
  let sums = ''
  for (const asset of assets) {
    const file = path.join(release, asset)
    if (!existsSync(file)) writeFileSync(file, `fake ${asset}\n`)
    const sum = createHash('sha256').update(readFileSync(file)).digest('hex')
    sums += `${corrupt ? '0'.repeat(64) : sum}  ${asset}\n`
    writeFileSync(`${file}.sig`, Buffer.from('signature').toString('base64'))
  }
  writeFileSync(path.join(release, 'SHA256SUMS'), sums)
  if (latest) {
    mkdirSync(path.join(serve, 'desktop-updates'), { recursive: true })
    writeFileSync(
      path.join(serve, 'desktop-updates', 'latest.json'),
      JSON.stringify({ version, platforms: { 'darwin-aarch64': { url: 'x', signature: 'y' } } }, null, 2),
    )
  }
}

const installed = (dir = apps, app = DIAZO.app) => {
  const file = path.join(dir, app, 'Contents', 'Info.plist')
  return existsSync(file) ? (/<string>(\d[^<]*)<\/string>\s*<\/dict>/.exec(readFileSync(file, 'utf8'))?.[1] ?? '') : ''
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'diazo-desktop-install-'))
  home = path.join(root, 'home')
  bin = path.join(root, 'bin')
  serve = path.join(root, 'serve')
  apps = path.join(root, 'Applications')
  for (const dir of [home, bin, serve, apps]) mkdirSync(dir, { recursive: true })
  testPath = stubPath(bin)
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
  /* "running" is a running Diazo.app, "running-doop" a running doop.app */
  stub('pgrep', 'case "$*" in *doop.app*) [ -f "$STUB_DIR/running-doop" ] ;; *) [ -f "$STUB_DIR/running" ] ;; esac')
  stub('osascript', 'echo "osascript $*" >> "$STUB_DIR/calls.log"; [ -n "$STUB_STUCK" ] || rm -f "$STUB_DIR/running"')
  stub('xattr', 'echo "xattr $*" >> "$STUB_DIR/calls.log"')
  stub('open', 'echo "open $*" >> "$STUB_DIR/calls.log"')
  stub('sleep', 'exit 0')
  /* the Linux side: sudo runs the command, the package tools only log; a
     deb or rpm marked installed lives in $STUB_DIR/deb|rpm-version */
  stub('sudo', 'exec "$@"')
  for (const tool of ['apt', 'dnf', 'zypper', 'pkill', 'gtk-launch', 'update-desktop-database']) {
    stub(tool, `echo "${tool} $*" >> "$STUB_DIR/calls.log"`)
  }
  stub(
    'dpkg',
    `echo "dpkg $*" >> "$STUB_DIR/calls.log"
case "$1" in
  -s) [ -f "$STUB_DIR/deb-version" ] ;;
  -i) echo "0.15.0" > "$STUB_DIR/deb-version" ;;
  -r) rm -f "$STUB_DIR/deb-version" ;;
esac`,
  )
  stub(
    'dpkg-query',
    `echo "dpkg-query $*" >> "$STUB_DIR/calls.log"
[ -f "$STUB_DIR/deb-version" ] && cat "$STUB_DIR/deb-version"`,
  )
  stub(
    'rpm',
    `echo "rpm $*" >> "$STUB_DIR/calls.log"
case "$1" in
  -q) [ -f "$STUB_DIR/rpm-version" ] && cat "$STUB_DIR/rpm-version" ;;
  -i | -U) echo "0.15.0" > "$STUB_DIR/rpm-version" ;;
  -e) rm -f "$STUB_DIR/rpm-version" ;;
esac`,
  )
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/* script-driven tests: each run() spawns a fresh sh; a loaded machine
   pushes whole-test time past the 5s default */
describe('install-desktop.sh', { timeout: 30_000 }, () => {
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

  it('refuses a system it does not know, and prints the PowerShell line on Windows', async () => {
    const { code, out } = await run([], { STUB_OS: 'FreeBSD' })
    expect(code).not.toBe(0)
    expect(out).toMatch(/unsupported system/)
    const windows = await run([], { STUB_OS: 'MINGW64_NT-10.0' })
    expect(windows.code).not.toBe(0)
    expect(windows.out).toMatch(/install-desktop\.ps1 \| iex/)
    expect(calls()).toBe('')
  })

  it('installs the latest release from the feed, checked, and unquarantined', async () => {
    publish('0.15.0')
    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(installed()).toBe('0.15.0')
    expect(calls()).toContain(`curl ${RELEASES}/desktop-updates/latest.json`)
    expect(calls()).toContain(`curl ${RELEASES}/desktop-v0.15.0/Diazo_0.15.0_universal.app.tar.gz`)
    expect(out).toMatch(/checksum verified/)
    expect(calls()).toMatch(/^xattr -dr com\.apple\.quarantine .*Diazo\.app$/m)
    expect(out).toMatch(/click the cog/)
    /* nothing left behind next to the app */
    expect(spawnSync('ls', ['-A', apps]).stdout.toString().trim()).toBe('Diazo.app')
  })

  it('installs into ~/Applications when /Applications is not writable', async () => {
    publish('0.15.0')
    chmodSync(apps, 0o555)
    try {
      expect((await run([])).code).toBe(0)
      expect(installed(path.join(home, 'Applications'))).toBe('0.15.0')
      expect(installed()).toBe('')
    } finally {
      chmodSync(apps, 0o755)
    }
  })

  it('installs a pinned version, and refuses a tampered package', async () => {
    publish('0.15.0', { latest: false })
    expect((await run(['--version', 'desktop-v0.15.0'])).code).toBe(0)
    expect(installed()).toBe('0.15.0')
    expect(calls()).not.toContain('latest.json')

    publish('0.16.0', { latest: false, corrupt: true })
    const { code, out } = await run(['--version=0.16.0'])
    expect(code).not.toBe(0)
    expect(out).toMatch(/checksum mismatch/)
    expect(installed()).toBe('0.15.0')
  })

  it('says so when the release does not exist', async () => {
    const { code, out } = await run(['--version', '9.9.9'])
    expect(code).not.toBe(0)
    expect(out).toMatch(/could not download/)
  })

  it('is idempotent, but reinstalls a Diazo.app that does not carry our key', async () => {
    publish('0.15.0')
    expect((await run([])).code).toBe(0)
    writeFileSync(path.join(root, 'calls.log'), '')
    const again = await run([])
    expect(again.out).toMatch(/already installed/)
    expect(calls()).not.toContain('.tar.gz')

    /* the same version number, but another key: replaced */
    rmSync(path.join(apps, 'Diazo.app'), { recursive: true })
    writeApp(apps, '0.15.0', 'other-key')
    expect((await run([])).out).toMatch(/replacing Diazo 0\.15\.0/)
    expect(readFileSync(path.join(apps, 'Diazo.app', 'Contents', 'MacOS', 'doop-desktop'), 'utf8')).toContain(PUBKEY)
  })

  it('quits a running app, keeps its data, and opens it again', async () => {
    publish('0.15.0')
    writeApp(apps, '0.14.9', 'other-key')
    const data = path.join(home, 'Library', 'Application Support', 'dev.bryann2k.diazo')
    mkdirSync(data, { recursive: true })
    writeFileSync(path.join(data, 'server.json'), '{"origin":"https://diazo.example"}')
    writeFileSync(path.join(root, 'running'), '')

    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(calls()).toMatch(/^osascript -e quit app id "dev\.bryann2k\.diazo"$/m)
    expect(calls()).toMatch(/^open .*Diazo\.app$/m)
    expect(installed()).toBe('0.15.0')
    expect(readFileSync(path.join(data, 'server.json'), 'utf8')).toContain('diazo.example')
  })

  it('gives up, leaving the old app, when Diazo will not quit', async () => {
    publish('0.15.0')
    writeApp(apps, '0.14.9', 'other-key')
    writeFileSync(path.join(root, 'running'), '')
    const { code, out } = await run([], { STUB_STUCK: '1' })
    expect(code).not.toBe(0)
    expect(out).toMatch(/still running/)
    expect(installed()).toBe('0.14.9')
  })

  it('checks the release signature with minisign when it is installed', async () => {
    publish('0.15.0')
    stub('minisign', 'echo "minisign $*" >> "$STUB_DIR/calls.log"; [ -z "$STUB_BAD_SIG" ]')
    expect((await run([])).out).toMatch(/signature verified/)
    expect(calls()).toContain(`curl ${RELEASES}/desktop-v0.15.0/Diazo_0.15.0_universal.app.tar.gz.sig`)
    expect(calls()).toMatch(/^minisign -V -q -p .*diazo\.pub -x .*\.minisig -m .*\.app\.tar\.gz$/m)

    rmSync(path.join(apps, 'Diazo.app'), { recursive: true })
    const { code, out } = await run([], { STUB_BAD_SIG: '1' })
    expect(code).not.toBe(0)
    expect(out).toMatch(/does not verify/)
    expect(installed()).toBe('')
  })

  it('uninstalls the app and keeps the data', async () => {
    writeApp(apps, '0.15.0')
    writeApp(path.join(home, 'Applications'), '0.15.0')
    const data = path.join(home, 'Library', 'Application Support', 'dev.bryann2k.diazo')
    mkdirSync(data, { recursive: true })
    const { code, out } = await run(['--uninstall'])
    expect(code, out).toBe(0)
    expect(existsSync(path.join(apps, 'Diazo.app'))).toBe(false)
    expect(existsSync(path.join(home, 'Applications', 'Diazo.app'))).toBe(false)
    expect(existsSync(data)).toBe(true)
    expect(out).toMatch(/kept/)
  })

  it('replaces the redoop doop.app, which carries our key, and keeps its data', async () => {
    publish('0.15.0')
    writeApp(apps, '0.14.0', PUBKEY, DOOP)
    const old = path.join(home, 'Library', 'Application Support', 'design.doop.desktop')
    mkdirSync(old, { recursive: true })
    writeFileSync(path.join(old, 'server.json'), '{"origin":"https://doop.example"}')

    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(installed()).toBe('0.15.0')
    expect(existsSync(path.join(apps, 'doop.app'))).toBe(false)
    expect(out).toMatch(/removed the old redoop doop\.app/)
    /* the shell copies from it on its first launch: never deleted here */
    expect(readFileSync(path.join(old, 'server.json'), 'utf8')).toContain('doop.example')
    /* never asked to quit by bundle id: the official app shares it */
    expect(calls()).not.toContain('design.doop.desktop')
  })

  it('never touches the official doop app', async () => {
    publish('0.15.0')
    writeApp(apps, '0.20.0', 'upstream-key', DOOP)
    writeApp(path.join(home, 'Applications'), '0.20.0', 'upstream-key', DOOP)
    writeFileSync(path.join(root, 'running-doop'), '')

    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(installed()).toBe('0.15.0')
    expect(installed(apps, 'doop.app')).toBe('0.20.0')
    expect(installed(path.join(home, 'Applications'), 'doop.app')).toBe('0.20.0')
    expect(calls()).not.toContain('osascript')

    expect((await run(['--uninstall'])).code).toBe(0)
    expect(installed(apps, 'doop.app')).toBe('0.20.0')
    expect(installed(path.join(home, 'Applications'), 'doop.app')).toBe('0.20.0')
  })

  it('leaves a running redoop doop.app in place and says how to finish', async () => {
    publish('0.15.0')
    writeApp(apps, '0.14.0', PUBKEY, DOOP)
    writeFileSync(path.join(root, 'running-doop'), '')
    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(installed()).toBe('0.15.0')
    expect(installed(apps, 'doop.app')).toBe('0.14.0')
    expect(out).toMatch(/is running: quit it and run this again/)

    rmSync(path.join(root, 'running-doop'))
    expect((await run([])).out).toMatch(/already installed/)
    expect(existsSync(path.join(apps, 'doop.app'))).toBe(false)
  })
})

/* Linux x86_64: the .deb or .rpm of the distribution's family, the AppImage
   elsewhere or under --appimage; every asset checked against SHA256SUMS.
   Linux arm64 gets a clear refusal. */
describe('install-desktop.sh on Linux', () => {
  let osReleaseN = 0
  const osRelease = (text: string) => {
    const file = path.join(root, `os-release-${osReleaseN++}`)
    writeFileSync(file, text)
    return file
  }
  const runLinux = (args: string[] = [], env: Record<string, string> = {}) =>
    run(args, {
      STUB_OS: 'Linux',
      STUB_ARCH: 'x86_64',
      DOOP_OS_RELEASE: osRelease('ID=ubuntu\nID_LIKE=debian\n'),
      ...env,
    })
  const appimage = (version: string) => path.join(home, '.local', 'bin', `Diazo_${version}_amd64.AppImage`)
  const desktopFile = () => path.join(home, '.local', 'share', 'applications', 'doop-desktop-appimage.desktop')

  it('installs the .deb through apt on a Debian-family system', async () => {
    publish('0.15.0')
    const { code, out } = await runLinux()
    expect(code, out).toBe(0)
    expect(calls()).toContain(`curl ${RELEASES}/desktop-v0.15.0/Diazo_0.15.0_amd64.deb`)
    expect(calls()).toMatch(/apt install -y .*Diazo_0\.15\.0_amd64\.deb/)
    expect(calls()).not.toContain('_universal.app.tar.gz')
    expect(out).toMatch(/checksum verified/)
    expect(out).toMatch(/Diazo 0\.15\.0 is installed/)
  })

  it('installs the .rpm through dnf on a Fedora-family system', async () => {
    publish('0.15.0')
    const { code, out } = await runLinux([], { DOOP_OS_RELEASE: osRelease('ID=fedora\n') })
    expect(code, out).toBe(0)
    expect(calls()).toContain(`curl ${RELEASES}/desktop-v0.15.0/Diazo-0.15.0-1.x86_64.rpm`)
    expect(calls()).toMatch(/dnf install -y .*Diazo-0\.15\.0-1\.x86_64\.rpm/)
  })

  it('installs the unsigned local .rpm through zypper on a SUSE-family system', async () => {
    publish('0.15.0')
    rmSync(path.join(bin, 'dnf'))
    const { code, out } = await runLinux([], { DOOP_OS_RELEASE: osRelease('ID=opensuse-tumbleweed\nID_LIKE=suse\n') })
    expect(code, out).toBe(0)
    /* --allow-unsigned-rpm: the local file's checksum is already verified,
       and a signature prompt would abort --non-interactive */
    expect(calls()).toMatch(/zypper --non-interactive install --allow-unsigned-rpm .*Diazo-0\.15\.0-1\.x86_64\.rpm/)
    expect(calls()).not.toMatch(/dnf install|^rpm -U /m)
  })

  it('upgrades through rpm -U when neither dnf nor zypper is there', async () => {
    publish('0.15.0')
    rmSync(path.join(bin, 'dnf'))
    rmSync(path.join(bin, 'zypper'))
    /* an older diazo is already installed: -i would refuse, -U upgrades */
    writeFileSync(path.join(root, 'rpm-version'), '0.14.0')
    const { code, out } = await runLinux([], { DOOP_OS_RELEASE: osRelease('ID=fedora\n') })
    expect(code, out).toBe(0)
    expect(calls()).toMatch(/^rpm -U .*Diazo-0\.15\.0-1\.x86_64\.rpm/m)
    expect(calls()).not.toMatch(/^rpm -i /m)
  })

  it('installs the AppImage on other families, or under --appimage', async () => {
    publish('0.15.0')
    const { code, out } = await runLinux([], { DOOP_OS_RELEASE: osRelease('ID=arch\n') })
    expect(code, out).toBe(0)
    expect(calls()).toContain(`curl ${RELEASES}/desktop-v0.15.0/Diazo_0.15.0_amd64.AppImage`)
    expect(existsSync(appimage('0.15.0'))).toBe(true)
    const entry = readFileSync(desktopFile(), 'utf8')
    expect(entry).toContain('Name=Diazo')
    expect(entry).toContain(`Exec="${appimage('0.15.0')}"`)
    expect(entry).toContain('StartupWMClass=doop-desktop')

    /* --appimage forces it on a Debian system too */
    writeFileSync(path.join(root, 'calls.log'), '')
    rmSync(path.join(home, '.local', 'bin'), { recursive: true })
    const forced = await runLinux(['--appimage'], { DOOP_DESKTOP_APPIMAGE_DIR: path.join(home, 'Applications') })
    expect(forced.code, forced.out).toBe(0)
    expect(existsSync(path.join(home, 'Applications', 'Diazo_0.15.0_amd64.AppImage'))).toBe(true)
    expect(calls()).not.toMatch(/apt install/)
  })

  it('is idempotent through the AppImage filename', async () => {
    publish('0.15.0')
    await runLinux(['--appimage'])
    writeFileSync(path.join(root, 'calls.log'), '')
    expect((await runLinux(['--appimage'])).out).toMatch(/already installed/)
    expect(calls()).not.toContain('_amd64.AppImage')
  })

  it('never deletes another vendor’s AppImage, on install or uninstall', async () => {
    publish('0.15.0')
    const dir = path.join(home, '.local', 'bin')
    mkdirSync(dir, { recursive: true })
    const foreign = path.join(dir, 'OtherTool_9.9_amd64.AppImage')
    writeFileSync(foreign, 'foreign\n')
    const { code, out } = await runLinux(['--appimage'])
    expect(code, out).toBe(0)
    expect(existsSync(appimage('0.15.0'))).toBe(true)
    expect(readFileSync(foreign, 'utf8')).toBe('foreign\n')

    /* the foreign file alone does not count as an installed Diazo either */
    rmSync(appimage('0.15.0'))
    publish('0.16.0')
    const again = await runLinux(['--appimage'])
    expect(again.out).not.toMatch(/already installed/)
    expect(existsSync(appimage('0.16.0'))).toBe(true)
    expect(readFileSync(foreign, 'utf8')).toBe('foreign\n')

    /* nor is it removed on uninstall */
    const gone = await runLinux(['--uninstall'])
    expect(gone.code, gone.out).toBe(0)
    expect(existsSync(appimage('0.16.0'))).toBe(false)
    expect(readFileSync(foreign, 'utf8')).toBe('foreign\n')
  })

  it('refuses Linux arm64 with the releases link', async () => {
    publish('0.15.0')
    const { code, out } = await run([], { STUB_OS: 'Linux', STUB_ARCH: 'aarch64' })
    expect(code).not.toBe(0)
    expect(out).toMatch(/no Linux arm64 package is published/)
    expect(out).toMatch(/github\.com\/BRYANN2K\/diazo\/releases/)
    expect(calls()).toBe('')
  })

  it('uninstalls the AppImage and its menu entry, keeping the data', async () => {
    publish('0.15.0')
    await runLinux(['--appimage'])
    const data = path.join(home, '.local', 'share', 'dev.bryann2k.diazo')
    mkdirSync(data, { recursive: true })
    writeFileSync(path.join(data, 'server.json'), '{"url":"http://127.0.0.1:4400"}')
    const { code, out } = await runLinux(['--uninstall'])
    expect(code, out).toBe(0)
    expect(existsSync(appimage('0.15.0'))).toBe(false)
    expect(existsSync(desktopFile())).toBe(false)
    expect(existsSync(path.join(data, 'server.json'))).toBe(true)
    expect(out).toMatch(/kept/)
  })

  it('prints the steps and changes nothing with --dry-run', async () => {
    publish('0.15.0')
    const { code, out } = await runLinux(['--dry-run'])
    expect(code, out).toBe(0)
    expect(out).toMatch(/\[dry run\]/)
    expect(out).toMatch(/Diazo_0\.15\.0_amd64\.deb|_amd64\.deb/)
    expect(calls()).toBe('')
    expect(existsSync(path.join(home, '.local'))).toBe(false)
  })
})

/* install-desktop.ps1 needs Windows to really run (registry, Start-Process),
   but its invariants check out anywhere, and it parses under pwsh where one
   is installed (the CI runners have it). */
describe('install-desktop.ps1', () => {
  const ps1Path = path.resolve(import.meta.dirname, '..', 'scripts', 'install-desktop.ps1')
  const ps1 = readFileSync(ps1Path, 'utf8')
  const pwsh = spawnSync('sh', ['-c', 'command -v pwsh || true']).stdout.toString().trim()

  it.skipIf(!pwsh)('parses under PowerShell', () => {
    const result = spawnSync(
      pwsh,
      [
        '-NoProfile',
        '-Command',
        '$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:PS1_UNDER_TEST,[ref]$t,[ref]$e);$e|ForEach-Object{$_.Message};exit($e.Count)',
      ],
      { env: { ...process.env, PS1_UNDER_TEST: ps1Path } },
    )
    expect(result.status, result.stdout.toString() + result.stderr.toString()).toBe(0)
  })

  it('never names a parameter $Input and never exits the session it runs in', () => {
    /* $Input is PowerShell's automatic pipeline variable; naming a function
       parameter after it made -Server silently read the pipeline instead.
       `exit` under `irm | iex` closes the person's window: errors throw and
       the one top-level catch prints them */
    expect(ps1).not.toMatch(/\$Input\b/)
    expect(ps1).not.toMatch(/^\s*exit\b/m)
    expect(ps1).toContain('throw $Message')
    expect(ps1).toMatch(/\} catch \{[\s\S]*Write-Host "diazo: error:/)
  })

  it('finds the install folder in the uninstall registry key', () => {
    /* Tauri's per-user NSIS defaults to %LOCALAPPDATA%\Diazo and records the
       real folder in the Uninstall key's InstallLocation; DOOP_DESKTOP_DIR
       is handed to the setup as /D= */
    expect(ps1).toMatch(/Uninstall\\Diazo/)
    expect(ps1).toContain('InstallLocation')
    expect(ps1).toContain('LOCALAPPDATA')
    expect(ps1).toContain('/D=')
  })

  it('checks a server like server.rs, and writes only {"url":…}', () => {
    /* plain http only for an address on this computer: localhost or an IP
       literal that parses as loopback — a name is not the address */
    expect(ps1).toContain('IsLoopback')
    /* the origin a redirect lands on is the one written (server.rs's probe) */
    expect(ps1).toContain('ResponseUri')
    expect(ps1).toContain('RequestMessage')
    expect(ps1).toContain('defaultLocale')
    expect(ps1).toMatch(/url = \$Origin/)
    expect(ps1).toContain('server.json')
  })
})
