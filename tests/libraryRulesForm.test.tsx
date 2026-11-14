// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SELECTOR, RULE_PRESETS } from '../shared/libraryRules'
import type { LibraryPreview } from '../shared/library'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The rules editor: a preview per settled edit, errors under their field,
   no save while invalid, saving sends the rules. */

const preview = (variants: number): LibraryPreview => ({
  frames: 3,
  families: 3,
  variants,
  scripted: 0,
  ignored: [],
  unreadable: [],
  duplicates: [],
  categories: [],
  taxonomy: { kinds: [], sources: [], categories: [] },
})
const previewLibrary = vi.fn(
  async (_id: string, opts: { rules?: { detect: { variants: { mode: string } } } } = {}) => ({
    preset: 'sheets',
    rules: {},
    preview: preview(opts.rules?.detect.variants.mode === 'none' ? 0 : 2),
  }),
)
const updateLibrary = vi.fn(async () => ({}))
vi.mock('../src/lib/api', () => ({
  api: {
    previewLibrary: (id: string, opts?: { rules?: { detect: { variants: { mode: string } } } }) =>
      previewLibrary(id, opts),
    updateLibrary: (...args: unknown[]) => updateLibrary(...(args as [])),
  },
}))

const { LibraryRulesForm, PREVIEW_DEBOUNCE_MS } = await import('../src/components/library/LibraryRulesForm')

let root: Root
let host: HTMLDivElement

async function mount(rules = RULE_PRESETS.sheets) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<LibraryRulesForm libraryId="lib1" rules={structuredClone(rules)} />))
}

async function type(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  previewLibrary.mockClear()
  updateLibrary.mockClear()
})
afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root.unmount())
  host.remove()
})

const selectorRules = () => {
  const r = structuredClone(RULE_PRESETS.sheets)
  r.detect.variants = { mode: 'selectors', cell: '.g > div', id: '.m b' }
  return r
}
const saveButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save')!

describe('the rules editor', () => {
  it('asks for one preview per 400 ms of edits', async () => {
    await mount(selectorRules())
    const baseline = previewLibrary.mock.calls.length
    await type('Cell', '.g >')
    await type('Cell', '.g > d')
    await type('Cell', '.g > div')
    expect(previewLibrary.mock.calls.length).toBe(baseline)
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 10)
    })
    expect(previewLibrary.mock.calls.length).toBe(baseline + 1)
  })

  it('shows a parser error under its field and disables Save', async () => {
    await mount(selectorRules())
    await type('Cell', 'x'.repeat(MAX_SELECTOR + 1))
    expect(host.querySelector('[data-error-for="detect.variants.cell"]')).not.toBeNull()
    expect(saveButton().disabled).toBe(true)
  })

  it('saves the edited rules', async () => {
    await mount()
    await type('Default kind', 'cp')
    await act(async () => saveButton().click())
    expect(updateLibrary).toHaveBeenCalledWith(
      'lib1',
      expect.objectContaining({
        rules: expect.objectContaining({ ids: expect.objectContaining({ defaultKind: 'cp' }) }),
      }),
    )
  })

  it('shows the variant count dropping to 0 before saving when variants are turned off', async () => {
    await mount()
    await act(async () => {
      await Promise.resolve()
    })
    const none = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'None')!
    await act(async () => none.click())
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 10)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="rules-preview"]')!.textContent).toContain('Variants: 2 → 0')
  })
})
