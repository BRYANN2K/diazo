import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The data lock across REAL containers — run once on a machine with a
 * container runtime, skipped everywhere else (DOOP_TEST_CONTAINERS=1).
 *
 * Two runtimes tell the story twice:
 *   - Apple `container` gives every container its own VM — its own
 *     kernel — so `kernel.lock` cannot see the other side and the claim
 *     epochs plus the beat decide (`alive-elsewhere` while a foreign
 *     holder beats, takeover only after its beat goes quiet);
 *   - Docker shares one kernel — `BEGIN EXCLUSIVE` on the bind-mounted
 *     `kernel.lock` refuses the contender directly (`held`).
 *
 * Both must refuse a second holder, hand the dir over after a SIGKILL,
 * and accept at once after a clean stop — plus the bun image must
 * install the branch's manifest and lockfile clean.
 *
 * The fixture runs under plain `node` (type stripping — this is why
 * server/dataLock.ts and tests/fixtures/dataLockHelper.ts import built-
 * ins only and stay erasable TypeScript).
 */

const ROOT = process.cwd()
const HELPER = '/repo/tests/fixtures/dataLockHelper.ts'
const NODE_IMAGE = 'node:22-slim'
const BUN_IMAGE = 'oven/bun:1'
const BEAT = 200
const OBSERVE = 2_000

type Runtime = 'container' | 'docker'

function detectRuntime(): Runtime | null {
  if (process.env.DOOP_TEST_CONTAINERS !== '1') return null
  for (const candidate of ['container', 'docker'] as const) {
    if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status !== 0) continue
    if (candidate === 'container') {
      /* the CLI answers before the service does — `system start` is
         idempotent, then ls is the real probe */
      spawnSync('container', ['system', 'start'], { encoding: 'utf8', timeout: 120_000 })
      if (spawnSync('container', ['ls'], { encoding: 'utf8' }).status === 0) return 'container'
      continue
    }
    if (spawnSync('docker', ['info'], { encoding: 'utf8', stdio: 'pipe' }).status === 0) return 'docker'
  }
  return null
}

const RUNTIME = detectRuntime()
const describeContainers = RUNTIME ? describe : describe.skip

const names: string[] = []
const runTag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

function cmd(args: string[], timeout = 300_000): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(RUNTIME as string, args, { encoding: 'utf8', timeout })
  return { status: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}

function pull(image: string): void {
  /* pulling a cached image still re-hits the registry on Apple
     container — skip entirely when inspect already knows it */
  if (cmd(['image', 'inspect', image]).status === 0) return
  const args = RUNTIME === 'docker' ? ['pull', image] : ['image', 'pull', '--progress', 'none', image]
  /* a first pull can take minutes on a slow link — far past any test
     timeout, so it lives in beforeAll, not in a scenario */
  const r = cmd(args, 1_500_000)
  expect(r.status, `pull ${image}: ${r.stderr.slice(-2000)}`).toBe(0)
}

/** Volume flags shared by both runtimes — repo read-only at /repo, the
 *  data dir read-write at /data. */
function mounts(dataDir: string): string[] {
  if (RUNTIME === 'docker') return ['-v', `${ROOT}:/repo:ro`, '-v', `${dataDir}:/data`]
  return [
    '--mount',
    `type=bind,source=${ROOT},target=/repo,readonly`,
    '--mount',
    `type=bind,source=${dataDir},target=/data`,
  ]
}

function helperArgs(dir: string, extra: Record<string, unknown> = {}): string[] {
  return [
    'node',
    '--experimental-strip-types',
    HELPER,
    JSON.stringify({ dir, mode: 'takeover', beatMs: BEAT, observeMs: OBSERVE, ...extra }),
  ]
}

/** A detached holder — the test kills, stops and reads its logs. */
function startHolder(name: string, dataDir: string, extra: Record<string, unknown> = {}): void {
  names.push(name)
  const r = cmd(['run', '-d', '--name', name, ...mounts(dataDir), NODE_IMAGE, ...helperArgs('/data', extra)])
  expect(r.status, `${name} run: ${r.stderr}`).toBe(0)
}

/** A foreground contender — exits with the refusal line. */
function runContender(dataDir: string, extra: Record<string, unknown> = {}): { status: number | null; out: string } {
  const r = cmd(['run', '--rm', ...mounts(dataDir), NODE_IMAGE, ...helperArgs('/data', extra)])
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

function logs(name: string): string {
  const r = cmd(['logs', name])
  return `${r.stdout}${r.stderr}`
}

async function waitLog(name: string, re: RegExp, ms = 120_000): Promise<string> {
  const deadline = Date.now() + ms
  for (;;) {
    const text = logs(name)
    if (re.test(text)) return text
    if (Date.now() > deadline) throw new Error(`${name}: never saw ${re}\n${text}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

function rm(name: string): void {
  cmd(RUNTIME === 'docker' ? ['rm', '-f', name] : ['rm', '-f', name])
}

afterAll(() => {
  for (const name of names.splice(0)) rm(name)
})

describeContainers(`the data lock across real containers (${RUNTIME})`, () => {
  beforeAll(() => {
    pull(NODE_IMAGE)
    pull(BUN_IMAGE)
  }, 1_800_000)

  /* a holder's VM keeps its files open until the container is deleted —
     rm it before the temp dir, or the rmSync races its still-beating
     lock dir */
  function cleanup(data: string, ...holders: string[]): void {
    for (const name of holders) rm(name)
    fs.rmSync(data, { recursive: true, force: true })
  }

  it('a second container on the same data dir is refused', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `lock-ctr-${runTag}`))
    const a = `held-a-${runTag}`
    try {
      startHolder(a, data)
      const log = await waitLog(a, /holding=1|refused=/)
      expect(log).toContain('holding=1')

      const contender = runContender(data)
      expect(contender.status).not.toBe(0)
      /* one kernel -> the kernel lock itself refuses; per-VM kernels ->
         the claim's beat decides. Both are a pass — refuse, never share */
      if (RUNTIME === 'docker') expect(contender.out).toContain('refused=held')
      else expect(contender.out).toContain('refused=alive-elsewhere')
    } finally {
      cleanup(data, a)
    }
  }, 600_000)

  it('after SIGKILL the next container takes the data dir', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `lock-ctr-${runTag}`))
    const a = `kill-a-${runTag}`
    const b = `kill-b-${runTag}`
    try {
      startHolder(a, data)
      await waitLog(a, /holding=1/)

      cmd(['kill', a])
      /* a dead holder's claim either frees at once (same kernel — Docker)
         or goes quiet through the observe window (another VM — Apple
         container): either way epoch 2 is taken, never shared */
      startHolder(b, data)
      const log = await waitLog(b, /holding=\d+|refused=/)
      expect(log).toContain('holding=2')
    } finally {
      cleanup(data, a, b)
    }
  }, 600_000)

  it('after a clean stop the next container acquires at once', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `lock-ctr-${runTag}`))
    const a = `stop-a-${runTag}`
    const b = `stop-b-${runTag}`
    try {
      /* the fixture exits itself when its stopFile appears — a clean
         exit that works under every runtime, while `container stop`
         tears the VM down too fast for the marker to land */
      startHolder(a, data, { stopFile: '/data/stop' })
      await waitLog(a, /holding=1/)

      fs.writeFileSync(path.join(data, 'stop'), '')
      /* the exit hook wrote released-1 through the shared mount — the
         marker, not a clock, is the proof the clean path ran */
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (
          fs.existsSync(path.join(data, 'lock')) &&
          fs.readdirSync(path.join(data, 'lock')).some((n) => /^released-\d+$/.test(n))
        ) {
          break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(fs.readdirSync(path.join(data, 'lock')).some((n) => /^released-\d+$/.test(n))).toBe(true)

      startHolder(b, data)
      const log = await waitLog(b, /holding=\d+|refused=/)
      expect(log).toContain('holding=2')
    } finally {
      cleanup(data, a, b)
    }
  }, 600_000)

  it('bun install --frozen-lockfile --production exits 0 in oven/bun:1', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), `lock-ctr-${runTag}`))
    try {
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(app, 'package.json'))
      fs.copyFileSync(path.join(ROOT, 'bun.lock'), path.join(app, 'bun.lock'))
      /* the host's bun cache comes along — the install proves the
         lockfile resolves, it does not re-download the world through a
         VM on a slow link */
      const bunCache = path.join(os.homedir(), '.bun')
      const mount =
        RUNTIME === 'docker'
          ? ['-v', `${app}:/app`, '-w', '/app', '-v', `${bunCache}:/root/.bun`]
          : [
              '--mount',
              `type=bind,source=${app},target=/app`,
              '--mount',
              `type=bind,source=${bunCache},target=/root/.bun`,
              '-w',
              '/app',
            ]
      /* a cold registry can make this minutes — the install itself is
         the assertion, so it gets a container-sized timeout. --offline
         keeps it honest on a slow link: the lockfile is resolved wholly
         against the mounted cache, and anything missing fails loudly
         instead of retrying the registry forever */
      const r = cmd(
        ['run', '--rm', ...mount, BUN_IMAGE, 'bun', 'install', '--frozen-lockfile', '--production', '--offline'],
        900_000,
      )
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    } finally {
      fs.rmSync(app, { recursive: true, force: true })
    }
  }, 900_000)
})
