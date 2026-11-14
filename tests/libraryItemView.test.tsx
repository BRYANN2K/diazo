// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryItemDetail } from '../shared/library'
import { OTP_RESULT } from './libraryFindFixtures'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* One item with its variants: order, ⌘C, curator-only editing, save, open in canvas, the live cap. */

const base = OTP_RESULT.hits[0]!
const variants = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ...base.variants[0]!, id: `cp.scb-otp-input-v${i}` }))
let detail: LibraryItemDetail
const setLibraryItemMeta = vi.fn(async (_lib: string, _id: string, patch: { tags?: string[] }) => ({
  ...detail,
  item: { ...detail.item, tags: patch.tags ?? detail.item.tags },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/FindPreview', () => ({ FindPreview: () => <iframe title="live" /> }))
vi.mock('../src/lib/api', () => ({
  api: {
    libraryItem: async () => detail,
    setLibraryItemMeta: (lib: string, id: string, patch: { tags?: string[] }) => setLibraryItemMeta(lib, id, patch),
  },
}))
const navigate = vi.fn()
vi.mock('../src/lib/navigate', () => ({ navigate: (to: string) => navigate(to) }))

const { LibraryItemView } = await import('../src/components/library/LibraryItemView')

let root: Root
let host: HTMLDivElement
const writeText = vi.fn(async () => {})

async function mount(curator: boolean) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<LibraryItemView libraryId="lib1" itemId={base.item.id} curator={curator} />))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  detail = {
    libraryId: 'lib1',
    libraryName: 'Design Library',
    item: { ...base.item, description: '', sourceUrl: null, license: 'MIT', findings: [], useCount: 2 },
    variants: variants(3),
    family: null,
  }
  writeText.mockClear()
  navigate.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the item view', () => {
  it('lists the variants in order', async () => {
    await mount(false)
    expect([...host.querySelectorAll('[data-variant-id]')].map((el) => el.getAttribute('data-variant-id'))).toEqual([
      'cp.scb-otp-input-v0',
      'cp.scb-otp-input-v1',
      'cp.scb-otp-input-v2',
    ])
  })

  it('copies the focused card’s id with ⌘C', async () => {
    await mount(false)
    const card = host.querySelector<HTMLElement>('[data-variant-id="cp.scb-otp-input-v1"]')!
    card.focus()
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledWith('cp.scb-otp-input-v1')
  })

  it('shows no edit control to a reader', async () => {
    await mount(false)
    expect(host.querySelector('[data-testid="item-details-form"]')).toBeNull()
  })

  it('saves tags for a curator and shows the result', async () => {
    await mount(true)
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const details = tabs.find((b) => b.textContent === 'Details')!
    await act(async () => {
      details.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      details.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      details.click()
    })
    const tags = document.querySelector<HTMLInputElement>('input[aria-label="Tags"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(tags, 'dark, auth')
      tags.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save')!
    await act(async () => save.click())
    expect(setLibraryItemMeta).toHaveBeenCalledWith(
      'lib1',
      base.item.id,
      expect.objectContaining({ tags: ['dark', 'auth'] }),
    )
  })

  it('opens the item in its canvas', async () => {
    await mount(false)
    const open = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open in canvas')!
    await act(async () => open.click())
    expect(navigate).toHaveBeenCalledWith(`/c/lib1?frame=${base.item.frameId}`)
  })

  it('mounts twelve live previews at most for forty variants', async () => {
    detail = { ...detail, variants: variants(40) }
    await mount(false)
    expect(host.querySelectorAll('iframe').length).toBeLessThanOrEqual(12)
    expect(host.querySelectorAll('[data-variant-id]')).toHaveLength(40)
  })
})
