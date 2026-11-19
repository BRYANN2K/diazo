// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RepoRequest } from '../shared/localRepo.ts'
import type { DevTask } from '../shared/devTasks.ts'
import { useStore } from '../src/lib/store.ts'
import { startLocalRepo } from '../src/lib/localRepo.ts'

/* The device's end of the bridge against a fake shell: `__TAURI__.core.invoke`
   records every command, and the api's repo/dev-task endpoints are mocked.
   The launch dispatch, report queue, poll loop and untracking run for real. */

const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>()
const pollLocalRepo = vi.fn<() => Promise<{ request: RepoRequest | null }>>()
const finishLocalRepo = vi.fn(async (_id: string, _deviceId: string, _result: unknown) => ({ ok: true }))
const reportDevTask = vi.fn<(taskId: string, report: unknown) => Promise<{ ok: boolean; task: DevTask }>>()

vi.mock('../src/lib/api.ts', () => ({
  api: {
    pollLocalRepo: () => pollLocalRepo(),
    finishLocalRepo: (id: string, deviceId: string, result: unknown) => finishLocalRepo(id, deviceId, result),
    reportDevTask: (taskId: string, report: unknown) => reportDevTask(taskId, report),
    canvasRepo: async () => ({ link: null, online: false, deviceMismatch: false }),
  },
  ApiError: class ApiError extends Error {
    status: number
    body: Record<string, unknown>
    constructor(status: number, text: string) {
      super(`${status} ${text}`)
      this.status = status
      try {
        this.body = JSON.parse(text) as Record<string, unknown>
      } catch {
        this.body = {}
      }
    }
  },
}))

function task(partial: Partial<DevTask> = {}): DevTask {
  return {
    id: 'dt1',
    canvasId: 'c1',
    frameIds: ['f1'],
    frameRevision: 1,
    duelId: null,
    requestedBy: 'Ana',
    runner: 'orca',
    agent: 'claude',
    model: null,
    effort: null,
    hostLabel: 'This Mac',
    environment: null,
    orcaIdentity: 'wt2:mac:i1',
    orcaSessionId: null,
    branch: 'doop/checkout-dt1',
    prUrl: null,
    state: 'starting',
    summary: null,
    drift: null,
    devUrl: null,
    createdAt: 100,
    updatedAt: 100,
    finishedAt: null,
    ...partial,
  }
}

const DEV_REQUEST: RepoRequest = {
  id: 'req-1',
  linkId: 'link-1',
  op: 'dev_task',
  args: {
    devTask: {
      taskId: 'dt1',
      worktreeName: 'doop-checkout-dt1',
      branch: 'doop/checkout-dt1',
      agent: 'claude',
      prompt: 'the brief prompt',
      comment: 'doop: http://x/c/c1?frame=f1 · task dt1',
    },
  },
}

/** Serve the dev-task request once, then hold the long-poll open forever so
 *  the repo loop parks instead of spinning. */
function pollOnce(request: RepoRequest | null) {
  let calls = 0
  pollLocalRepo.mockImplementation(() => {
    calls++
    return calls === 1 ? Promise.resolve({ request }) : new Promise(() => {})
  })
}

let stop: (() => void) | null = null

beforeEach(() => {
  invoke.mockReset()
  pollLocalRepo.mockReset()
  finishLocalRepo.mockClear()
  reportDevTask.mockReset()
  const globals = globalThis as Record<string, unknown>
  globals.__DOOP_LOCAL_REPO__ = true
  globals.__DIAZO_ORCA__ = true
  globals.__DOOP_ORCA__ = true
  globals.__TAURI__ = { core: { invoke } }
  useStore.setState({ canvas: null, devTasks: {} })
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'repo_grants') return [{ id: 'link-1', name: 'proj' }]
    if (cmd === 'orca_launch_task')
      return { ok: true, orcaIdentity: 'wt2:mac:i1', branch: 'doop/checkout-dt1', orcaSessionId: 's1' }
    if (cmd === 'orca_poll') return { rows: [] }
    if (cmd === 'orca_untrack') return { removed: 1 }
    throw new Error(`unexpected invoke ${cmd}`)
  })
  reportDevTask.mockResolvedValue({ ok: true, task: task() })
})

afterEach(() => {
  stop?.()
  stop = null
  vi.useRealTimers()
  const globals = globalThis as Record<string, unknown>
  delete globals.__DOOP_LOCAL_REPO__
  delete globals.__DIAZO_ORCA__
  delete globals.__DOOP_ORCA__
  delete globals.__TAURI__
})

const launchCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === 'orca_launch_task')

it('dispatches a dev_task claim to orca_launch_task and reports the launch', async () => {
  pollOnce(DEV_REQUEST)
  stop = startLocalRepo()
  await vi.waitFor(() => expect(reportDevTask).toHaveBeenCalled())

  expect(invoke).toHaveBeenCalledWith('orca_launch_task', {
    taskId: 'dt1',
    linkId: 'link-1',
    worktreeName: 'doop-checkout-dt1',
    branch: 'doop/checkout-dt1',
    agent: 'claude',
    model: null,
    effort: null,
    prompt: 'the brief prompt',
    comment: 'doop: http://x/c/c1?frame=f1 · task dt1',
    environment: null,
  })
  const [taskId, report] = reportDevTask.mock.calls[0] as unknown as [
    string,
    { deviceId: string; requestId: string; launch: Record<string, unknown>; poll?: unknown },
  ]
  expect(taskId).toBe('dt1')
  expect(report.requestId).toBe('req-1') // settles the bridge entry
  expect(report.deviceId).toMatch(/^[0-9a-f-]{36}$/)
  expect(report.launch).toMatchObject({ ok: true, orcaIdentity: 'wt2:mac:i1', orcaSessionId: 's1' })
  expect(report.poll).toBeUndefined()
  /* a dev task never answers through the generic finish */
  expect(finishLocalRepo).not.toHaveBeenCalled()
})

it('reports a refused native confirmation as cancelled', async () => {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'repo_grants') return [{ id: 'link-1', name: 'proj' }]
    if (cmd === 'orca_launch_task') return { ok: false, cancelled: true }
    throw new Error(`unexpected invoke ${cmd}`)
  })
  reportDevTask.mockResolvedValue({ ok: true, task: task({ state: 'cancelled' }) })
  pollOnce(DEV_REQUEST)
  stop = startLocalRepo()
  await vi.waitFor(() => expect(reportDevTask).toHaveBeenCalled())
  expect(reportDevTask.mock.calls[0]?.[1]).toMatchObject({ launch: { ok: false, cancelled: true } })
})

it('reports a bridge-level launch failure instead of retrying the create', async () => {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'repo_grants') return [{ id: 'link-1', name: 'proj' }]
    if (cmd === 'orca_launch_task') throw new Error('Orca is not installed on this computer')
    throw new Error(`unexpected invoke ${cmd}`)
  })
  reportDevTask.mockResolvedValue({ ok: true, task: task({ state: 'failed' }) })
  pollOnce(DEV_REQUEST)
  stop = startLocalRepo()
  await vi.waitFor(() => expect(reportDevTask).toHaveBeenCalled())
  expect(reportDevTask.mock.calls[0]?.[1]).toMatchObject({
    launch: { ok: false, error: 'Orca is not installed on this computer' },
  })
  expect(launchCalls()).toHaveLength(1)
})

it('retries a lost launch report without launching a second worktree', async () => {
  reportDevTask.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue({ ok: true, task: task() })
  pollOnce(DEV_REQUEST)
  vi.useFakeTimers()
  stop = startLocalRepo()
  await vi.waitFor(() => expect(reportDevTask.mock.calls.length).toBeGreaterThanOrEqual(1))
  await vi.advanceTimersByTimeAsync(5_000) // the retry pass
  await vi.waitFor(() => expect(reportDevTask.mock.calls.length).toBeGreaterThanOrEqual(2))
  expect(reportDevTask.mock.calls[1]?.[1]).toMatchObject({ requestId: 'req-1' })
  expect(launchCalls()).toHaveLength(1)
})

it('forwards poll rows and untracks once the room knows the task ended', async () => {
  let polls = 0
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'repo_grants') return [{ id: 'link-1', name: 'proj' }]
    if (cmd === 'orca_launch_task') return { ok: true, orcaIdentity: 'wt2:mac:i1', branch: 'b' }
    if (cmd === 'orca_poll') {
      polls++
      return { rows: [{ identity: 'wt2:mac:i1', found: true, status: 'working', agentState: 'working' }] }
    }
    if (cmd === 'orca_untrack') return { removed: 1 }
    throw new Error(`unexpected invoke ${cmd}`)
  })
  reportDevTask.mockResolvedValue({ ok: true, task: task({ state: 'working' }) })
  pollOnce(DEV_REQUEST)
  vi.useFakeTimers()
  stop = startLocalRepo()
  await vi.waitFor(() => expect(reportDevTask.mock.calls.length).toBeGreaterThanOrEqual(1))

  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(reportDevTask.mock.calls.length).toBeGreaterThanOrEqual(2))
  const last = reportDevTask.mock.calls.at(-1)?.[1] as { poll?: Record<string, unknown> }
  expect(last.poll).toMatchObject({ found: true, status: 'working', agentState: 'working' })
  expect(last.poll).not.toHaveProperty('identity') // the identity stays out of the report

  /* the agent pushed done over MCP — the next tick untracks, no more polls */
  useStore.setState({ devTasks: { dt1: task({ state: 'done' }) } })
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('orca_untrack', { identities: ['wt2:mac:i1'] }))
  const pollsAtUntrack = polls
  await vi.advanceTimersByTimeAsync(20_000)
  expect(polls).toBe(pollsAtUntrack)
})

it('resumes polling persisted identities after a reload, without relaunching', async () => {
  /* the shell restarted: `tracked` starts empty and no dev_task request
     ever arrives — the shell's own orca-tasks.json still answers the two
     identities it launched earlier, on this Mac and on a paired VPS, and
     the open canvas's task rows name them by orcaIdentity */
  pollLocalRepo.mockImplementation(() => new Promise(() => {})) // parks
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'repo_grants') return [{ id: 'link-1', name: 'proj' }]
    if (cmd === 'orca_status')
      return { installed: true, running: true, environments: [{ name: 'vps' }], hosts: [], agents: [] }
    if (cmd === 'orca_poll') {
      const env = args?.environment as string | null
      if (env === 'vps')
        return { rows: [{ identity: 'wt2:vps:i2', found: true, status: 'working', agentState: 'working' }] }
      return { rows: [{ identity: 'wt2:mac:i1', found: true, status: 'working', agentState: 'working' }] }
    }
    if (cmd === 'orca_untrack') return { removed: 1 }
    throw new Error(`unexpected invoke ${cmd}`)
  })
  useStore.setState({
    devTasks: {
      dt1: task({ id: 'dt1', orcaIdentity: 'wt2:mac:i1', environment: null, state: 'working' }),
      dt2: task({ id: 'dt2', orcaIdentity: 'wt2:vps:i2', environment: 'vps', state: 'working' }),
    },
  })
  reportDevTask.mockResolvedValue({ ok: true, task: task({ state: 'working' }) })
  vi.useFakeTimers()
  stop = startLocalRepo()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(reportDevTask.mock.calls.length).toBeGreaterThanOrEqual(2))
  const reported = new Set(reportDevTask.mock.calls.map(([id]) => id))
  expect(reported).toEqual(new Set(['dt1', 'dt2']))
  expect(invoke.mock.calls.map(([cmd]) => cmd)).toContain('orca_status')
  expect(invoke).toHaveBeenCalledWith('orca_poll', { environment: 'vps' })
  expect(invoke).toHaveBeenCalledWith('orca_poll', { environment: null })
  expect(launchCalls()).toHaveLength(0)

  /* the re-primed watch survives the next ticks, and a terminal room state
     still untracks the worktree */
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(reportDevTask.mock.calls.length).toBeGreaterThanOrEqual(4))
  useStore.setState({
    devTasks: {
      dt1: task({ id: 'dt1', orcaIdentity: 'wt2:mac:i1', environment: null, state: 'done' }),
      dt2: task({ id: 'dt2', orcaIdentity: 'wt2:vps:i2', environment: 'vps', state: 'working' }),
    },
  })
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('orca_untrack', { identities: ['wt2:mac:i1'] }))
  expect(launchCalls()).toHaveLength(0)
})

it('posts absent report fields as omissions when a shell sends explicit null', async () => {
  /* an older shell spells every absent field as `null` in the launch
     answer and each poll row — the posted reports must look like a
     current shell's, so the report boundary drops null keys (devUrl is
     the exception: its null clears the stored URL) */
  pollOnce(DEV_REQUEST)
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'repo_grants') return [{ id: 'link-1', name: 'proj' }]
    if (cmd === 'orca_launch_task')
      return {
        ok: true,
        orcaIdentity: 'wt2:mac:i1',
        branch: 'doop/checkout-dt1',
        launchKind: null,
        launchHandle: null,
        orcaSessionId: null,
        operationId: null,
      }
    if (cmd === 'orca_poll')
      return {
        rows: [
          {
            identity: 'wt2:mac:i1',
            found: true,
            status: 'active',
            agentState: 'working',
            outcome: null,
            lastAssistantMessage: null,
            linkedPR: null,
            orcaSessionId: null,
            branch: 'doop/checkout-dt1',
            workspaceStatus: null,
            devUrl: null,
          },
        ],
      }
    if (cmd === 'orca_untrack') return { removed: 1 }
    throw new Error(`unexpected invoke ${cmd}`)
  })
  useStore.setState({
    devTasks: { dt1: task({ id: 'dt1', orcaIdentity: 'wt2:mac:i1', state: 'starting' }) },
  })
  vi.useFakeTimers()
  stop = startLocalRepo()
  await vi.waitFor(() => expect(reportDevTask).toHaveBeenCalled())
  const launchReport = reportDevTask.mock.calls[0]?.[1] as { launch: Record<string, unknown> }
  expect(launchReport.launch).toEqual({
    ok: true,
    orcaIdentity: 'wt2:mac:i1',
    branch: 'doop/checkout-dt1',
  })
  expect(Object.keys(launchReport.launch).sort()).toEqual(['branch', 'ok', 'orcaIdentity'])

  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(reportDevTask.mock.calls.some(([, r]) => (r as { poll?: object }).poll)).toBe(true))
  const report = reportDevTask.mock.calls.map(([, r]) => r as { poll?: Record<string, unknown> }).find((r) => r.poll)
  const poll = report?.poll as Record<string, unknown>
  expect(poll).toEqual({
    found: true,
    status: 'active',
    agentState: 'working',
    branch: 'doop/checkout-dt1',
    devUrl: null,
  })
  expect(Object.keys(poll).sort()).toEqual(['agentState', 'branch', 'devUrl', 'found', 'status'])
})

it('resolves a discovered identity once hydration lands, and keeps it across canvas switches', async () => {
  /* the shell restarted and the canvas's task rows are not loaded yet:
     the first poll cannot name wt2:mac:i1 / wt2:vps:i2, hydration does on
     the next tick, and the memorized association survives the store
     emptying on a canvas switch — polling goes on without any relaunch */
  pollLocalRepo.mockImplementation(() => new Promise(() => {})) // parks
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'repo_grants') return [{ id: 'link-1', name: 'proj' }]
    if (cmd === 'orca_status')
      return { installed: true, running: true, environments: [{ name: 'vps' }], hosts: [], agents: [] }
    if (cmd === 'orca_poll') {
      const env = args?.environment as string | null
      if (env === 'vps') return { rows: [{ identity: 'wt2:vps:i2', found: true, status: 'working' }] }
      return { rows: [{ identity: 'wt2:mac:i1', found: true, status: 'active', agentState: 'working' }] }
    }
    if (cmd === 'orca_untrack') return { removed: 1 }
    throw new Error(`unexpected invoke ${cmd}`)
  })
  reportDevTask.mockResolvedValue({ ok: true, task: task({ state: 'working' }) })
  vi.useFakeTimers()
  stop = startLocalRepo()

  /* first sweep: both rows arrive but no store row can name them — nothing reports */
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('orca_poll', { environment: null }))
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('orca_poll', { environment: 'vps' }))
  expect(reportDevTask).not.toHaveBeenCalled()
  expect(launchCalls()).toHaveLength(0)

  /* hydration lands: both identities resolve and report on the next tick */
  useStore.setState({
    devTasks: {
      dt1: task({ id: 'dt1', orcaIdentity: 'wt2:mac:i1', environment: null, state: 'working' }),
      dt2: task({ id: 'dt2', orcaIdentity: 'wt2:vps:i2', environment: 'vps', state: 'working' }),
    },
  })
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(reportDevTask.mock.calls.length).toBeGreaterThanOrEqual(2))
  expect(new Set(reportDevTask.mock.calls.map(([id]) => id))).toEqual(new Set(['dt1', 'dt2']))

  /* a canvas switch empties the task store — the memorized associations
     keep both identities reporting on the tick after */
  useStore.setState({ devTasks: {} })
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(reportDevTask.mock.calls.length).toBeGreaterThanOrEqual(4))
  expect(new Set(reportDevTask.mock.calls.map(([id]) => id))).toEqual(new Set(['dt1', 'dt2']))
  expect(launchCalls()).toHaveLength(0)
})

it('keeps ordinary folder requests on the finish path', async () => {
  pollOnce({ id: 'req-2', linkId: 'link-1', op: 'list', args: { subdir: 'src' } })
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'repo_grants') return [{ id: 'link-1', name: 'proj' }]
    if (cmd === 'repo_list') return { entries: [], truncated: false, args }
    throw new Error(`unexpected invoke ${cmd}`)
  })
  stop = startLocalRepo()
  await vi.waitFor(() => expect(finishLocalRepo).toHaveBeenCalled())
  expect(invoke).toHaveBeenCalledWith('repo_list', { linkId: 'link-1', subdir: 'src' })
  expect(finishLocalRepo.mock.calls[0]?.[0]).toBe('req-2')
  expect(reportDevTask).not.toHaveBeenCalled()
})

it('settles a malformed dev_task request through finish and moves on', async () => {
  pollOnce({ id: 'req-3', linkId: 'link-1', op: 'dev_task', args: {} })
  stop = startLocalRepo()
  await vi.waitFor(() => expect(finishLocalRepo).toHaveBeenCalled())
  expect(finishLocalRepo.mock.calls[0]?.[0]).toBe('req-3')
  expect(finishLocalRepo.mock.calls[0]?.[2]).toMatchObject({ ok: false })
  expect(launchCalls()).toHaveLength(0)
})
