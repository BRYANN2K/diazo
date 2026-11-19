// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types.ts'
import type { DevTask } from '../shared/devTasks.ts'
import { useStore } from '../src/lib/store.ts'
import { hydrateDevTasks } from '../src/lib/devTasks.ts'

/* REST hydration vs room broadcasts: the merge in the store must keep the
   freshest row per task and never leak another canvas's tasks. */

const canvasDevTasks = vi.fn<(canvasId: string) => Promise<{ tasks: DevTask[] }>>()
vi.mock('../src/lib/api.ts', () => ({
  api: { canvasDevTasks: (canvasId: string) => canvasDevTasks(canvasId) },
}))

const CANVAS = { id: 'c1', role: 'edit', pages: [{ id: 'p1', name: 'Page' }], frames: [] } as unknown as Canvas
const OTHER = { id: 'c2', role: 'edit', pages: [{ id: 'p2', name: 'Page' }], frames: [] } as unknown as Canvas

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
    orcaIdentity: null,
    orcaSessionId: null,
    branch: null,
    prUrl: null,
    state: 'queued',
    summary: null,
    drift: null,
    devUrl: null,
    createdAt: 100,
    updatedAt: 100,
    finishedAt: null,
    ...partial,
  }
}

beforeEach(() => {
  canvasDevTasks.mockReset()
  useStore.setState({ canvas: null, devTasks: {} })
  useStore.getState().setCanvas(CANVAS)
})

it('keeps a room event newer than the list snapshot', () => {
  const s = useStore.getState()
  /* the broadcast landed while the REST list was still in flight */
  s.upsertDevTask(task({ state: 'working', updatedAt: 200 }))
  s.setDevTasks([task({ state: 'queued', updatedAt: 100 })], 'c1')
  expect(useStore.getState().devTasks.dt1?.state).toBe('working')
})

it('keeps a task the list does not know yet', () => {
  const s = useStore.getState()
  s.upsertDevTask(task({ id: 'dt-new', updatedAt: 300 }))
  s.setDevTasks([task()], 'c1')
  expect(Object.keys(useStore.getState().devTasks).sort()).toEqual(['dt-new', 'dt1'])
})

it('drops a late list answer after navigation', () => {
  const s = useStore.getState()
  s.setCanvas(OTHER)
  s.setDevTasks([task()], 'c1')
  expect(useStore.getState().devTasks).toEqual({})
})

it('ignores upserts for another canvas and staler updates', () => {
  const s = useStore.getState()
  s.upsertDevTask(task({ canvasId: 'c9' }))
  expect(useStore.getState().devTasks).toEqual({})
  s.upsertDevTask(task({ state: 'working', updatedAt: 200 }))
  s.upsertDevTask(task({ state: 'queued', updatedAt: 100 }))
  expect(useStore.getState().devTasks.dt1?.state).toBe('working')
})

it('clears tasks on canvas switch but keeps them on re-join', () => {
  const s = useStore.getState()
  s.upsertDevTask(task())
  s.setCanvas(CANVAS) // a re-join hands back the same canvas
  expect(useStore.getState().devTasks.dt1).toBeTruthy()
  s.setCanvas(OTHER)
  expect(useStore.getState().devTasks).toEqual({})
})

it('hydrates from REST and merges into the room state', async () => {
  const s = useStore.getState()
  s.upsertDevTask(task({ state: 'working', updatedAt: 200 }))
  canvasDevTasks.mockResolvedValue({ tasks: [task({ id: 'dt-old', state: 'done', updatedAt: 50 })] })
  await hydrateDevTasks('c1')
  const { devTasks } = useStore.getState()
  expect(devTasks.dt1?.state).toBe('working')
  expect(devTasks['dt-old']?.state).toBe('done')
  expect(canvasDevTasks).toHaveBeenCalledWith('c1')
})

it('swallows a failed hydration — broadcasts still apply', async () => {
  canvasDevTasks.mockRejectedValue(new Error('forbidden'))
  await expect(hydrateDevTasks('c1')).resolves.toBeUndefined()
  useStore.getState().upsertDevTask(task())
  expect(useStore.getState().devTasks.dt1).toBeTruthy()
})
