// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunners } from '../shared/agentRunner.ts'
import { CLAUDE_EFFORT_OPTIONS, CLAUDE_PLAN_MODELS, isClaudeAlias } from '../shared/localAgent.ts'
const mocks = vi.hoisted(() => ({ runners: vi.fn(), startDuel: vi.fn(), models: vi.fn() }))
vi.mock('../src/lib/api', () => ({
  api: { agentRunners: mocks.runners, startDuel: mocks.startDuel, agentModels: mocks.models },
  errorMessage: (_err: unknown, fallback: string) => fallback,
}))
vi.mock('../src/App', () => ({ navigate: vi.fn() }))
import { DuelDialog, duelChoices, duelGroups, duelRepeats } from '../src/components/DuelDialog'
import { useRunnerPick } from '../src/lib/runnerPick'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/* the Plan as the server lists it: the aliases flagged, every pinned id
   folding under "Older", and no configured effort (the CLI's own setting) */
const plan = {
  provider: 'claude-local' as const,
  name: 'Claude Plan',
  online: true,
  model: 'sonnet',
  models: CLAUDE_PLAN_MODELS.map((m) => (isClaudeAlias(m.id) ? { ...m, recommended: true } : m)),
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
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', blurb: 'The flagship', recommended: true },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', blurb: '' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', blurb: '', recommended: true },
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
  mocks.models.mockResolvedValue({ models: [], live: false })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const dialog = () => document.querySelector('[role="dialog"]')!
const slot = (n: number) => dialog().querySelector<HTMLButtonElement>(`button[data-slot-index="${n}"]`)!
/* the slot's effort pill sits under its model button */
const slotEffort = (n: number) => dialog().querySelector<HTMLButtonElement>(`button[data-effort-index="${n}"]`)
/* the slot card leads with its caption ("Model 1"); the pick is what follows */
const slotPick = (n: number) => slot(n).textContent?.replace(/^Model \d/, '') ?? ''
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
const captions = () =>
  [...menu()!.querySelectorAll('[data-slot="dropdown-menu-caption"]')]
    .map((el) => el.textContent)
    .filter((text) => text !== 'Reasoning effort')
/* Radix opens a menu on pointerdown, not click */
const openMenu = (button: HTMLButtonElement) =>
  act(() => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
const openSlot = (n: number) => openMenu(slot(n))
const openEffort = (n: number) => openMenu(slotEffort(n)!)
const select = async (item: HTMLElement) => {
  await act(async () => {
    /* a click alone selects; pointerup would add a second one in happy-dom */
    item.click()
  })
}
/* the menu's model rows in order, each tagged with the connection caption above it */
const radios = () => {
  let caption = ''
  const rows: { connection: string; model: string; el: HTMLElement }[] = []
  for (const el of menu()!.querySelectorAll<HTMLElement>(
    '[data-slot="dropdown-menu-caption"], [role="menuitemradio"]',
  )) {
    if (el.getAttribute('role') === 'menuitemradio') {
      const label = el.querySelector('[data-slot="dropdown-menu-item-text"] > span')?.textContent ?? el.textContent
      rows.push({ connection: caption, model: label ?? '', el })
    } else caption = el.textContent ?? ''
  }
  return rows
}
const row = (connection: string, model: string) =>
  radios().find((r) => r.connection.startsWith(connection) && r.model === model)
const pick = async (n: number, connection: string, model: string) => {
  await openSlot(n)
  let found = row(connection, model)
  if (!found) {
    /* the pinned ids sit under the connection's "Older" fold */
    for (const el of menu()!.querySelectorAll<HTMLElement>('[role="menuitem"][aria-expanded="false"]')) {
      await select(el)
    }
    found = row(connection, model)
  }
  if (!found) throw new Error(`no ${connection} · ${model} in the menu`)
  await select(found.el)
}
/* an effort by its row's label ("High", "Default") */
const setEffort = async (n: number, label: string) => {
  await openEffort(n)
  const el = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (r) => (r.querySelector('[data-slot="dropdown-menu-item-text"] > span')?.textContent ?? r.textContent) === label,
  )
  if (!el) throw new Error(`no "${label}" effort for slot ${n}`)
  await select(el)
}
const startButton = () =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.startsWith('Start'))!
const render = async (brief = 'A pricing hero', handlers: { onClose?: () => void; onStarted?: () => void } = {}) => {
  await act(async () =>
    root.render(
      <DuelDialog
        canvasId="c1"
        brief={brief}
        onClose={handlers.onClose ?? (() => {})}
        onStarted={handlers.onStarted ?? (() => {})}
      />,
    ),
  )
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

  it('finds the slots that repeat an earlier one, model and effort alike', () => {
    const opus = { provider: 'claude-local' as const, model: 'opus' }
    expect(duelRepeats([opus, undefined, { ...opus }])).toEqual(new Map([[2, 0]]))
    /* the same model at another effort is a fair duel */
    expect(duelRepeats([opus, { ...opus, effort: 'max' }, undefined]).size).toBe(0)
  })
})

describe('the duel dialog', () => {
  it('is the brief with three model slots in its foot, and nothing else', async () => {
    await render()
    expect([1, 2, 3].map((n) => slot(n).textContent)).toEqual(['Model 1', 'Model 2', 'Model 3'])
    expect(slot(3).getAttribute('aria-label')).toBe('Model 3 (optional): pick a model')
    /* the slots live inside the brief's field */
    expect(dialog().querySelector('textarea')!.parentElement!.contains(slot(1))).toBe(true)
    expect(dialog().querySelector('input[type="checkbox"]')).toBeNull()
    expect(dialog().querySelector('input[aria-label="Search models"]')).toBeNull()
    expect(startButton().textContent).toBe('Start duel · 0 models')
    expect(startButton().disabled).toBe(true)
  })

  it('opens the composer’s menus in each slot: model button, effort pill', async () => {
    await render()
    /* nothing picked yet: no effort pill to press */
    expect(slotEffort(1)).toBeNull()
    await openSlot(1)
    expect(captions()).toEqual(['Claude Plan', 'ChatGPT', 'Claude API', 'My Gateway'])
    expect(menu()!.textContent).not.toContain('Claude Code default')
    expect(menu()!.textContent).toContain('Model settings…')
    /* the search field leads the menu; there is no slider */
    expect(menu()!.querySelector('input[aria-label="Search models"]')).toBeTruthy()
    expect(menu()!.querySelector('input[type="range"]')).toBeNull()
    await select(radios().find((r) => r.connection === 'ChatGPT' && r.model === 'GPT-6.1 Sol')!.el)
    expect(slotPick(1)).toBe('GPT-6.1 Sol')
    expect(slot(1).getAttribute('aria-label')).toBe('Model 1: GPT-6.1 Sol')
    expect(slotEffort(1)!.textContent).toBe('Medium')
    expect(slotEffort(1)!.getAttribute('aria-label')).toBe('Model 1 effort: Medium')
    await openSlot(1)
    expect(
      radios()
        .find((r) => r.model === 'GPT-6.1 Sol')!
        .el.getAttribute('aria-checked'),
    ).toBe('true')
    await openEffort(1)
    expect(
      [...menu()!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .find((el) => el.textContent?.startsWith('Medium'))!
        .getAttribute('aria-checked'),
    ).toBe('true')
    expect(menu()!.textContent).toContain('Smarter')
  })

  it('says inside the menu when a desktop connection is not running', async () => {
    mocks.runners.mockResolvedValue({ ...runners, runners: [{ ...plan, online: false }, chatgpt] })
    await render()
    await openSlot(2)
    expect(captions()).toEqual(['Claude Plan · Desktop app not running', 'ChatGPT'])
  })

  it('starts with two slots filled or more, and a slot clears from its menu or the keyboard', async () => {
    await render()
    await pick(1, 'Claude Plan', 'Opus 5.5')
    expect(startButton().disabled).toBe(true)
    await pick(2, 'ChatGPT', 'GPT-6.1 Sol')
    expect(startButton().textContent).toBe('Start duel · 2 models')
    expect(startButton().disabled).toBe(false)
    await pick(3, 'My Gateway', 'GW Large')
    expect(startButton().textContent).toBe('Start duel · 3 models')
    await openSlot(2)
    const clear = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent === 'Clear Model 2',
    )!
    await select(clear)
    expect(slot(2).textContent).toBe('Model 2')
    act(() => {
      slot(3).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(slot(3).textContent).toBe('Model 3')
    expect(startButton().disabled).toBe(true)
  })

  it('gives each slot its connection’s effort: the Plan’s Default, none where there is no dial', async () => {
    await render()
    await pick(1, 'Claude Plan', 'Latest Opus')
    await pick(2, 'ChatGPT', 'GPT-5.6 Terra')
    await pick(3, 'Claude API', 'Sonnet 5')
    /* a Plan with no configured effort runs the CLI's own setting: Default, not Low */
    expect(slotPick(1)).toBe('Latest Opus')
    expect(slotEffort(1)!.textContent).toBe('Default')
    expect(slotPick(2)).toBe('GPT-5.6 Terra')
    expect(slotEffort(2)!.textContent).toBe('Medium')
    /* an API key has no dial: no effort pill under its slot */
    expect(slotPick(3)).toBe('Sonnet 5')
    expect(slotEffort(3)).toBeNull()
    await openEffort(1)
    expect(
      [...menu()!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .find((el) => el.textContent?.startsWith('Default'))!
        .getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('lets the same model duel itself at another effort, and holds two equal slots back', async () => {
    await render()
    await pick(1, 'ChatGPT', 'GPT-6.1 Sol')
    await pick(2, 'ChatGPT', 'GPT-6.1 Sol')
    expect(dialog().textContent).toContain('Model 2 is the same model and effort as Model 1.')
    expect(startButton().disabled).toBe(true)
    await setEffort(2, 'High')
    expect(slotEffort(2)!.textContent).toBe('High')
    expect(dialog().textContent).not.toContain('same model and effort')
    expect(startButton().disabled).toBe(false)
  })

  it('sends each slot’s pick with the effort chosen for it, or the connection’s own', async () => {
    const onClose = vi.fn()
    const onStarted = vi.fn()
    await render('A pricing hero', { onClose, onStarted })
    await pick(1, 'Claude Plan', 'Latest Opus')
    await pick(2, 'ChatGPT', 'GPT-5.6 Terra')
    await pick(3, 'ChatGPT', 'GPT-6 Astra')
    await setEffort(1, 'Max')
    await setEffort(2, 'Extra high')
    expect(slotEffort(1)!.textContent).toBe('Max')
    expect(slotEffort(2)!.textContent).toBe('Extra high')
    /* a model change within a connection keeps the slot's effort */
    await pick(2, 'ChatGPT', 'GPT-6.1 Sol')
    expect(slotPick(2)).toBe('GPT-6.1 Sol')
    expect(slotEffort(2)!.textContent).toBe('Extra high')
    await act(async () => startButton().click())
    expect(mocks.startDuel).toHaveBeenCalledWith(
      'c1',
      'A pricing hero',
      [
        { provider: 'claude-local', model: 'opus', effort: 'max' },
        { provider: 'chatgpt', model: 'gpt-6.1-sol', effort: 'xhigh' },
        /* untouched: the account's configured medium */
        { provider: 'chatgpt', model: 'gpt-6-astra', effort: 'medium' },
      ],
      undefined,
    )
    expect(onStarted).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('sends no effort for a Plan slot left on Default, and only the filled slots', async () => {
    await render('A hero')
    await pick(1, 'Claude Plan', 'Fable 5.2')
    await pick(3, 'ChatGPT', 'GPT-6.1 Sol')
    await act(async () => startButton().click())
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
