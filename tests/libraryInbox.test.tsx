// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OTP_RESULT } from './libraryFindFixtures'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The inbox: accept takes an item out, Keep this one hides the other. */

const base = OTP_RESULT.hits[0]!.item
const ITEMS = [
  {
    ...base,
    id: 'cp.a-draft',
    status: 'draft' as const,
    findings: [{ kind: 'lint' as const, message: 'Lint score 40', score: 40 }],
  },
  {
    ...base,
    id: 'cp.a-copy',
    findings: [{ kind: 'duplicate' as const, message: 'Same content as cp.a-original.', itemId: 'cp.a-original' }],
  },
]
const setLibraryItemsStatus = vi.fn(async () => ({ changed: 1 }))
vi.mock('../src/lib/api', () => ({
  api: {
    libraryInbox: async () => ({ drafts: 1, items: ITEMS }),
    setLibraryItemsStatus: (...args: unknown[]) => setLibraryItemsStatus(...(args as [])),
    reindexLibrary: async () => ({}),
  },
}))

const { LibraryInbox } = await import('../src/components/library/LibraryInbox')

let root: Root
let host: HTMLDivElement
beforeEach(async () => {
  setLibraryItemsStatus.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<LibraryInbox libraryId="lib1" />))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!

describe('the inbox', () => {
  it('accepts a draft, which then leaves the list', async () => {
    const box = host.querySelector<HTMLInputElement>('input[aria-label="cp.a-draft"]')!
    await act(async () => box.click())
    await act(async () => button('Accept').click())
    expect(setLibraryItemsStatus).toHaveBeenCalledWith('lib1', ['cp.a-draft'], 'active')
    expect(host.querySelector('[data-inbox-item="cp.a-draft"]')).toBeNull()
  })

  it('hides the other one of a duplicate', async () => {
    await act(async () => button('Keep this one').click())
    expect(setLibraryItemsStatus).toHaveBeenCalledWith('lib1', ['cp.a-original'], 'hidden')
  })
})
