// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  codeLinks: vi.fn(),
  putCodeLink: vi.fn(),
  deleteCodeLink: vi.fn(),
  suggestCodeLinks: vi.fn(),
}))

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: calls }
})

const { CodeLinkSection } = await import('../src/components/CodeLinkSection')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const LINK = {
  id: 'l1',
  canvasId: 'c1',
  targetKind: 'component',
  targetId: 'btn',
  path: 'src/ui/Button.tsx',
  exportName: 'Button',
  source: 'manual',
  updatedBy: 'Bryan',
  updatedAt: 0,
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(kind: 'component' | 'frame', id: string) {
  await act(async () => {
    root.render(<CodeLinkSection canvasId="c1" canEdit target={{ kind, id, name: 'Button' }} />)
  })
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement

it('shows the target’s mapping as path#export', async () => {
  calls.codeLinks.mockResolvedValue({ links: [LINK] })
  await render('component', 'btn')
  expect(container.textContent).toContain('src/ui/Button.tsx#Button')
  expect(container.textContent).toContain('Component “Button”')
})

it('suggests from the repo and saves the pick as suggested', async () => {
  calls.codeLinks.mockResolvedValue({ links: [] })
  calls.suggestCodeLinks.mockResolvedValue({
    suggestions: [{ path: 'src/pages/Home.tsx', exportName: 'Home', score: 1, reason: 'export+file' }],
    repo: 'site',
    truncated: false,
  })
  calls.putCodeLink.mockResolvedValue({
    link: { ...LINK, targetKind: 'frame', targetId: 'f1', path: 'src/pages/Home.tsx', exportName: 'Home' },
  })
  await render('frame', 'f1')
  expect(container.textContent).toContain('Not mapped to a file yet')
  await act(async () => button('Suggest from repo').click())
  expect(calls.suggestCodeLinks).toHaveBeenCalledWith('c1', 'frame', 'f1')
  await act(async () => button('Use').click())
  expect(calls.putCodeLink).toHaveBeenCalledWith('c1', {
    targetKind: 'frame',
    targetId: 'f1',
    path: 'src/pages/Home.tsx',
    exportName: 'Home',
    source: 'suggested',
  })
  expect(container.textContent).toContain('src/pages/Home.tsx#Home')
})
