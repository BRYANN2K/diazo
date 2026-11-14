// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types'
import { OTP_RESULT } from './libraryFindFixtures'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* "Use" from the gallery, and the canvas picking the block it inserted. */

const insertLibraryItem = vi.fn()
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/api', () => ({
  api: { insertLibraryItem: (...args: unknown[]) => insertLibraryItem(...args), listCanvases: async () => [] },
}))
const navigate = vi.fn()
vi.mock('../src/lib/navigate', () => ({ navigate: (to: string) => navigate(to) }))

const { UseItemButton, insertedUrl } = await import('../src/components/library/UseItemButton')
const { pickInsertedBlock, useInsertedBox } = await import('../src/lib/insertedBox')
const { useStore } = await import('../src/lib/store')

let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  insertLibraryItem.mockReset()
  navigate.mockReset()
})

const item = OTP_RESULT.hits[0]!.variants[1]!

async function mount() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <UseItemButton libraryId="lib1" item={item} origin={{ from: 'proj', frame: 'f9', frameName: 'Login' }} />,
    ),
  )
  return host.querySelector('button')!
}

describe('Use from the gallery', () => {
  it('names the frame, inserts and goes back with the block', async () => {
    insertLibraryItem.mockResolvedValue({ elementId: 'abc123', frameId: 'f9', canvasId: 'proj', fidelity: 'static' })
    const button = await mount()
    expect(button.textContent).toBe('Use in « Login »')
    await act(async () => button.click())
    expect(insertLibraryItem).toHaveBeenCalledWith('lib1', item.id, { frameId: 'f9' })
    expect(navigate).toHaveBeenCalledWith(
      insertedUrl({ canvasId: 'proj', frameId: 'f9', elementId: 'abc123' }, item.id),
    )
  })

  it('stays and says so when the insert fails', async () => {
    insertLibraryItem.mockRejectedValue(new Error('nope'))
    const button = await mount()
    await act(async () => button.click())
    expect(navigate).not.toHaveBeenCalled()
    expect(host!.querySelector('[role="alert"]')!.textContent).toBe('Could not insert this item.')
  })

  it('picks the inserted block on the canvas and opens its box', () => {
    useStore.setState({
      canvas: {
        id: 'proj',
        name: 'Project',
        createdAt: 1,
        updatedAt: 1,
        frames: [{ id: 'f9', name: 'Login', html: '<div data-doop-id="abc123"></div>' }],
      } as unknown as Canvas,
    })
    pickInsertedBlock({ frameId: 'f9', elementId: 'abc123', ref: item.id })
    expect(useStore.getState().selectedElement).toMatchObject({ frameId: 'f9', selector: '[data-doop-id="abc123"]' })
    expect(useInsertedBox.getState().item).toMatchObject({ elementId: 'abc123', ref: item.id })
  })
})
