// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, ChatMessage, ChatPlan } from '../shared/types'

const calls = vi.hoisted(() => ({
  launchChatPlan: vi.fn(() => Promise.resolve({})),
  cancelChatPlan: vi.fn(() => Promise.resolve({})),
  editChatPlan: vi.fn(() => Promise.resolve({})),
  sendChat: vi.fn(() => Promise.resolve({})),
  retryChatAsk: vi.fn(() => Promise.resolve({})),
  /* the composer's model picker lists the connections an ask can run on */
  agentRunners: vi.fn(() => Promise.resolve({ runners: [] })),
  agentModels: vi.fn(() => Promise.resolve({ models: [] })),
}))

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/TeamAllowance', () => ({ isResidentLimit: () => false }))
vi.mock('../src/lib/localRepo', () => ({
  useLocalRepo: (select: (s: { status: Record<string, never> }) => unknown) => select({ status: {} }),
  refreshLocalRepo: vi.fn(() => Promise.resolve({ link: null, online: false, sameDevice: false })),
}))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: calls }
})

const { ChatPanel } = await import('../src/components/ChatPanel')
const { useStore } = await import('../src/lib/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

function canvasWith(role: 'edit' | 'comment' | 'view') {
  return { id: 'c', role, pages: [{ id: 'p', name: 'Page' }], frames: [] } as unknown as Canvas
}

function planMessage(plan: Partial<ChatPlan> = {}): ChatMessage {
  return {
    id: 'm1',
    canvasId: 'c',
    from: 'Doop',
    agent: true,
    text: 'Here is what I would build.',
    at: 2,
    plan: {
      summary: 'A landing page and a pricing sheet.',
      screens: [
        { name: 'Landing', width: 1280, height: 800, outline: 'hero, features, footer' },
        { name: 'Pricing', width: 1280, height: 800, outline: 'three tiers' },
      ],
      openQuestions: ['Which brand font?'],
      status: 'proposed',
      ...plan,
    },
  }
}

function button(text: string) {
  return [...container.querySelectorAll('button')].find((el) => el.textContent === text)
}

it('shows an open plan with its screens and the editor actions', () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [planMessage()] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).toContain('A landing page and a pricing sheet.')
  expect(container.textContent).toContain('Landing')
  expect(container.textContent).toContain('1280×800')
  expect(container.textContent).toContain('Which brand font?')
  expect(container.textContent).toContain('proposed')
  expect(button('Go design')).toBeTruthy()
  expect(button('Edit')).toBeTruthy()
  expect(button('Revise')).toBeTruthy()
  expect(button('Cancel')).toBeTruthy()
})

it('Go design launches the plan for the message id', async () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [planMessage()] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  await act(async () => button('Go design')!.click())
  expect(calls.launchChatPlan).toHaveBeenCalledWith('m1')
})

it('a viewer reads the plan but has no editor actions', () => {
  useStore.setState({ canvas: canvasWith('view'), chat: [planMessage()] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).toContain('A landing page and a pricing sheet.')
  expect(button('Go design')).toBeUndefined()
  expect(button('Cancel')).toBeUndefined()
  expect(container.querySelector('textarea')).toBeNull()
})

it('a launched plan says who queued the cards and closes the actions', () => {
  useStore.setState({
    canvas: canvasWith('edit'),
    chat: [
      planMessage({
        status: 'launched',
        taskIds: ['t1', 't2'],
        launchedBy: 'Bryan',
        launchedByUserId: 'u1',
        launchedAt: 3,
      }),
    ],
  })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).toContain('launched')
  expect(container.textContent).toContain('2 cards queued by Bryan')
  expect(button('Go design')).toBeUndefined()
})

const ask: ChatMessage = { id: 'q1', canvasId: 'c', from: 'Bryan', text: 'A pricing page?', at: 1 }

function typeInComposer(value: string) {
  const field = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

it('has one composer and no reply field per thread', () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [planMessage(), ask] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.querySelectorAll('textarea')).toHaveLength(1)
  expect(container.querySelector('input[placeholder="Reply…"]')).toBeNull()
})

it('Reply points the composer at the thread, and the send carries it', async () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [ask] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  act(() => (container.querySelector('button[aria-label="Reply to Bryan"]') as HTMLButtonElement).click())
  expect(container.textContent).toContain('Replying to Bryan: A pricing page?')
  act(() => typeInComposer('Three tiers please'))
  await act(async () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).click())
  expect(calls.sendChat).toHaveBeenCalledWith('c', { text: 'Three tiers please', threadId: 'q1' })
  expect(container.textContent).not.toContain('Replying to')
})

it('a new message without Reply starts a thread; ✕ drops the reply', async () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [ask] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  act(() => (container.querySelector('button[aria-label="Reply to Bryan"]') as HTMLButtonElement).click())
  act(() => (container.querySelector('button[aria-label="Stop replying"]') as HTMLButtonElement).click())
  act(() => typeInComposer('Something new'))
  await act(async () => (container.querySelector('button[type="submit"]') as HTMLButtonElement).click())
  expect(calls.sendChat).toHaveBeenCalledWith('c', { text: 'Something new' })
})

function chip(text: string) {
  return [...container.querySelectorAll('[data-slot="chip"]')].find((el) => el.textContent?.includes(text)) as
    HTMLButtonElement | undefined
}

it('an empty chat welcomes an editor with suggestions tied to the canvas', () => {
  useStore.setState({
    canvas: {
      ...canvasWith('edit'),
      frames: [{ id: 'f1', name: 'Checkout', pageId: 'p', html: '<html><body></body></html>' }],
      skills: [{ name: 'brand', description: 'Our brand rules', body: '' }],
    } as unknown as Canvas,
    chat: [],
    activePageId: 'p',
    selectedId: null,
  })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).toContain('Plan the next design with Diazo')
  expect(chip('Design a pricing page')).toBeTruthy()
  expect(chip('Review “Checkout” for accessibility')).toBeTruthy()
  expect(chip('Use the /brand skill')).toBeTruthy()
})

it('a suggestion sends its prompt to the agent', async () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  await act(async () => chip('Design a pricing page')!.click())
  expect(calls.sendChat).toHaveBeenCalledWith('c', {
    text: 'Design a pricing page: three tiers, a feature comparison and a short FAQ.',
  })
})

it('a skill suggestion puts /name in the composer instead of sending', () => {
  useStore.setState({
    canvas: { ...canvasWith('edit'), skills: [{ name: 'brand', description: 'x', body: '' }] } as unknown as Canvas,
    chat: [],
  })
  act(() => root.render(<ChatPanel canvasId="c" />))
  act(() => chip('Use the /brand skill')!.click())
  expect(container.querySelector('textarea')!.value).toBe('/brand ')
  expect(calls.sendChat).not.toHaveBeenCalled()
})

it('a viewer sees the welcome without suggestions', () => {
  useStore.setState({ canvas: canvasWith('view'), chat: [] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).toContain('Plan the next design with Diazo')
  expect(container.querySelector('[data-slot="chip"]')).toBeNull()
})

it('the welcome gives way once the agent has answered', () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [planMessage(), ask] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).not.toContain('Plan the next design with Diazo')
})

it('scrolled up, Jump to latest appears, says when lines arrived, and brings the list down', () => {
  useStore.setState({ canvas: canvasWith('edit'), chat: [planMessage(), ask] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  const list = container.querySelector('[data-slot="panel-body"]') as HTMLDivElement
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 })
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 200 })
  let top = 800
  Object.defineProperty(list, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => (top = Math.min(value, 800)),
  })
  const jump = () => button('Jump to latest') ?? button('New messages')
  expect(jump()).toBeUndefined()

  act(() => {
    list.scrollTop = 100
    list.dispatchEvent(new Event('scroll'))
  })
  expect(button('Jump to latest')).toBeTruthy()

  /* a new line while the reader is up the list: the list stays put */
  const reply: ChatMessage = { id: 'm2', canvasId: 'c', from: 'Doop', agent: true, text: 'Done.', at: 4 }
  act(() => useStore.setState({ chat: [reply, planMessage(), ask] }))
  expect(list.scrollTop).toBe(100)
  expect(button('New messages')).toBeTruthy()

  act(() => button('New messages')!.click())
  expect(list.scrollTop).toBe(800)
  expect(jump()).toBeUndefined()
})

it('a failed ask shows the reason and a Retry that queues it again', async () => {
  const failed: ChatMessage = { ...ask, forAgent: true, failedAt: 2, failureReason: 'Model refused the key' }
  useStore.setState({ canvas: canvasWith('edit'), chat: [failed] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.textContent).toContain('Model refused the key')
  await act(async () => button('Retry')!.click())
  expect(calls.retryChatAsk).toHaveBeenCalledWith('q1')
})

it('an ask in progress shows the agent thinking in its place', () => {
  const thinking: ChatMessage = { ...ask, forAgent: true, claimedBy: 'Doop', claimedAt: 2 }
  useStore.setState({ canvas: canvasWith('edit'), chat: [thinking] })
  act(() => root.render(<ChatPanel canvasId="c" />))
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Doop is thinking…')
})
