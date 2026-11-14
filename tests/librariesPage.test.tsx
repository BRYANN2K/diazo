// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LibraryListEntry } from '../shared/library'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The Libraries page: a tile per library with its counts, the empty state
   whose action asks which canvas to convert. */

const listLibraries = vi.fn<() => Promise<{ libraries: LibraryListEntry[] }>>()
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/AppRail', () => ({ AppRail: () => null, railLayout: '' }))
vi.mock('../src/lib/api', () => ({
  api: {
    listLibraries: () => listLibraries(),
    libraryItems: async () => ({ hits: [], total: 0, facets: { kind: [], category: [], source: [], tag: [] } }),
    listCanvases: async () => [{ id: 'c9', name: 'Sheets canvas' }],
  },
}))

const { Libraries } = await import('../src/pages/Libraries')

let root: Root
let host: HTMLDivElement

async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Libraries />))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => listLibraries.mockReset())
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const entry = (id: string, items: number, variants: number): LibraryListEntry => ({
  id,
  name: `Library ${id}`,
  library: { description: '', visibility: 'private', items, variants, index: null, rulesVersion: 1 },
  role: 'manage',
  workspaceId: null,
  listed: false,
})

it('shows a tile per library with its counts', async () => {
  listLibraries.mockResolvedValue({ libraries: [entry('a', 12, 40), entry('b', 1, 0)] })
  await mount()
  const tiles = host.querySelectorAll('[data-library-id]')
  expect(tiles).toHaveLength(2)
  expect(tiles[0]!.textContent).toContain('12 families')
  expect(tiles[0]!.textContent).toContain('40 variants')
  expect(tiles[1]!.textContent).toContain('1 family')
})

it('offers to turn a canvas into a library when there is none', async () => {
  listLibraries.mockResolvedValue({ libraries: [] })
  await mount()
  expect(host.textContent).toContain('No design library yet')
  const action = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Turn a canvas into a library')!
  await act(async () => action.click())
  expect(document.body.textContent).toContain('Which canvas?')
})
