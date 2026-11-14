// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types'
import type { CanvasSkill } from '../shared/skills'

const calls = vi.hoisted(() => ({
  setSkill: vi.fn(() => Promise.resolve({ ok: true })),
  deleteSkill: vi.fn(() => Promise.resolve({ ok: true, deleted: true })),
  sendChat: vi.fn(() => Promise.resolve({})),
  agentRunners: vi.fn(() => Promise.resolve({ runners: [] })),
  agentModels: vi.fn(() => Promise.resolve({ models: [] })),
}))

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/TeamAllowance', () => ({ isResidentLimit: () => false }))
vi.mock('../src/lib/localRepo', () => ({
  useLocalRepo: (select: (s: { status: Record<string, never> }) => unknown) => select({ status: {} }),
  refreshLocalRepo: vi.fn(() => Promise.resolve({ link: null, online: false, sameDevice: false })),
  hasLocalRepo: () => false,
}))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: calls }
})

const { SkillModal } = await import('../src/components/SkillModal')
const { ChatPanel } = await import('../src/components/ChatPanel')
const { useStore } = await import('../src/lib/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SKILL: CanvasSkill = {
  name: 'pricing-page',
  description: 'When asked for a pricing page',
  markdown: 'Three tiers.',
  updatedAt: 1,
  updatedBy: 'Bryan',
}

let container: HTMLDivElement
let root: Root
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

const canvas = (skills: CanvasSkill[] = []) =>
  ({ id: 'c', role: 'edit', pages: [{ id: 'p', name: 'Page' }], frames: [], skills }) as unknown as Canvas

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const buttonByText = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement

it('creates a skill with its slug, description and instructions', async () => {
  useStore.setState({ canvas: canvas() })
  act(() => root.render(<SkillModal canvasId="c" name={null} onClose={() => {}} />))
  const [name, description] = [...document.querySelectorAll<HTMLInputElement>('input')]
  act(() => type(name!, 'Pricing Page'))
  act(() => type(description!, 'When asked for a pricing page'))
  act(() => type(document.querySelector('textarea')!, 'Three tiers.'))
  expect(document.body.textContent).toContain('/pricing-page')
  await act(async () => buttonByText('Save').click())
  expect(calls.setSkill).toHaveBeenCalledWith('c', 'pricing-page', {
    description: 'When asked for a pricing page',
    markdown: 'Three tiers.',
  })
})

it('the composer shows the / menu only when the canvas has skills', () => {
  useStore.setState({ canvas: canvas(), chat: [] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.querySelector('button[aria-label="Use a skill"]')).toBeNull()
  act(() => useStore.setState({ canvas: canvas([SKILL]) }))
  expect(container.querySelector('button[aria-label="Use a skill"]')).not.toBeNull()
})

it('picking a skill writes /name into the ask', async () => {
  useStore.setState({ canvas: canvas([SKILL]), chat: [] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  const trigger = container.querySelector('button[aria-label="Use a skill"]') as HTMLButtonElement
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.includes('/pricing-page'),
  ) as HTMLElement | undefined
  expect(item).toBeTruthy()
  act(() => item!.click())
  expect(container.querySelector('textarea')!.value).toBe('/pricing-page ')
})
