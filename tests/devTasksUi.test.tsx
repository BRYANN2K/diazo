// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'
import type { DevTask } from '../shared/devTasks.ts'
import { useStore } from '../src/lib/store.ts'
import { DevTaskBadge, DevTaskSection } from '../src/components/DevTasks.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The Build card and title badge in a plain browser context (no Orca
   bridge): launch affordances follow the canvas role, status stays readable
   for everyone. */

const createDevTask = vi.fn(async (_frameId: string, _body: unknown) => ({ task: null }))
const cancelDevTask = vi.fn(async (_taskId: string) => ({ task: null }))
vi.mock('../src/lib/api.ts', () => ({
  api: {
    createDevTask: (frameId: string, body: unknown) => createDevTask(frameId, body),
    cancelDevTask: (taskId: string) => cancelDevTask(taskId),
  },
  errorMessage: (err: unknown, fallback: string) => (err as { body?: { error?: string } })?.body?.error ?? fallback,
}))

function canvasWith(role: 'edit' | 'view') {
  return { id: 'c1', role, pages: [{ id: 'p1', name: 'Page' }], frames: [] } as unknown as Canvas
}

const READY = {
  status: 'ready_for_dev',
  approvedBy: 'Ana',
  approvedByUserId: 'u1',
  approvedAt: 1,
  approvedFrameUpdatedAt: 7,
} as const

function frameWith(approval: Frame['approval']): Frame {
  return {
    id: 'f1',
    name: 'Hero',
    canvasId: 'c1',
    html: '<div/>',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    approval,
  } as unknown as Frame
}

function task(partial: Partial<DevTask> = {}): DevTask {
  return {
    id: 'dt1',
    canvasId: 'c1',
    frameIds: ['f1'],
    frameRevision: 7,
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
    branch: 'doop/hero-dt1',
    prUrl: null,
    state: 'working',
    summary: 'Building the hero section',
    drift: null,
    devUrl: null,
    createdAt: 100,
    updatedAt: 100,
    finishedAt: null,
    ...partial,
  }
}

const READY_FRAME = frameWith(READY)

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  createDevTask.mockClear()
  cancelDevTask.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useStore.setState({ canvas: canvasWith('edit'), devTasks: {} })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(node: React.ReactNode) {
  await act(async () => root.render(node))
}

const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent)

it('offers the launch to an editor on a signed-off frame', async () => {
  await render(<DevTaskSection frame={READY_FRAME} />)
  expect(buttons()).toContain('Send to Orca')
  expect(host.querySelector('[aria-label="Coding agent"]')).toBeTruthy()
})

it('sends the picked agent and reports server errors with a retry', async () => {
  await render(<DevTaskSection frame={READY_FRAME} />)
  const send = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send to Orca')!
  createDevTask.mockRejectedValueOnce({
    body: { error: "the linked project isn't reachable — open the Diazo desktop app holding it" },
  })
  await act(async () => send.click())
  expect(createDevTask).toHaveBeenCalledWith('f1', { agent: 'claude' })
  const alert = host.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain("isn't reachable")
  /* the button stays as the explicit retry */
  expect(buttons()).toContain('Send to Orca')
})

it('hides launch and cancel controls from a view-only participant', async () => {
  useStore.setState({ canvas: canvasWith('view'), devTasks: { dt1: task() } })
  await render(<DevTaskSection frame={READY_FRAME} />)
  expect(host.textContent).toContain('Building')
  expect(buttons()).not.toContain('Send to Orca')
  expect(buttons()).not.toContain('Cancel')
})

it('lists the task state, summary and PR link for any viewer', async () => {
  useStore.setState({
    canvas: canvasWith('view'),
    devTasks: { dt1: task({ state: 'pr_open', prUrl: 'https://gh.example/pr/1' }) },
  })
  await render(<DevTaskSection frame={READY_FRAME} />)
  expect(host.textContent).toContain('PR open')
  expect(host.textContent).toContain('Building the hero section')
  expect(host.querySelector('a[href="https://gh.example/pr/1"]')).toBeTruthy()
  expect(host.querySelector('[role="status"]')?.textContent).toContain('PR open')
})

it('lets an editor cancel a running task', async () => {
  useStore.setState({ devTasks: { dt1: task() } })
  await render(<DevTaskSection frame={READY_FRAME} />)
  const cancel = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
  await act(async () => cancel.click())
  expect(cancelDevTask).toHaveBeenCalledWith('dt1')
})

it('wears the newest task state as the frame badge', async () => {
  useStore.setState({
    devTasks: {
      dt1: task({ state: 'done', createdAt: 100 }),
      dt2: task({ id: 'dt2', state: 'working', createdAt: 200 }),
    },
  })
  await render(<DevTaskBadge frame={READY_FRAME} />)
  expect(host.textContent).toContain('Building')
  expect(host.querySelector('[data-slot="badge"]')?.getAttribute('aria-label')).toContain('Building')
})

it('shows no badge on a taskless frame', async () => {
  await render(<DevTaskBadge frame={READY_FRAME} />)
  expect(host.querySelector('[data-slot="badge"]')).toBeNull()
})
