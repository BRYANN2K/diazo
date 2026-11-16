// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentRunners } from '../shared/agentRunner.ts'
const mocks = vi.hoisted(() => ({ runners: vi.fn(), models: vi.fn(), capture: vi.fn() }))
vi.mock('../src/lib/api', () => ({ api: { agentRunners: mocks.runners, agentModels: mocks.models } }))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: mocks.capture } }))
vi.mock('../src/App', () => ({ navigate: vi.fn() }))
import { ModelPicker } from '../src/components/ModelPicker'
import { currentRunnerPick, RUNNER_PICK_KEY, useRunnerPick } from '../src/lib/runnerPick'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* Both connections at once: the shape the feedback came from, where the
   old picker showed only the GPT list while the Plan ran the task. */
const both: AgentRunners = {
  runners: [
    {
      provider: 'claude-local',
      name: 'Claude Plan',
      online: true,
      model: 'sonnet',
      models: [
        { id: 'opus', name: 'Opus', blurb: 'the big one' },
        { id: 'sonnet', name: 'Sonnet', blurb: 'the everyday one' },
      ],
      efforts: [
        { id: 'medium', name: 'Medium', blurb: '' },
        { id: 'max', name: 'Max', blurb: '' },
      ],
    },
    {
      provider: 'chatgpt',
      name: 'ChatGPT',
      email: 'alice@example.com',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      models: [{ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', blurb: 'the workhorse' }],
      efforts: [{ id: 'medium', name: 'Medium', blurb: '' }],
    },
  ],
  default: 'claude-local',
}

/* a connection whose list flags its recommended entries: the rest folds */
const folded: AgentRunners = {
  runners: [
    {
      provider: 'chatgpt',
      name: 'ChatGPT',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      models: [
        { id: 'gpt-6-astra', name: 'GPT-6 Astra', blurb: '', recommended: true },
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', blurb: '', recommended: true },
        { id: 'gpt-5.5', name: 'GPT-5.5', blurb: '' },
        { id: 'gpt-5', name: 'GPT-5', blurb: '' },
        { id: 'gpt-4.9', name: 'GPT-4.9', blurb: '' },
      ],
      efforts: [{ id: 'medium', name: 'Medium', blurb: '' }],
    },
  ],
  default: 'chatgpt',
}

/* an API key with no effort dial */
const noDial: AgentRunners = {
  runners: [
    {
      provider: 'anthropic-key',
      name: 'Claude API',
      model: 'claude-sonnet-5',
      models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', blurb: '' }],
    },
  ],
  default: 'anthropic-key',
}

let root: Root
let container: HTMLDivElement
const buttons = () => [...container.querySelectorAll('button')]
/* the composer foot is two pills: the model, then the effort */
const trigger = () => buttons()[0]!
const effortButton = () => buttons()[1]
const open = (button: HTMLButtonElement = trigger()) =>
  act(() => {
    /* Radix opens a menu on pointerdown, not click */
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const radios = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
/* a row's label only: rows with a blurb render it under the label */
const labelOf = (el: HTMLElement) =>
  el.querySelector('[data-slot="dropdown-menu-item-text"] > span')?.textContent ?? el.textContent
const radioLabels = () => radios().map(labelOf)
const radio = (label: string) => radios().find((el) => labelOf(el) === label)
const pickItem = (label: string) =>
  act(() => {
    /* a click alone selects; pointerup would add a second one in happy-dom */
    radio(label)!.click()
  })
const search = () => document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const keydown = (el: Element, key: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
const settle = () => act(async () => {})

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  useRunnerPick.setState({ stored: null, runners: null })
  mocks.runners.mockResolvedValue(both)
  mocks.models.mockResolvedValue({ models: [], live: false })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows the default connection’s model on the trigger and every connection in the menu', async () => {
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(trigger().textContent).toBe('Sonnet')
  expect(trigger().getAttribute('aria-label')).toBe('Model: Sonnet')
  await open()
  const text = document.body.textContent ?? ''
  /* several connections: each group is its provider's name, nothing more */
  expect(text).toContain('Claude Plan')
  expect(text).toContain('ChatGPT')
  expect(text).not.toContain('alice@example.com')
  expect(text).not.toContain('· default')
  expect(radio('Opus')).toBeTruthy()
  expect(radio('GPT-5.6 Terra')).toBeTruthy()
  expect(radio('Sonnet')?.getAttribute('aria-checked')).toBe('true')
})

it('sends the next task to the picked connection and remembers it in this browser', async () => {
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  await pickItem('GPT-5.6 Terra')
  /* the model and the effort are two pills now */
  expect(trigger().textContent).toBe('GPT-5.6 Terra')
  expect(effortButton()?.textContent).toBe('Medium')
  expect(currentRunnerPick()).toEqual({ provider: 'chatgpt', model: 'gpt-5.6-terra', effort: 'medium' })
  expect(JSON.parse(localStorage.getItem(RUNNER_PICK_KEY)!)).toEqual({
    provider: 'chatgpt',
    model: 'gpt-5.6-terra',
    effort: 'medium',
  })
  expect(mocks.capture).toHaveBeenCalledWith('agent_runner_picked', {
    provider: 'chatgpt',
    model: 'gpt-5.6-terra',
    via: 'composer',
  })
})

it('keeps a stored pick for the Plan with its effort, and opens the effort’s own menu', async () => {
  useRunnerPick.setState({ stored: { provider: 'claude-local', model: 'opus', effort: 'max' } })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(trigger().textContent).toBe('Opus')
  expect(trigger().getAttribute('aria-label')).toBe('Model: Opus')
  expect(effortButton()?.textContent).toBe('Max')
  expect(effortButton()?.getAttribute('aria-label')).toBe('Reasoning effort: Max')
  expect(currentRunnerPick()).toEqual({ provider: 'claude-local', model: 'opus', effort: 'max' })
  /* the effort menu: the levels as radios, the dial's scale under them */
  await open(effortButton())
  expect(radioLabels()).toEqual(['Default', 'Medium', 'Max'])
  expect(radio('Max')?.getAttribute('aria-checked')).toBe('true')
  expect(menu()!.textContent).toContain('Faster')
  expect(menu()!.textContent).toContain('Smarter')
})

it('picks an effort from its own menu, or Default which sends none', async () => {
  useRunnerPick.setState({ stored: { provider: 'claude-local', model: 'opus' } })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(effortButton()?.textContent).toBe('Default')
  await open(effortButton())
  await pickItem('Medium')
  expect(currentRunnerPick()).toEqual({ provider: 'claude-local', model: 'opus', effort: 'medium' })
  await open(effortButton())
  await pickItem('Default')
  expect(currentRunnerPick()).toEqual({ provider: 'claude-local', model: 'opus' })
  expect(mocks.capture).toHaveBeenCalledWith('agent_effort_changed', {
    effort: 'default',
    provider: 'claude-local',
    via: 'composer',
  })
})

it('hides the effort pill where the connection has no dial', async () => {
  mocks.runners.mockResolvedValue(noDial)
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(trigger().textContent).toBe('Sonnet 5')
  expect(container.querySelectorAll('button')).toHaveLength(1)
})

it('folds the non-recommended entries under "Older (N)", which expands in place', async () => {
  mocks.runners.mockResolvedValue(folded)
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  expect(radioLabels()).toEqual(['GPT-6 Astra', 'GPT-5.6 Terra'])
  const fold = menu()!.querySelector<HTMLElement>('[role="menuitem"][aria-expanded]')!
  expect(fold.textContent).toBe('Older (3)')
  await act(async () => {
    fold.click()
  })
  /* the fold stays in place, the menu open, and the older rows are radios too */
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(radioLabels()).toEqual(['GPT-6 Astra', 'GPT-5.6 Terra', 'GPT-5.5', 'GPT-5', 'GPT-4.9'])
  expect(menu()).toBeTruthy()
})

it('opens a fold on its own when the pick sits inside it', async () => {
  mocks.runners.mockResolvedValue(folded)
  useRunnerPick.setState({ stored: { provider: 'chatgpt', model: 'gpt-5', effort: 'medium' } })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  expect(radio('GPT-5')?.getAttribute('aria-checked')).toBe('true')
  expect(radio('GPT-4.9')).toBeTruthy()
})

it('filters the rows as the search types, folding nothing', async () => {
  mocks.runners.mockResolvedValue(folded)
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  expect(search()).toBeTruthy()
  type(search()!, 'gpt-5')
  expect(radioLabels()).toEqual(['GPT-5.6 Terra', 'GPT-5.5', 'GPT-5'])
  /* an older row surfaces without opening the fold */
  expect(menu()!.textContent).not.toContain('Older')
  type(search()!, 'zzz')
  expect(radios()).toHaveLength(0)
  expect(menu()!.textContent).toContain('No model matches')
})

it('takes the search’s first row on Enter', async () => {
  mocks.runners.mockResolvedValue(folded)
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  type(search()!, '5.5')
  keydown(search()!, 'Enter')
  expect(currentRunnerPick()).toEqual({ provider: 'chatgpt', model: 'gpt-5.5', effort: 'medium' })
})

it('falls back to the default when the stored connection is gone', async () => {
  useRunnerPick.setState({ stored: { provider: 'chatgpt', model: 'gpt-5.6-terra' } })
  mocks.runners.mockResolvedValue({ runners: [both.runners[0]!], default: 'claude-local' })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(trigger().textContent).toBe('Sonnet')
  expect(currentRunnerPick()).toEqual({ provider: 'claude-local', model: 'sonnet' })
})

it('says so with nothing connected, and carries no pick', async () => {
  mocks.runners.mockResolvedValue({ runners: [] })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  expect(trigger().textContent).toBe('Diazo Agent')
  expect(currentRunnerPick()).toBeUndefined()
  await open()
  expect(document.body.textContent).toContain('Nothing connected yet')
  expect(document.body.textContent).toContain('Connect a model…')
})

it('says beside its name when a desktop connection is not running', async () => {
  mocks.runners.mockResolvedValue({ ...both, runners: [{ ...both.runners[0]!, online: false }, both.runners[1]!] })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  const captions = [...document.querySelectorAll('[data-slot="dropdown-menu-caption"]')].map((el) => el.textContent)
  expect(captions).toContain('Claude Plan · Desktop app not running')
  expect(captions).toContain('ChatGPT')
})

it('does nothing on Enter with an empty search: the pick stays', async () => {
  mocks.runners.mockResolvedValue(folded)
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  keydown(search()!, 'Enter')
  expect(currentRunnerPick()).toEqual({ provider: 'chatgpt', model: 'gpt-5.6-terra', effort: 'medium' })
  expect(mocks.capture).not.toHaveBeenCalled()
  expect(menu()).toBeTruthy()
})

it('focuses the search on open, and ↓ / ↑ from it land on the first / last row', async () => {
  mocks.runners.mockResolvedValue(folded)
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(document.activeElement).toBe(search())
  keydown(search()!, 'ArrowDown')
  expect(document.activeElement).toBe(radio('GPT-6 Astra'))
  /* ↑ on the first row goes back to the field */
  keydown(radio('GPT-6 Astra')!, 'ArrowUp')
  expect(document.activeElement).toBe(search())
  /* ↑ from the field wraps to the list's last row: here the fold */
  keydown(search()!, 'ArrowUp')
  expect(document.activeElement?.textContent).toBe('Older (3)')
})

it('sends what is typed on a row back to the search, not to the menu’s typeahead', async () => {
  mocks.runners.mockResolvedValue(folded)
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  const row = radio('GPT-5.6 Terra')!
  act(() => row.focus())
  keydown(row, '5')
  expect(search()!.value).toBe('5')
  expect(document.activeElement).toBe(search())
  /* the fold, the foot: anywhere in the menu */
  const settings = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (el) => el.textContent === 'Model settings…',
  )!
  act(() => settings.focus())
  keydown(settings, '.')
  keydown(settings, '5')
  expect(search()!.value).toBe('5.5')
  expect(radioLabels()).toEqual(['GPT-5.5'])
  keydown(settings, 'Backspace')
  expect(search()!.value).toBe('5.')
})

it('matches a connection’s name in the search', async () => {
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  type(search()!, 'chatgpt')
  expect(radioLabels()).toEqual(['GPT-5.6 Terra'])
  type(search()!, 'claude')
  expect(radioLabels()).toEqual(['Opus', 'Sonnet'])
})

it('lists a pick the catalog does not know without writing it into the catalog', async () => {
  useRunnerPick.setState({ stored: { provider: 'claude-local', model: 'claude-opus-4-1' } })
  await act(async () => root.render(<ModelPicker />))
  await settle()
  await open()
  expect(radioLabels()[0]).not.toBe('Opus')
  expect(radios()[0]?.getAttribute('aria-checked')).toBe('true')
  /* the phantom row is the menu's alone: the store's list is untouched */
  expect(useRunnerPick.getState().runners?.runners[0]?.models.map((m) => m.id)).toEqual(['opus', 'sonnet'])
  pickItem('Opus')
  await open()
  expect(radioLabels()).toEqual(['Opus', 'Sonnet', 'GPT-5.6 Terra'])
})
