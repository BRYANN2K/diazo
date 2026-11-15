import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installType, maySeeUpdates, resetUpdateCheck, updateStatus } from '../server/updateCheck.ts'
import { updateCommand, updateKey } from '../shared/updateCheck.ts'
import { stubEnv, unstubAllEnvs } from './envStub.ts'

/**
 * server/updateCheck.ts against a stubbed GitHub: which commit counts as the
 * latest build, how the running one compares, what is cached and for how
 * long, and that every failure is an `unknown` rather than a throw.
 */

const RUNNING = '1'.repeat(40)
/* the running build, as server/buildInfo.ts would report it */
const build = vi.hoisted(() => ({ sha: '1'.repeat(40) as string | null }))
vi.mock('../server/buildInfo.ts', () => ({ buildInfo: () => ({ version: '0.0.0', sha: build.sha, date: null }) }))
const LATEST = '2'.repeat(40)
const API = 'https://api.github.com'
const RUNS = `${API}/repos/BRYANN2K/diazo/actions/workflows/docker.yml/runs?branch=main&status=success&per_page=1`
const HEAD = `${API}/repos/BRYANN2K/diazo/commits/main`
const COMPARE = `${API}/repos/BRYANN2K/diazo/compare/${RUNNING}...${LATEST}`

type Route = (init: RequestInit | undefined) => Response | Promise<Response>
let routes: Map<string, Route>
let calls: { url: string; headers: Record<string, string> }[]

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

function compareBody(status: string, aheadBy: number, behindBy = 0) {
  return {
    status,
    ahead_by: aheadBy,
    behind_by: behindBy,
    commits: Array.from({ length: aheadBy }, (_, i) => ({
      sha: String(i).padStart(40, 'a'),
      html_url: `https://github.com/BRYANN2K/diazo/commit/${i}`,
      commit: { message: `feat: change ${i}\n\nbody ${i}` },
    })),
  }
}

beforeEach(() => {
  routes = new Map()
  calls = []
  build.sha = RUNNING
  stubEnv('DOOP_INSTALL', 'docker')
  resetUpdateCheck()
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    calls.push({ url: input, headers: (init?.headers ?? {}) as Record<string, string> })
    const route = routes.get(input)
    if (!route) return new Response('not found', { status: 404 })
    return route(init)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  unstubAllEnvs()
  resetUpdateCheck()
})

describe('update check', () => {
  it('counts the commits between the running build and the newest image', async () => {
    routes.set(RUNS, () => json({ workflow_runs: [{ head_sha: LATEST }] }))
    routes.set(COMPARE, () => json(compareBody('ahead', 3)))
    const status = await updateStatus()
    expect(status).toMatchObject({
      state: 'behind',
      install: 'docker',
      running: RUNNING,
      latest: LATEST,
      source: 'image',
      behindBy: 3,
      aheadBy: 0,
      compareUrl: `https://github.com/BRYANN2K/diazo/compare/${RUNNING}...${LATEST}`,
    })
    /* newest first, titles only */
    expect(status.commits.map((c) => c.title)).toEqual(['feat: change 2', 'feat: change 1', 'feat: change 0'])
    expect(updateKey(status)).toBe(LATEST)
    expect(calls[0]?.headers['user-agent']).toBe('diazo-update-check')
  })

  it('is up to date without a compare when the image is the running commit', async () => {
    routes.set(RUNS, () => json({ workflow_runs: [{ head_sha: RUNNING }] }))
    const status = await updateStatus()
    expect(status.state).toBe('current')
    expect(updateKey(status)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('reports a build newer than the image, and one that diverged', async () => {
    routes.set(RUNS, () => json({ workflow_runs: [{ head_sha: LATEST }] }))
    routes.set(COMPARE, () => json(compareBody('behind', 0, 2)))
    expect(await updateStatus()).toMatchObject({ state: 'ahead', behindBy: 0, aheadBy: 2 })

    resetUpdateCheck()
    routes.set(COMPARE, () => json(compareBody('diverged', 1, 4)))
    expect(await updateStatus()).toMatchObject({ state: 'diverged', behindBy: 1, aheadBy: 4 })
  })

  it('falls back to the branch head when the repository has no image workflow', async () => {
    routes.set(HEAD, () => json({ sha: LATEST }))
    routes.set(COMPARE, () => json(compareBody('ahead', 1)))
    expect(await updateStatus()).toMatchObject({ state: 'behind', source: 'branch', behindBy: 1 })
  })

  it('is unknown when GitHub does not know the running commit', async () => {
    routes.set(RUNS, () => json({ workflow_runs: [{ head_sha: LATEST }] }))
    expect(await updateStatus()).toMatchObject({ state: 'unknown', reason: 'not-found', latest: LATEST })
  })

  it('is unknown, not a crash, when GitHub cannot be reached', async () => {
    routes.set(RUNS, () => {
      throw new TypeError('fetch failed')
    })
    expect(await updateStatus()).toMatchObject({ state: 'unknown', reason: 'unreachable' })
  })

  it('is unknown without asking when the build does not know its commit', async () => {
    build.sha = null
    expect(await updateStatus()).toMatchObject({ state: 'unknown', reason: 'no-build-sha' })
    expect(calls).toHaveLength(0)
  })

  it('asks nothing when switched off', async () => {
    stubEnv('DOOP_UPDATE_CHECK', 'false')
    expect(await updateStatus()).toMatchObject({ state: 'disabled' })
    expect(calls).toHaveLength(0)
  })

  it('keeps an answer an hour, then revalidates it with its ETag', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'))
    let runsCalls = 0
    routes.set(RUNS, (init) => {
      runsCalls++
      const etag = ((init?.headers ?? {}) as Record<string, string>)['if-none-match']
      if (etag === '"runs-1"') return new Response(null, { status: 304 })
      return json({ workflow_runs: [{ head_sha: LATEST }] }, { headers: { etag: '"runs-1"' } })
    })
    routes.set(COMPARE, () => json(compareBody('ahead', 2), { headers: { etag: '"cmp-1"' } }))

    const first = await updateStatus()
    const [again, alsoAgain] = await Promise.all([updateStatus(), updateStatus()])
    expect(again).toBe(first)
    expect(alsoAgain).toBe(first)
    expect(runsCalls).toBe(1)

    vi.setSystemTime(new Date('2026-11-15T11:00:01Z'))
    const later = await updateStatus()
    expect(runsCalls).toBe(2)
    expect(later).toMatchObject({ state: 'behind', behindBy: 2 })
    expect(calls.at(-2)?.headers['if-none-match']).toBe('"runs-1"')
  })

  it('stops asking until the rate limit resets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'))
    const reset = Math.floor(new Date('2026-11-15T10:40:00Z').getTime() / 1000)
    routes.set(RUNS, () =>
      json(
        { message: 'API rate limit exceeded' },
        { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } },
      ),
    )
    expect(await updateStatus()).toMatchObject({ state: 'unknown', reason: 'rate-limited' })
    vi.setSystemTime(new Date('2026-11-15T10:30:00Z'))
    expect(await updateStatus()).toMatchObject({ reason: 'rate-limited' })
    expect(calls).toHaveLength(1)

    vi.setSystemTime(new Date('2026-11-15T10:41:00Z'))
    routes.set(RUNS, () => json({ workflow_runs: [{ head_sha: RUNNING }] }))
    expect(await updateStatus()).toMatchObject({ state: 'current' })
    expect(calls).toHaveLength(2)
  })

  it('retries a failure after a quarter of an hour, not an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'))
    routes.set(RUNS, () => new Response('oops', { status: 502 }))
    expect(await updateStatus()).toMatchObject({ reason: 'unreachable' })
    vi.setSystemTime(new Date('2026-11-15T10:16:00Z'))
    routes.set(RUNS, () => json({ workflow_runs: [{ head_sha: RUNNING }] }))
    expect(await updateStatus()).toMatchObject({ state: 'current' })
  })

  it('asks the configured repository and branch', async () => {
    stubEnv('DOOP_UPDATE_REPO', 'someone/fork')
    stubEnv('DOOP_UPDATE_BRANCH', 'stable')
    await updateStatus()
    expect(calls[0]?.url).toBe(
      `${API}/repos/someone/fork/actions/workflows/docker.yml/runs?branch=stable&status=success&per_page=1`,
    )
    expect(() => stubEnv('DOOP_UPDATE_REPO', 'not a repo')).toThrow(/DOOP_UPDATE_REPO/)
  })
})

describe('install type and visibility', () => {
  it('takes DOOP_INSTALL first, then recognises a Kubernetes pod', () => {
    expect(installType()).toBe('docker')
    stubEnv('DOOP_INSTALL', undefined)
    stubEnv('KUBERNETES_SERVICE_HOST', '10.43.0.1')
    expect(installType()).toBe('kubernetes')
  })

  it('shows updates to admins, and to everyone on a local install', () => {
    expect(maySeeUpdates({ role: 'admin' })).toBe(true)
    expect(maySeeUpdates({ role: 'user' })).toBe(false)
    expect(maySeeUpdates(undefined)).toBe(false)
    stubEnv('DOOP_INSTALL', 'local')
    expect(maySeeUpdates({ role: 'user' })).toBe(true)
  })

  it('names the update command for each install type', () => {
    expect(updateCommand('local')).toBe('diazo-local update')
    expect(updateCommand('docker')).toBe('docker compose pull && docker compose up -d')
    expect(updateCommand('kubernetes')).toBe('kubectl -n doop rollout restart deploy/doop')
    expect(updateCommand('source')).toContain('git pull')
  })
})
