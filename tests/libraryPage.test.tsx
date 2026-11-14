// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryDetail, LibrarySearchResult } from '../shared/library'
import type { LibrarySearchQuery } from '../src/lib/api'
import { OTP_RESULT } from './libraryFindFixtures'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The gallery against a mocked API: category filter in the URL, one ask for
   the next page, status badges for curators only. */

const libraryItems = vi.fn<(id: string, q: LibrarySearchQuery) => Promise<LibrarySearchResult>>()
let role: LibraryDetail['role'] = 'manage'
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/AppRail', () => ({ AppRail: () => null, railLayout: '' }))
vi.mock('../src/components/FindPreview', () => ({ FindPreview: () => <span data-live /> }))
vi.mock('../src/lib/api', () => ({
  api: {
    getLibraryDetail: async () => ({
      id: 'lib1',
      name: 'Design Library',
      role,
      library: { description: '', visibility: 'private', items: 2, variants: 3, index: null, rulesVersion: 1 },
      workspaceId: null,
      listed: false,
      rules: {},
      rulesText: [],
      taxonomy: { kinds: [], sources: [], categories: [] },
    }),
    libraryItems: (id: string, q: LibrarySearchQuery) => libraryItems(id, q),
  },
}))

const { LibraryPage } = await import('../src/pages/LibraryPage')

const draftResult = (cursor?: string): LibrarySearchResult => ({
  ...OTP_RESULT,
  hits: [
    { ...OTP_RESULT.hits[0]! },
    {
      ...OTP_RESULT.hits[0]!,
      item: { ...OTP_RESULT.hits[0]!.item, id: 'cp.scb-draft', status: 'draft' },
      variantCount: 0,
    },
  ],
  facets: {
    ...OTP_RESULT.facets,
    category: [
      { value: 'Inputs & forms', label: 'Inputs & forms', count: 2 },
      { value: 'Auth', label: 'Auth', count: 1 },
    ],
  },
  ...(cursor ? { cursor } : {}),
})

let root: Root
let host: HTMLDivElement

async function mount() {
  history.replaceState(null, '', '/l/lib1')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<LibraryPage libraryId="lib1" itemId={null} />))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

beforeEach(() => {
  role = 'manage'
  libraryItems.mockReset()
  libraryItems.mockImplementation(async () => draftResult())
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the gallery', () => {
  it('filters by category and keeps the view in the URL', async () => {
    await mount()
    const auth = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="library-categories-nav"] button')].find(
      (b) => b.textContent?.startsWith('Auth'),
    )!
    await act(async () => auth.click())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(libraryItems).toHaveBeenLastCalledWith('lib1', expect.objectContaining({ category: ['Auth'] }))
    expect(location.search).toBe('?in=Auth')
  })

  it('asks for the next page once', async () => {
    libraryItems.mockImplementation(async (_id, q) => draftResult(q.cursor ? undefined : '60'))
    await mount()
    /* two tiles fill less than the viewport: the end is in view at once */
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    const withCursor = libraryItems.mock.calls.filter(([, q]) => q.cursor === '60')
    expect(withCursor).toHaveLength(1)
  })

  it('shows a draft badge to curators only', async () => {
    await mount()
    expect(host.querySelector('[data-item-id="cp.scb-draft"]')!.textContent).toContain('Draft')
    await act(async () => root.unmount())
    host.remove()
    role = 'read'
    await mount()
    expect(host.querySelector('[data-item-id="cp.scb-draft"]')!.textContent).not.toContain('Draft')
  })

  it('mounts no live preview until a tile is rested on', async () => {
    await mount()
    expect(host.querySelector('[data-live]')).toBeNull()
  })
})
