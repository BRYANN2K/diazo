// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CurationJobView, CurationPlanView } from '../shared/libraryCuration'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* "Organise with AI": pick the sources, follow the run, review the
   proposed tree (rename, remove), then create the library. */

const job = (status: CurationJobView['status'], extra: Partial<CurationJobView> = {}): CurationJobView => ({
  id: 'j1',
  name: 'Design Library (curated)',
  sourceIds: ['a', 'b'],
  status,
  progress: { done: 120, total: 400 },
  error: null,
  calls: 3,
  model: 'Claude API (claude-sonnet-5)',
  usage: [],
  canvasId: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
})

const PLAN: CurationPlanView = {
  tree: [
    {
      id: 'c1',
      name: 'Heroes',
      path: 'Heroes',
      own: 0,
      count: 2,
      frames: 2,
      samples: [],
      children: [
        {
          id: 'c2',
          name: 'AI products',
          path: 'Heroes/AI products',
          own: 2,
          count: 2,
          frames: 2,
          samples: [{ key: 'a:f1', label: 'AI hero', frames: [{ canvasId: 'a', frameId: 'f1' }] }],
          children: [],
        },
      ],
    },
  ],
  totals: { entries: 3, frames: 3, duplicates: 1, unclassified: 1, pages: 1 },
  duplicates: [{ keep: 'a:f1', dropped: { canvasId: 'b', frameId: 'g1', name: 'AI hero' }, reason: 'same-html' }],
  unclassified: [{ key: 'b:g2', label: 'Odd one', frames: [{ canvasId: 'b', frameId: 'g2' }] }],
  fallback: false,
}

const state = { curations: [] as CurationJobView[] }
const api = {
  listCurations: vi.fn(async () => ({ curations: state.curations })),
  curationSources: vi.fn(async () => ({
    sources: [
      { id: 'a', name: 'Design Library', frames: 1333, library: true },
      { id: 'b', name: 'Design Library · B Sections & screens', frames: 2062, library: false },
    ],
    max: 8,
  })),
  startCuration: vi.fn(async (_ids: string[], _name?: string) => job('gathering')),
  curation: vi.fn(async () => job('gathering')),
  curationPlan: vi.fn(async () => PLAN),
  curationItems: vi.fn(async () => ({
    items: [{ key: 'a:f1', label: 'AI hero', frames: [{ canvasId: 'a', frameId: 'f1' }], text: '', variants: 0 }],
    total: 1,
  })),
  editCuration: vi.fn(async (_id: string, _edits: unknown[]) => PLAN),
  applyCuration: vi.fn(async (_id: string, _keep: boolean) => job('applying', { progress: { done: 0, total: 3 } })),
  cancelCuration: vi.fn(async () => job('cancelled')),
  retryCuration: vi.fn(async () => job('classifying')),
}
vi.mock('../src/lib/api', () => ({ api, ApiError: class extends Error {} }))
vi.mock('../src/lib/navigate', () => ({ navigate: vi.fn() }))

const { CurateLibraryModal } = await import('../src/components/library/CurateLibraryModal')

let root: Root
let host: HTMLDivElement
const onClose = vi.fn()

async function mount(initialSources?: string[]) {
  await act(async () =>
    root.render(<CurateLibraryModal onClose={onClose} {...(initialSources ? { initialSources } : {})} />),
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  state.curations = []
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.clearAllMocks()
})

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!

it('starts a run on the ticked canvases, in the order ticked, and shows its progress', async () => {
  await mount(['b'])
  const boxes = document.querySelectorAll<HTMLInputElement>('[data-testid="curate-sources"] input[type="checkbox"]')
  expect(boxes).toHaveLength(2)
  expect(boxes[1]!.checked).toBe(true)
  await act(async () => boxes[0]!.click())
  expect(document.body.textContent).toContain('About 58 model calls on your own account for 3395 frames.')
  await act(async () => button('Start').click())
  expect(api.startCuration).toHaveBeenCalledWith(['b', 'a'], undefined)
  const progress = document.querySelector('[data-testid="curate-progress"]')!.textContent
  expect(progress).toContain('Reading the canvases')
  expect(progress).toContain('120 of 400')
  expect(progress).toContain('3 model calls')
})

it('picks up a plan waiting for review, edits it and creates the library', async () => {
  state.curations = [job('ready')]
  await mount()
  expect(document.querySelector('[data-testid="curate-totals"]')!.textContent).toContain('1 duplicates removed')
  const tree = document.querySelector('[data-testid="curate-tree"]')!.textContent
  expect(tree).toContain('Heroes')
  expect(tree).toContain('AI products')
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-testid="curate-tree"] button')][1]!.click(),
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  expect(api.curationItems).toHaveBeenLastCalledWith('j1', 'c2')
  expect(document.querySelector('[data-testid="curate-items"]')!.textContent).toContain('AI hero')
  await act(async () => button('Remove category').click())
  expect(api.editCuration).toHaveBeenCalledWith('j1', [{ op: 'delete', id: 'c2' }])
  await act(async () => button('Create library').click())
  expect(api.applyCuration).toHaveBeenCalledWith('j1', true)
  expect(document.querySelector('[data-testid="curate-progress"]')!.textContent).toContain('Copying 0 of 3 frames')
})

it('offers a retry when a run failed', async () => {
  state.curations = [job('failed', { error: 'Reconnect your Claude API key in Settings.' })]
  await mount()
  expect(document.body.textContent).toContain('Reconnect your Claude API key')
  await act(async () => button('Retry from where it stopped').click())
  expect(api.retryCuration).toHaveBeenCalledWith('j1')
})
