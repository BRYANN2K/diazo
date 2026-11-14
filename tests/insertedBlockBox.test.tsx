// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

const calls = vi.hoisted(() => ({
  sendChat: vi.fn(() => Promise.resolve({})),
  updateFrame: vi.fn(() => Promise.resolve({})),
}))

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/components/TeamAllowance', () => ({ isResidentLimit: () => false }))
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: calls }
})

const { InsertedBlockBox } = await import('../src/components/InsertedBlockBox')
const { useInsertedBox } = await import('../src/lib/insertedBox')
const { useStore } = await import('../src/lib/store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HTML =
  '<!doctype html>\n<html><head></head><body><main data-doop-id="mmmmmm"></main><div data-doop-ref="cp.btn" data-doop-id="bbbbbb"><button data-doop-id="cccccc">Buy</button></div></body></html>'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.body.innerHTML = '<div class="stage"><div class="world"></div></div>'
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
  useStore.setState({
    canvas: {
      id: 'c1',
      name: 'Portal',
      pages: [{ id: 'p', name: 'Page' }],
      frames: [
        { id: 'login', canvasId: 'c1', name: 'Login', html: HTML, x: 0, y: 0, width: 400, height: 300 } as Frame,
      ],
    } as unknown as Canvas,
  })
  useInsertedBox.getState().open({
    frameId: 'login',
    selector: 'body > div',
    elementId: 'bbbbbb',
    ref: 'cp.btn',
    found: true,
    scripted: false,
    approvalWithdrawn: false,
    before: '',
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useInsertedBox.getState().close()
})

const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement

it('Adapt sends the instruction to the chat with the block’s reference and link', async () => {
  act(() => root.render(<InsertedBlockBox />))
  const field = document.querySelector('.world textarea') as HTMLTextAreaElement
  expect(field).toBeTruthy()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(field, 'more compact')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Adapt').click())
  expect(calls.sendChat).toHaveBeenCalledWith('c1', {
    text: 'Adapt [data-doop-ref=cp.btn] in the frame “Login” (/c/c1?frame=login&element=bbbbbb): more compact; keep the structure.',
  })
  expect(useInsertedBox.getState().item).toBeNull()
  expect(useStore.getState().panelTab).toBe('chat')
})

it('an empty field asks for this frame’s tokens', async () => {
  act(() => root.render(<InsertedBlockBox />))
  await act(async () => button('Adapt').click())
  expect(calls.sendChat).toHaveBeenCalledWith('c1', { text: expect.stringContaining("this frame's design tokens") })
})

it('Undo takes the block out of the frame', () => {
  act(() => root.render(<InsertedBlockBox />))
  act(() => button('Undo').click())
  const html = useStore.getState().canvas!.frames[0]!.html
  expect(html).not.toContain('data-doop-ref')
  expect(html).toContain('<main data-doop-id="mmmmmm">')
  expect(useInsertedBox.getState().item).toBeNull()
})
