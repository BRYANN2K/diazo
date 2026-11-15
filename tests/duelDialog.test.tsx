// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunners } from '../shared/agentRunner.ts'
import { CLAUDE_EFFORT_OPTIONS, CLAUDE_PLAN_MODELS } from '../shared/localAgent.ts'
const mocks = vi.hoisted(() => ({ runners: vi.fn(), startDuel: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: { agentRunners: mocks.runners, startDuel: mocks.startDuel },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
import { DuelDialog, duelChoices, duelGroups, filterDuelGroups } from '../src/components/DuelDialog'
import { useRunnerPick } from '../src/lib/runnerPick'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* the Plan as the server lists it: the aliases, then every pinned id, and no
   configured effort (the CLI's own setting) */
const plan = {
  provider: 'claude-local' as const,
  name: 'Claude Plan',
  online: true,
  model: 'sonnet',
  models: CLAUDE_PLAN_MODELS,
  efforts: CLAUDE_EFFORT_OPTIONS,
}
const efforts = [
  { id: 'low', name: 'Low', blurb: '' },
  { id: 'medium', name: 'Medium', blurb: '' },
  { id: 'high', name: 'High', blurb: '' },
  { id: 'xhigh', name: 'Extra high', blurb: '' },
]
const chatgpt = {
  provider: 'chatgpt' as const,
  name: 'ChatGPT',
  email: 'alice@example.com',
  model: 'gpt-5.6-terra',
  effort: 'medium',
  models: [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', blurb: 'The flagship' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', blurb: '' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', blurb: '' },
  ],
  efforts,
}
/* an API key with no effort dial */
const claudeKey = {
  provider: 'anthropic-key' as const,
  name: 'Claude API',
  model: 'claude-sonnet-5',
  models: [
    { id: 'claude-sonnet-5', name: 'Sonnet 5', blurb: '' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', blurb: '' },
  ],
}
/* a connection this build has no tile for: grouped and picked all the same */
const gateway = {
  provider: 'custom:gw1' as const,
  name: 'My Gateway',
  model: 'gw-large',
  models: [{ id: 'gw-large', name: 'GW Large', blurb: '' }],
}
const runners: AgentRunners = { runners: [plan, chatgpt, claudeKey, gateway], default: 'chatgpt' }

let root: Root
let container: HTMLDivElement
const settle = () => act(async () => {})

beforeEach(() => {
  vi.resetAllMocks()
  useRunnerPick.setState({ stored: null, runners: null })
  mocks.runners.mockResolvedValue(runners)
  mocks.startDuel.mockResolvedValue({})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const dialog = () => document.querySelector('[role="dialog"]')!
const box = (label: string) => dialog().querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`)
const check = (label: string) => act(() => box(label)!.click())
const effortTrigger = (label: string) =>
  dialog().querySelector<HTMLButtonElement>(`button[aria-label="Reasoning effort for ${label}"]`)
const chooseEffort = async (label: string, level: string) => {
  act(() => {
    effortTrigger(label)!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }),
    )
  })
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) =>
    el.textContent?.startsWith(level),
  )!
  await act(async () => {
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    item.click()
  })
}
const button = (text: string) => [...dialog().querySelectorAll('button')].find((el) => el.textContent === text)!
const slots = () => [...dialog().querySelectorAll<HTMLElement>('[data-contestant]')]
const search = (text: string) =>
  act(() => {
    const input = dialog().querySelector<HTMLInputElement>('input[aria-label="Search models"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const render = async (brief = 'A pricing hero') => {
  await act(async () => root.render(<DuelDialog canvasId="c1" brief={brief} onClose={() => {}} onStarted={() => {}} />))
  await settle()
}

describe('duelGroups', () => {
  it('groups the models by connection and offers every Claude model the Plan knows', () => {
    const groups = duelGroups(runners)
    expect(groups.map((g) => g.runner.name)).toEqual(['Claude Plan', 'ChatGPT', 'Claude API', 'My Gateway'])
    const planIds = groups[0]!.choices.map((c) => c.model.id)
    /* the aliases ("Latest Opus") and every pinned id, versions included */
    expect(planIds).toEqual(CLAUDE_PLAN_MODELS.map((m) => m.id).filter((id) => id !== 'default'))
    expect(planIds).toEqual(expect.arrayContaining(['opus', 'claude-fable-5-2', 'claude-opus-5-5', 'claude-haiku-4-5']))
    expect(groups[0]!.choices[1]).toMatchObject({ label: 'Claude Plan · Latest Opus' })
    /* "Claude Code default" is whatever the CLI is set to, not a contestant */
    expect(duelChoices(runners).some((c) => c.model.id === 'default')).toBe(false)
  })

  it('keeps a configured model the menu does not list as a choice', () => {
    const pinned = { ...plan, model: 'claude-opus-5-20260901' }
    expect(duelChoices({ runners: [pinned] }).map((c) => c.model.id)).toContain('claude-opus-5-20260901')
  })

  it('has nothing to offer with no connections, and never throws on a missing list', () => {
    expect(duelGroups(null)).toEqual([])
    expect(duelChoices({ runners: [] })).toEqual([])
  })

  it('narrows by model name or id, and keeps a whole connection named in the query', () => {
    const groups = duelGroups(runners)
    expect(filterDuelGroups(groups, 'sol').map((g) => g.choices.map((c) => c.model.id))).toEqual([['gpt-6.1-sol']])
    expect(filterDuelGroups(groups, 'opus 5.5').flatMap((g) => g.choices.map((c) => c.key))).toEqual([
      'claude-local|claude-opus-5-5',
      'anthropic-key|claude-opus-5-5',
    ])
    expect(filterDuelGroups(groups, 'claude plan')[0]!.choices).toHaveLength(groups[0]!.choices.length)
    expect(filterDuelGroups(groups, '   ')).toBe(groups)
  })
})

describe('the duel dialog', () => {
  it('lists each connection under its own heading, searchable', async () => {
    await render()
    const headings = [...dialog().querySelectorAll('[role="group"] [role="group"]')].map((g) =>
      g.getAttribute('aria-label'),
    )
    expect(headings).toEqual(['Claude Plan', 'ChatGPT', 'Claude API', 'My Gateway'])
    expect(dialog().textContent).not.toContain('Claude Code default')
    await search('terra')
    expect(box('ChatGPT · GPT-5.6 Terra')).toBeTruthy()
    expect(box('ChatGPT · GPT-6 Astra')).toBeNull()
    expect(box('Claude Plan · Latest Opus')).toBeNull()
    await search('nothing like this')
    expect(dialog().textContent).toContain('No model matches “nothing like this”.')
  })

  it('fills contestant slots A to C, and holds the list once three are picked', async () => {
    await render()
    expect(slots()).toHaveLength(0)
    check('Claude Plan · Opus 5.5')
    check('ChatGPT · GPT-6.1 Sol')
    check('My Gateway · GW Large')
    expect(slots().map((s) => [s.dataset.contestant, s.textContent?.includes('Opus 5.5')])).toEqual([
      ['A', true],
      ['B', false],
      ['C', false],
    ])
    expect(dialog().textContent).toContain('3 of 3 picked')
    expect(box('Claude API · Sonnet 5')!.disabled).toBe(true)
    expect(dialog().textContent).toContain('Three models picked. Remove one to pick another.')
    /* removing a contestant frees a slot */
    act(() => {
      dialog().querySelector<HTMLButtonElement>('button[aria-label="Remove ChatGPT · GPT-6.1 Sol"]')!.click()
    })
    expect(slots()).toHaveLength(2)
    expect(box('Claude API · Sonnet 5')!.disabled).toBe(false)
  })

  it('shows each contestant’s effort at its connection’s setting, and none where there is no dial', async () => {
    await render()
    check('Claude Plan · Latest Opus')
    check('ChatGPT · GPT-5.6 Terra')
    check('Claude API · Sonnet 5')
    expect(effortTrigger('ChatGPT · GPT-5.6 Terra')!.textContent).toBe('Medium')
    /* a Plan with no configured effort runs the CLI's own setting: Default, not Low */
    expect(effortTrigger('Claude Plan · Latest Opus')!.textContent).toBe('Default')
    expect(effortTrigger('Claude API · Sonnet 5')).toBeNull()
  })

  it('sends each contestant’s pick with the effort chosen for it, or the connection’s own', async () => {
    const onClose = vi.fn()
    const onStarted = vi.fn()
    await act(async () =>
      root.render(<DuelDialog canvasId="c1" brief="A pricing hero" onClose={onClose} onStarted={onStarted} />),
    )
    await settle()
    check('Claude Plan · Latest Opus')
    check('ChatGPT · GPT-5.6 Terra')
    check('ChatGPT · GPT-6 Astra')
    await chooseEffort('Claude Plan · Latest Opus', 'Max')
    await chooseEffort('ChatGPT · GPT-5.6 Terra', 'Extra high')
    expect(effortTrigger('ChatGPT · GPT-5.6 Terra')!.textContent).toBe('Extra high')
    await act(async () => button('Start with 3 models').click())
    expect(mocks.startDuel).toHaveBeenCalledWith(
      'c1',
      'A pricing hero',
      [
        { provider: 'claude-local', model: 'opus', effort: 'max' },
        { provider: 'chatgpt', model: 'gpt-5.6-terra', effort: 'xhigh' },
        /* untouched: the account's configured medium */
        { provider: 'chatgpt', model: 'gpt-6-astra', effort: 'medium' },
      ],
      undefined,
    )
    expect(onStarted).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('sends no effort for a Plan contestant left on Default', async () => {
    await render('A hero')
    check('Claude Plan · Fable 5.2')
    check('ChatGPT · GPT-6.1 Sol')
    await act(async () => button('Start with 2 models').click())
    expect(mocks.startDuel).toHaveBeenCalledWith(
      'c1',
      'A hero',
      [
        { provider: 'claude-local', model: 'claude-fable-5-2' },
        { provider: 'chatgpt', model: 'gpt-6.1-sol', effort: 'medium' },
      ],
      undefined,
    )
  })
})
