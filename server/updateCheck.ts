import { existsSync } from 'node:fs'
import {
  type InstallType,
  MAX_LISTED_COMMITS,
  type UnknownReason,
  type UpdateCommit,
  type UpdateStatus,
} from '../shared/updateCheck.ts'
import { buildInfo } from './buildInfo.ts'
import { env } from './env.ts'
import { isAdmin } from './access.ts'

/**
 * "Is a newer build out?", asked of GitHub's public REST API, without a
 * token (60 requests an hour per address, shared with nothing else here).
 *
 * The latest build is the newest commit on the branch whose `docker.yml` run
 * succeeded: that run is what pushes `ghcr.io/<repo>:main`, so "update
 * available" always means an image exists to pull (a commit whose build is
 * still running, or failed, is not announced). A repository without that
 * workflow falls back to the branch head. Then one compare of the running
 * commit with it counts the commits in between and names them.
 *
 * An answer is kept an hour (a failure 15 minutes, a spent rate limit until
 * its reset), every request sends the ETag of its last answer so an unchanged
 * one costs nothing, and nothing here throws: offline is `unknown`.
 */

const FRESH_MS = 60 * 60_000
const RETRY_MS = 15 * 60_000
const TIMEOUT_MS = 8_000
const WORKFLOW = 'docker.yml'

type Reply<T> = { ok: true; body: T } | { ok: false; reason: UnknownReason }

interface Remembered {
  key: string
  status: UpdateStatus
  until: number
}

let remembered: Remembered | undefined
let inFlight: { key: string; promise: Promise<UpdateStatus> } | undefined
const etags = new Map<string, { etag: string; body: unknown }>()
/** GitHub said the limit is spent: no request before this time */
let blockedUntil = 0

/** Forget every answer, ETag and back-off (tests). */
export function resetUpdateCheck(): void {
  remembered = undefined
  inFlight = undefined
  etags.clear()
  blockedUntil = 0
}

export function installType(): InstallType {
  if (env.DOOP_INSTALL) return env.DOOP_INSTALL as InstallType
  if (env.KUBERNETES_SERVICE_HOST) return 'kubernetes'
  if (existsSync('/.dockerenv')) return 'docker'
  return 'source'
}

/** Instance admins see updates; so does the one person a local install
 *  serves, who is rarely made an admin. */
export function maySeeUpdates(user: { role?: string | null } | undefined): boolean {
  return isAdmin(user) || installType() === 'local'
}

export async function updateStatus(): Promise<UpdateStatus> {
  const now = Date.now()
  const running = buildInfo().sha
  const base = baseStatus(running)
  if (!env.DOOP_UPDATE_CHECK) return { ...base, state: 'disabled' }
  if (!running) return { ...base, state: 'unknown', reason: 'no-build-sha' }

  const key = `${base.repo}#${base.branch}@${running}`
  if (remembered?.key === key && now < remembered.until) return remembered.status
  if (inFlight?.key !== key) {
    const promise = check(base, running, now).then((status) => {
      remembered = { key, status, until: expiry(status, now) }
      return status
    })
    void promise.finally(() => {
      if (inFlight?.promise === promise) inFlight = undefined
    })
    inFlight = { key, promise }
  }
  return inFlight.promise
}

function baseStatus(running: string | null): UpdateStatus {
  return {
    state: 'unknown',
    install: installType(),
    repo: env.DOOP_UPDATE_REPO,
    branch: env.DOOP_UPDATE_BRANCH,
    running,
    latest: null,
    source: 'image',
    behindBy: 0,
    aheadBy: 0,
    commits: [],
    compareUrl: null,
    checkedAt: null,
  }
}

function expiry(status: UpdateStatus, now: number): number {
  if (status.reason === 'rate-limited') return Math.max(blockedUntil, now + RETRY_MS)
  return now + (status.state === 'unknown' ? RETRY_MS : FRESH_MS)
}

async function check(base: UpdateStatus, running: string, now: number): Promise<UpdateStatus> {
  const checked = { ...base, checkedAt: new Date(now).toISOString() }
  const latest = await latestBuild(base.repo, base.branch)
  if (!latest.ok) return { ...checked, state: 'unknown', reason: latest.reason }
  const found = { ...checked, latest: latest.body.sha, source: latest.body.source }
  if (latest.body.sha === running) return { ...found, state: 'current' }

  const compare = await github<CompareBody>(
    `/repos/${base.repo}/compare/${running}...${latest.body.sha}`,
    isCompareBody,
  )
  if (!compare.ok) return { ...found, state: 'unknown', reason: compare.reason }
  const { status, ahead_by: behindBy, behind_by: aheadBy, commits } = compare.body
  return {
    ...found,
    state:
      status === 'identical' ? 'current' : status === 'ahead' ? 'behind' : status === 'behind' ? 'ahead' : 'diverged',
    behindBy,
    aheadBy,
    commits: commits.slice(-MAX_LISTED_COMMITS).reverse().map(listed),
    compareUrl: `https://github.com/${base.repo}/compare/${running}...${latest.body.sha}`,
  }
}

/** The newest commit with a published image, else the branch head. */
async function latestBuild(repo: string, branch: string): Promise<Reply<{ sha: string; source: 'image' | 'branch' }>> {
  const runs = await github<RunsBody>(
    `/repos/${repo}/actions/workflows/${WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=1`,
    isRunsBody,
  )
  if (runs.ok) {
    const sha = runs.body.workflow_runs[0]?.head_sha
    /* the workflow exists but never succeeded: no image to offer yet */
    return sha ? { ok: true, body: { sha, source: 'image' } } : { ok: false, reason: 'not-found' }
  }
  if (runs.reason !== 'not-found') return runs
  const head = await github<CommitBody>(`/repos/${repo}/commits/${encodeURIComponent(branch)}`, isCommitBody)
  return head.ok ? { ok: true, body: { sha: head.body.sha, source: 'branch' } } : head
}

function listed(commit: CompareBody['commits'][number]): UpdateCommit {
  return {
    sha: commit.sha,
    title: commit.commit.message.split('\n', 1)[0] ?? '',
    url: commit.html_url,
  }
}

async function github<T>(path: string, valid: (body: unknown) => body is T): Promise<Reply<T>> {
  if (Date.now() < blockedUntil) return { ok: false, reason: 'rate-limited' }
  const url = `${env.DOOP_UPDATE_API}${path}`
  const known = etags.get(url)
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'redoop-update-check',
        ...(known ? { 'if-none-match': known.etag } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (res.status === 304 && known && valid(known.body)) return { ok: true, body: known.body }
  if (res.status === 404 || res.status === 422) return { ok: false, reason: 'not-found' }
  if (res.status === 403 || res.status === 429) {
    const limited = backOff(res)
    if (limited) return { ok: false, reason: 'rate-limited' }
  }
  if (!res.ok) return { ok: false, reason: 'unreachable' }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (!valid(body)) return { ok: false, reason: 'unreachable' }
  const etag = res.headers.get('etag')
  if (etag) etags.set(url, { etag, body })
  return { ok: true, body }
}

/** Reads GitHub's rate-limit headers; true when the limit is what refused. */
function backOff(res: Response): boolean {
  const retryAfter = Number(res.headers.get('retry-after'))
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  const spent = res.headers.get('x-ratelimit-remaining') === '0'
  if (retryAfter > 0) blockedUntil = Date.now() + retryAfter * 1000
  else if (spent && reset > 0) blockedUntil = reset * 1000
  else if (res.status === 429) blockedUntil = Date.now() + RETRY_MS
  else return false
  return true
}

/* ---------------------------------------------------- GitHub's shapes */

interface RunsBody {
  workflow_runs: { head_sha: string }[]
}
interface CommitBody {
  sha: string
}
interface CompareBody {
  status: 'identical' | 'ahead' | 'behind' | 'diverged'
  ahead_by: number
  behind_by: number
  commits: { sha: string; html_url: string; commit: { message: string } }[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isRunsBody(body: unknown): body is RunsBody {
  return (
    isObject(body) &&
    Array.isArray(body.workflow_runs) &&
    body.workflow_runs.every((run) => isObject(run) && typeof run.head_sha === 'string')
  )
}

function isCommitBody(body: unknown): body is CommitBody {
  return isObject(body) && typeof body.sha === 'string'
}

function isCompareBody(body: unknown): body is CompareBody {
  return (
    isObject(body) &&
    ['identical', 'ahead', 'behind', 'diverged'].includes(body.status as string) &&
    typeof body.ahead_by === 'number' &&
    typeof body.behind_by === 'number' &&
    Array.isArray(body.commits) &&
    body.commits.every(
      (c) =>
        isObject(c) &&
        typeof c.sha === 'string' &&
        typeof c.html_url === 'string' &&
        isObject(c.commit) &&
        typeof c.commit.message === 'string',
    )
  )
}
