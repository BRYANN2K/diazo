// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas } from '../shared/types'

/**
 * The prompt composer lives at the bottom of the Agents tab: Enter
 * queues the card, ⇧Enter breaks the line, and a ⌘/ focus request from the
 * page lands the keyboard in it.
 */

const mocks = vi.hoisted(() => ({
  addCard: vi.fn(() => Promise.resolve({})),
  agentAllowance: vi.fn(() => Promise.resolve({ used: 0, limit: 5, byoModel: false })),
}))
vi.mock('../src/lib/api', () => ({
  api: {
    addCard: mocks.addCard,
    agentAllowance: mocks.agentAllowance,
    /* the composer's model picker lists the connections a task can run on */
    agentRunners: () => Promise.resolve({ runners: [] }),
    /* the comparison cards of open model duels sit above the task list */
    listDuels: () => Promise.resolve([]),
  },
  ApiError: class ApiError extends Error {},
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/auth', () => ({ authClient: { useSession: () => ({ data: { user: { id: 'alice' } } }) } }))
vi.mock('../src/lib/frameClipboard', () => ({ uploadImageFrames: () => Promise.resolve([]) }))
vi.mock('../src/components/ChatPanel', () => ({ ChatPanel: () => null }))
vi.mock('../src/components/MemoryPanel', () => ({ MemoryPanel: () => null }))

const { useStore } = await import('../src/lib/store')
const { flushComposerDrafts, setComposerDraftOwner } = await import('../src/lib/composerDrafts')
const { ActivityPanel } = await import('../src/components/ActivityPanel')
const { TooltipProvider } = await import('../src/components/ui/tooltip')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const canvas = { id: 'c1', name: 'Canvas', frames: [], pages: [] } as unknown as Canvas

let container: HTMLDivElement
let root: Root | null = null

async function render(canvasId = 'c1') {
  container = document.createElement('div')
  document.body.append(container)
  const created = createRoot(container)
  root = created
  await act(async () =>
    created.render(
      <TooltipProvider>
        <ActivityPanel canvasId={canvasId} onClose={() => {}} />
      </TooltipProvider>,
    ),
  )
}

async function unmount() {
  const stale = root
  root = null
  if (stale) await act(async () => stale.unmount())
  container.remove()
}

function composer(): HTMLTextAreaElement {
  const ta = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask the Diazo Agent"]')
  if (!ta) throw new Error('composer not rendered')
  return ta
}

async function type(text: string) {
  const ta = composer()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    composer().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  /* a write still inside its debounce window from the last test lands now,
     then the wipe takes it with the parked drafts */
  flushComposerDrafts()
  localStorage.clear()
  setComposerDraftOwner('alice')
  useStore.setState({
    canvas,
    panelTab: 'tasks',
    composerFocusAt: 0,
    composerDrafts: {},
    composerSend: null,
    flyTo: null,
    selectedId: null,
    selectedElement: null,
  })
})

const switchTab = (tab: 'tasks' | 'activity') => act(async () => useStore.getState().setPanelTab(tab))
const frameOn = (canvasId: string, id: string) =>
  ({ id, canvasId, name: id, x: 0, y: 0, width: 1, height: 1, html: '<p/>' }) as unknown as Canvas['frames'][number]
afterEach(() => {
  if (root) {
    const stale = root
    root = null
    act(() => stale.unmount())
    container.remove()
  }
})

describe('the Agents tab composer', () => {
  it('is docked in the tasks tab with its send button', async () => {
    await render()
    const send = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Send')
    expect(send).toBeTruthy()
    expect(send!.disabled).toBe(true) // nothing typed yet
    expect(composer().closest('[data-slot="panel-tab-panel"]')?.getAttribute('data-state')).toBe('active')
  })

  it('sends on Enter and keeps a ⇧Enter draft', async () => {
    await render()
    await type('a hero for the pricing page')
    await press('Enter', { shiftKey: true })
    expect(mocks.addCard).not.toHaveBeenCalled()
    expect(composer().value).toBe('a hero for the pricing page')

    await press('Enter')
    expect(mocks.addCard).toHaveBeenCalledWith(
      'c1',
      'a hero for the pricing page',
      ['doop'],
      [],
      undefined,
      /* nothing connected: no pick, so the card runs on the default */
      undefined,
    )
    expect(composer().value).toBe('')
  })

  it('scopes the card to the selected frame', async () => {
    useStore.setState({
      canvas: {
        ...canvas,
        frames: [{ id: 'f1', canvasId: 'c1', name: 'Hero', x: 0, y: 0, width: 1, height: 1, html: '<p/>' }],
      } as unknown as Canvas,
    })
    /* after the canvas: a send above left a camera watch on the store, and
       the frame "arriving" through it flies the camera, which resets the
       selection */
    useStore.getState().select('f1')
    await render()
    await type('make it bolder')
    await press('Enter')
    expect(mocks.addCard).toHaveBeenCalledWith('c1', 'make it bolder', ['doop'], [], { frameId: 'f1' }, undefined)
  })

  it('takes the keyboard on a focus request', async () => {
    await render()
    expect(document.activeElement).not.toBe(composer())
    await act(async () => useStore.getState().requestComposerFocus())
    expect(document.activeElement).toBe(composer())
  })

  it('is not in the other tabs', async () => {
    useStore.setState({ panelTab: 'activity' })
    await render()
    expect(container.querySelector('textarea[aria-label="Ask the Diazo Agent"]')).toBeNull()
  })

  it('keeps the draft across a tab switch, per canvas', async () => {
    await render()
    await type('half a thought')
    await switchTab('activity')
    expect(container.querySelector('textarea')).toBeNull()
    await switchTab('tasks')
    expect(composer().value).toBe('half a thought')
    expect(useStore.getState().composerDrafts).toEqual({ c1: 'half a thought' })
  })

  it('still reports a send that failed while another tab was open', async () => {
    let fail!: (err: Error) => void
    mocks.addCard.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
    await render()
    await type('a footer')
    await press('Enter')
    expect(composer().disabled).toBe(true) // in flight

    await switchTab('activity')
    await act(async () => fail(new Error('upload failed')))
    await switchTab('tasks')
    expect(container.textContent).toContain('upload failed')
    expect(composer().value).toBe('a footer') // the draft is there for a retry
    expect(composer().disabled).toBe(false)

    /* touching the draft takes the failure down */
    await type('a footer, retried')
    expect(container.textContent).not.toContain('upload failed')
  })

  it('flies the camera to the first new frame on this canvas only', async () => {
    await render()
    await type('a hero')
    await press('Enter')
    expect(useStore.getState().flyTo).toBeNull()

    /* another canvas opened before the agent delivered: its frames are not
       deliverables, and the watch is over */
    useStore.setState({ canvas: null })
    useStore.setState({ canvas: { ...canvas, id: 'c2', frames: [frameOn('c2', 'elsewhere')] } as Canvas })
    expect(useStore.getState().flyTo).toBeNull()
    useStore.setState({ canvas: { ...canvas, frames: [frameOn('c1', 'late')] } as Canvas })
    expect(useStore.getState().flyTo).toBeNull()
  })

  it('flies the camera to the first new frame after a send', async () => {
    await render()
    await type('a hero')
    await press('Enter')
    useStore.setState({ canvas: null }) // a reconnect, not a navigation
    useStore.setState({ canvas: { ...canvas, frames: [frameOn('c1', 'delivered')] } as Canvas })
    expect(useStore.getState().flyTo).toMatchObject({ frameId: 'delivered' })
  })

  it('parks the draft and restores it after a reload', async () => {
    await render()
    await type('half a thought')
    flushComposerDrafts()
    expect(localStorage.getItem('doop:composer-draft:alice:c1')).toContain('half a thought')

    /* a reload forgets memory but keeps storage; the next mount restores */
    await act(async () => useStore.setState({ composerDrafts: {} }))
    await switchTab('activity')
    await switchTab('tasks')
    expect(composer().value).toBe('half a thought')
  })

  it('drops the parked draft once the card is queued', async () => {
    await render()
    await type('a hero')
    flushComposerDrafts()
    await press('Enter')
    expect(composer().value).toBe('')
    expect(localStorage.getItem('doop:composer-draft:alice:c1')).toBeNull()
  })

  it('keeps each canvas its own draft across reloads', async () => {
    await render('c1')
    await type('first canvas')
    flushComposerDrafts()
    await unmount()

    /* canvas two after a reload: fresh memory, its own empty field */
    useStore.setState({ composerDrafts: {} })
    await render('c2')
    expect(composer().value).toBe('')
    await type('second canvas')
    flushComposerDrafts()
    await unmount()

    /* back on canvas one after another reload: its draft is still there */
    useStore.setState({ composerDrafts: {} })
    await render('c1')
    expect(composer().value).toBe('first canvas')
    expect(localStorage.getItem('doop:composer-draft:alice:c2')).toContain('second canvas')
  })

  it('prefers an in-memory draft over an older parked one', async () => {
    localStorage.setItem('doop:composer-draft:alice:c1', JSON.stringify({ text: 'parked earlier', at: Date.now() }))
    useStore.setState({ composerDrafts: { c1: 'typed this session' } })
    await render()
    expect(composer().value).toBe('typed this session')
  })

  it('never shows one account the draft another parked', async () => {
    await render()
    await type('alice was writing this')
    flushComposerDrafts()
    await unmount()

    /* bob signs in on the same browser: fresh memory, alice's text gone */
    setComposerDraftOwner('bob')
    useStore.setState({ composerDrafts: {} })
    await render()
    expect(composer().value).toBe('')
    expect(localStorage.getItem('doop:composer-draft:alice:c1')).toBeNull()
  })

  it('fills the composer from a draft handed off before mount', async () => {
    /* Home's prompt flow: the brief rides to the fresh canvas as its draft */
    useStore.getState().setComposerDraft('c1', 'a pricing page, three drafts')
    await render()
    expect(composer().value).toBe('a pricing page, three drafts')
  })
})
