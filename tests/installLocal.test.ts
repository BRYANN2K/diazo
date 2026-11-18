import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubPath } from './stubPath'

/* scripts/install-local.sh against stub `uname`, `sw_vers`, `container`,
   `docker`, `podman` and `curl` on PATH: the whole flow runs on any CI
   runner, and no real container is ever started. The stubs log each call to
   calls.log. PATH holds only the stub dir and symlinks to basic tools
   (stubPath): a runner's real docker, podman or systemctl can never answer
   where a test removed the stub. */

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'install-local.sh')

/* real installer runs: a machine with slow exec needs more than the 5s default */
vi.setConfig({ testTimeout: 60000 })

let root: string
let home: string
let bin: string
let testPath: string

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
      PATH: testPath,
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
const envFile = () => path.join(home, '.diazo', 'diazo.env')
const runLine = () =>
  calls()
    .split('\n')
    .find((line) => line.startsWith('run ')) ?? ''

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'diazo-install-'))
  home = path.join(root, 'home')
  bin = path.join(root, 'bin')
  spawnSync('mkdir', ['-p', home, bin])
  testPath = stubPath(bin)
  stub('uname', 'case $1 in -s) echo "${STUB_OS:-Darwin}" ;; -m) echo "${STUB_ARCH:-arm64}" ;; esac')
  stub('sw_vers', 'echo 26.0')
  stub('curl', 'exit 0')
  /* the health wait's own sleep: DOOP_HEALTH_TIMEOUT already bounds it */
  stub('sleep', 'exit 0')
  stub(
    'container',
    `echo "$*" >> "$STUB_DIR/calls.log"
case "$1 $2" in
  "system status") exit 0 ;;
  "image pull") case "$*" in *linux/arm64*) [ -z "$STUB_NO_ARM64" ] ;; *) exit 0 ;; esac ;;
  "inspect doop") [ -f "$STUB_DIR/legacy" ] && cat "$STUB_DIR/legacy" ;;
  inspect*) [ -f "$STUB_DIR/exists" ] ;;
  run*) touch "$STUB_DIR/exists" ;;
  "delete --force") case "$3" in doop) rm -f "$STUB_DIR/legacy" ;; *) rm -f "$STUB_DIR/exists" ;; esac ;;
esac`,
  )
  /* the Docker/Podman CLI of a Linux install; STUB_RT tells them apart in
     calls.log so a test can check which runtime answered */
  stub(
    'docker',
    `echo "docker $*" >> "$STUB_DIR/calls.log"
case "$1" in
  info) exit 0 ;;
  pull) exit 0 ;;
  inspect) [ -f "$STUB_DIR/exists" ] ;;
  run) touch "$STUB_DIR/exists" ;;
  "rm") rm -f "$STUB_DIR/exists" ;;
  ps) exit 0 ;;
esac`,
  )
  stub(
    'podman',
    `echo "podman $*" >> "$STUB_DIR/calls.log"
case "$1" in
  version) echo "\${STUB_PODMAN_VERSION-4.9.5}" ;;
  --version) echo "podman version \${STUB_PODMAN_VERSION-4.9.5}" ;;
  pull) exit 0 ;;
  inspect) [ -f "$STUB_DIR/exists" ] ;;
  run) touch "$STUB_DIR/exists" ;;
  "rm") rm -f "$STUB_DIR/exists" ;;
  ps) exit 0 ;;
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
    expect(existsSync(path.join(home, '.diazo'))).toBe(false)
  })

  it('refuses anything but macOS on Apple silicon, or Linux', async () => {
    expect((await run([], { STUB_ARCH: 'x86_64' })).out).toMatch(/Apple silicon/)
    expect((await run([], { STUB_OS: 'MINGW64_NT-10.0' })).out).toMatch(/Windows.*WSL2|WSL2/)
    expect((await run([], { STUB_OS: 'FreeBSD' })).out).toMatch(/macOS or Linux/)
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
    expect(existsSync(path.join(home, '.diazo', 'data'))).toBe(true)
    expect(existsSync(path.join(home, '.diazo', 'bin', 'diazo-local'))).toBe(true)
    /* the pre-rename helper name still answers, as a link */
    const link = path.join(home, '.diazo', 'bin', 'doop-local')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe('diazo-local')
    expect(existsSync(path.join(home, '.doop'))).toBe(false)

    const line = runLine()
    expect(line).toContain('--publish 127.0.0.1:4400:4400')
    expect(line).toContain(`--name diazo`)
    expect(line).toContain(`--volume ${home}/.diazo/data:/app/data`)
    expect(line).toContain('--env BETTER_AUTH_URL=http://localhost:4400')
    /* the update card tells this install how to update itself */
    expect(line).toContain('--env DOOP_INSTALL=local')
    expect(line).not.toContain('--rosetta')
    expect(line.endsWith('ghcr.io/bryann2k/diazo:main')).toBe(true)
  })

  it('keeps the secrets and replaces the container on a re-run', async () => {
    expect((await run([])).code).toBe(0)
    const before = readFileSync(envFile(), 'utf8')
    writeFileSync(path.join(root, 'calls.log'), '')
    expect((await run([], { DOOP_PORT: '4500' })).code).toBe(0)
    expect(readFileSync(envFile(), 'utf8')).toBe(before)
    expect(calls()).toMatch(/^stop diazo$/m)
    expect(calls()).toMatch(/^delete --force diazo$/m)
    expect(runLine()).toContain('--publish 127.0.0.1:4500:4400')
  })

  it('falls back to the amd64 image under Rosetta when no arm64 one is published', async () => {
    expect((await run([], { STUB_NO_ARM64: '1' })).code).toBe(0)
    expect(runLine()).toContain('--platform linux/amd64 --rosetta')
  })

  it('fails when Diazo never answers', async () => {
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
    expect(calls()).toMatch(/^image delete ghcr\.io\/bryann2k\/diazo:main$/m)
    expect(calls()).toMatch(/^image delete ghcr\.io\/bryann2k\/redoop:main$/m)

    expect((await run(['uninstall', '--yes'])).code).toBe(0)
    expect(existsSync(path.join(home, '.diazo'))).toBe(false)
  })

  it('keeps a pre-rename ~/.doop where it is, with its secrets', async () => {
    const old = path.join(home, '.doop')
    mkdirSync(path.join(old, 'data'), { recursive: true })
    writeFileSync(path.join(old, 'data', 'canvas'), 'kept')
    writeFileSync(path.join(old, 'doop.env'), 'BETTER_AUTH_SECRET=old\nSECRETS_ENCRYPTION_KEYS=local:old\n', {
      mode: 0o600,
    })

    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(existsSync(path.join(home, '.diazo'))).toBe(false)
    expect(readFileSync(path.join(old, 'data', 'canvas'), 'utf8')).toBe('kept')
    expect(readFileSync(path.join(old, 'doop.env'), 'utf8')).toContain('BETTER_AUTH_SECRET=old')
    expect(existsSync(path.join(old, 'diazo.env'))).toBe(false)
    const line = runLine()
    expect(line).toContain(`--volume ${old}/data:/app/data`)
    expect(line).toContain(`--env-file ${old}/doop.env`)
    expect(existsSync(path.join(old, 'bin', 'diazo-local'))).toBe(true)
  })

  it('uses ~/.diazo once it exists, even beside an old ~/.doop', async () => {
    mkdirSync(path.join(home, '.doop', 'data'), { recursive: true })
    mkdirSync(path.join(home, '.diazo'), { recursive: true })
    expect((await run([])).code).toBe(0)
    expect(runLine()).toContain(`--volume ${home}/.diazo/data:/app/data`)
    expect(existsSync(envFile())).toBe(true)
  })

  it('replaces the pre-rename doop container, and only one this installer made', async () => {
    writeFileSync(path.join(root, 'legacy'), '{"image":"ghcr.io/bryann2k/redoop:main"}')
    const { code, out } = await run([])
    expect(code, out).toBe(0)
    expect(calls()).toMatch(/^stop doop$/m)
    expect(calls()).toMatch(/^delete --force doop$/m)
    expect(out).toMatch(/replacing the pre-rename container/)

    writeFileSync(path.join(root, 'calls.log'), '')
    writeFileSync(path.join(root, 'legacy'), '{"image":"docker.io/someone/else:1"}')
    const other = await run([])
    expect(other.code, other.out).toBe(0)
    expect(other.out).toMatch(/left the container 'doop' alone/)
    expect(calls()).not.toMatch(/^delete --force doop$/m)
  })
})

/* Linux: the same container, data folder and secrets through Docker, or
   Podman when Docker is missing; no Apple `container` call is made. */
describe('install-local.sh on Linux', () => {
  const dockerRunLine = () =>
    calls()
      .split('\n')
      .find((line) => line.startsWith('docker run ')) ?? ''
  const podmanRunLine = () =>
    calls()
      .split('\n')
      .find((line) => line.startsWith('podman run ')) ?? ''

  it('runs the same container through Docker, with a restart policy', async () => {
    const { code, out } = await run([], { STUB_OS: 'Linux', STUB_ARCH: 'x86_64' })
    expect(code, out).toBe(0)
    expect(calls()).toContain('docker info')
    expect(calls()).toContain('docker pull --platform linux/amd64 ghcr.io/bryann2k/diazo:main')
    expect(calls()).not.toMatch(/^run |system |image /m)
    const line = dockerRunLine()
    expect(line).toContain('--name diazo')
    expect(line).toContain('--restart unless-stopped')
    expect(line).toContain('--publish 127.0.0.1:4400:4400')
    expect(line).toContain(`--volume ${home}/.diazo/data:/app/data`)
    expect(line).toContain('--env-file')
    expect(line).toContain('--env DOOP_INSTALL=local')
    expect(line.endsWith('ghcr.io/bryann2k/diazo:main')).toBe(true)
    expect(statSync(envFile()).mode & 0o777).toBe(0o600)
    expect(out).toMatch(/http:\/\/localhost:4400/)
  })

  it('runs as the caller under Docker so the mounted data is writable, relabelled under SELinux', async () => {
    /* the image's uid 10001 cannot write the person's data folder: the
       container gets the caller's uid instead, and HOME where it can write */
    const uid = spawnSync('id', ['-u']).stdout.toString().trim()
    const gid = spawnSync('id', ['-g']).stdout.toString().trim()
    const { code } = await run([], { STUB_OS: 'Linux', STUB_ARCH: 'x86_64' })
    expect(code).toBe(0)
    const line = dockerRunLine()
    expect(line).toContain(`--user ${uid}:${gid}`)
    expect(line).toContain('--env HOME=/app/data')
    expect(line).not.toContain('--userns')
    expect(line).toContain(`--volume ${home}/.diazo/data:/app/data`)
    expect(line).not.toContain('/app/data:Z')

    /* SELinux enforcing (Fedora/RHEL): without :Z the mount is denied inside */
    stub('getenforce', 'echo Enforcing')
    writeFileSync(path.join(root, 'calls.log'), '')
    expect((await run([], { STUB_OS: 'Linux' })).code).toBe(0)
    expect(dockerRunLine()).toContain(`--volume ${home}/.diazo/data:/app/data:Z`)

    /* but not when it only permits */
    stub('getenforce', 'echo Permissive')
    writeFileSync(path.join(root, 'calls.log'), '')
    expect((await run([], { STUB_OS: 'Linux' })).code).toBe(0)
    expect(dockerRunLine()).not.toContain('/app/data:Z')
  })

  it('pins the caller at the image uid under Podman 4.3+ (keep-id), not --user', async () => {
    rmSync(path.join(bin, 'docker'))
    for (const version of ['4.9.5', '5.1.2']) {
      writeFileSync(path.join(root, 'calls.log'), '')
      expect((await run([], { STUB_OS: 'Linux', STUB_ARCH: 'x86_64', STUB_PODMAN_VERSION: version })).code).toBe(0)
      const line = podmanRunLine()
      expect(line).toContain('--userns=keep-id:uid=10001,gid=10001')
      expect(line).toContain('--env HOME=/app/data')
      expect(line).not.toMatch(/--user \d/)
    }
  })

  it('maps the caller on Podman older than 4.3: plain keep-id plus --user', async () => {
    rmSync(path.join(bin, 'docker'))
    const uid = spawnSync('id', ['-u']).stdout.toString().trim()
    const gid = spawnSync('id', ['-g']).stdout.toString().trim()
    /* the uid=/gid= options do not exist before 4.3; an unreadable version
       gets the same compatible form */
    for (const version of ['4.2.5', '3.4.4', '']) {
      writeFileSync(path.join(root, 'calls.log'), '')
      expect((await run([], { STUB_OS: 'Linux', STUB_ARCH: 'x86_64', STUB_PODMAN_VERSION: version })).code).toBe(0)
      const line = podmanRunLine()
      expect(line).toContain('--userns=keep-id ')
      expect(line).toContain(`--user ${uid}:${gid}`)
      expect(line).not.toContain('keep-id:uid=')
    }
  })

  it('pulls the arm64 image on arm64 Linux', async () => {
    expect((await run([], { STUB_OS: 'Linux', STUB_ARCH: 'aarch64' })).code).toBe(0)
    expect(calls()).toContain('docker pull --platform linux/arm64 ghcr.io/bryann2k/diazo:main')
  })

  it('uses Podman when Docker is missing, and DOOP_RUNTIME overrides the pick', async () => {
    rmSync(path.join(bin, 'docker'))
    const { code, out } = await run([], { STUB_OS: 'Linux', STUB_ARCH: 'x86_64' })
    expect(code, out).toBe(0)
    expect(calls()).toMatch(/^podman run --detach --name diazo /m)
    expect(calls()).not.toMatch(/^docker /m)

    /* an explicit pick wins even beside docker */
    stub('docker', 'echo "docker $*" >> "$STUB_DIR/calls.log"; exit 0')
    writeFileSync(path.join(root, 'calls.log'), '')
    expect((await run([], { STUB_OS: 'Linux', DOOP_RUNTIME: 'podman' })).code).toBe(0)
    expect(calls()).toMatch(/^podman run /m)
    expect(calls()).not.toMatch(/^docker run /m)
  })

  it('says what to install when neither Docker nor Podman is there', async () => {
    rmSync(path.join(bin, 'docker'))
    rmSync(path.join(bin, 'podman'))
    const { code, out } = await run([], { STUB_OS: 'Linux' })
    expect(code).not.toBe(0)
    expect(out).toMatch(/neither Docker nor Podman/)
    expect(out).toMatch(/docs\.docker\.com/)
    expect(calls()).toBe('')
  })

  it('starts, stops and shows the container through the runtime', async () => {
    expect((await run([], { STUB_OS: 'Linux' })).code).toBe(0)
    writeFileSync(path.join(root, 'calls.log'), '')
    expect((await run(['stop'], { STUB_OS: 'Linux' })).out).toMatch(/stopped/)
    expect(calls()).toMatch(/^docker stop diazo$/m)
    writeFileSync(path.join(root, 'calls.log'), '')
    expect((await run(['start'], { STUB_OS: 'Linux' })).code).toBe(0)
    expect(calls()).toMatch(/^docker start diazo$/m)
    const status = await run(['status'], { STUB_OS: 'Linux' })
    expect(calls()).toMatch(/^docker ps -a$/m)
    expect(status.out).toMatch(/answering on http:\/\/localhost:4400/)
  })

  it('says so when the Docker daemon is down', async () => {
    stub('docker', 'echo "docker $*" >> "$STUB_DIR/calls.log"; [ "$1" = info ] && exit 1; exit 0')
    const { code, out } = await run([], { STUB_OS: 'Linux' })
    expect(code).not.toBe(0)
    expect(out).toMatch(/daemon is not running/)
    expect(calls()).not.toMatch(/^docker run /m)
  })

  it('uninstalls the container and image through the runtime', async () => {
    expect((await run([], { STUB_OS: 'Linux' })).code).toBe(0)
    writeFileSync(path.join(root, 'calls.log'), '')
    const { code, out } = await run(['uninstall', '--keep-data'], { STUB_OS: 'Linux' })
    expect(code, out).toBe(0)
    expect(calls()).toMatch(/^docker rm -f diazo$/m)
    expect(calls()).toMatch(/^docker rmi ghcr\.io\/bryann2k\/diazo:main$/m)
    expect(existsSync(envFile())).toBe(true)
  })
})
