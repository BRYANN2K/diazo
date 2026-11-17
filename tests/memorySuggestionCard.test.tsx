// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, MemoryProposal } from '../shared/types'

const calls = vi.hoisted(() => ({
  resolveProposal: vi.fn(() => Promise.resolve({ ok: true })),
}))

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/localRepo', () => ({
  useLocalRepo: (select: (s: { status: Record<string, never> }) => unknown) => select({ status: {} }),
  refreshLocalRepo: vi.fn(() => Promise.resolve({ link: null, online: false, sameDevice: false })),
  hasLocalRepo: () => false,
  linkLocalProject: vi.fn(),
  unlinkLocalProject: vi.fn(),
  repoDeviceId: () => 'device',
}))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: calls }
})

const { MemoryPanel } = await import('../src/components/MemoryPanel')
const { useStore } = await import('../src/lib/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* The rule the distiller proposes from repeated feedback, as a card at the
   top of the Memory tab: what it would add, why, where, and the two answers. */

const PROPOSAL: MemoryProposal = {
  id: 'prop1',
  guideName: 'brand-voice',
  guideTitle: 'Brand voice',
  rule: '- Headlines stay under eight words',
  rationale: 'Three reviews asked for shorter headlines.',
  basedOn: ['d1', 'd2', 'd3'],
  at: 1,
  status: 'pending',
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
  useStore.setState({
    canvas: {
      id: 'c',
      role: 'edit',
      pages: [{ id: 'p', name: 'Page' }],
      frames: [],
      guidelines: [],
    } as unknown as Canvas,
    proposals: [PROPOSAL],
    decisions: [],
  })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const card = () => container.querySelector<HTMLElement>('section[aria-label="Memory suggestion"]')
const button = (name: string) => [...card()!.querySelectorAll('button')].find((b) => b.textContent === name)!

it('shows the rule, the reason and the guide it lands in', () => {
  act(() => root.render(<MemoryPanel />))
  const text = card()?.textContent ?? ''
  expect(text).toContain('Memory suggestion')
  /* the markdown bullet is dropped */
  expect(text).toContain('Headlines stay under eight words')
  expect(text).not.toContain('- Headlines')
  expect(text).toContain('Three reviews asked for shorter headlines.')
  expect(text).toContain('from 3 decisions')
  expect(text).toContain('Brand voice')
})

it('dismisses with false and adds to the rules with true', () => {
  act(() => root.render(<MemoryPanel />))
  act(() => button('Dismiss').click())
  expect(calls.resolveProposal).toHaveBeenLastCalledWith('c', 'prop1', false)
  act(() => button('Add to rules').click())
  expect(calls.resolveProposal).toHaveBeenLastCalledWith('c', 'prop1', true)
})

it('shows no card to a view-only visitor', () => {
  useStore.setState({
    canvas: { id: 'c', role: 'view', pages: [], frames: [], guidelines: [] } as unknown as Canvas,
  })
  act(() => root.render(<MemoryPanel />))
  expect(card()).toBeNull()
})
