// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Frame } from '../shared/types'
import { FRAME_CHECKS_VERSION, htmlFingerprint, type FrameChecks } from '../shared/frameChecks'
import { FrameChecksBadge } from '../src/components/FrameChecksBadge'
import { Inspector } from '../src/components/Inspector'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { useStore } from '../src/lib/store'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frame: Frame = {
  id: 'f',
  canvasId: 'c',
  name: 'Checkout',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  html: '<h1>Checkout</h1>',
  createdAt: 1,
  updatedAt: 10,
  updatedBy: 'Designer',
}

const checks: FrameChecks = {
  score: 81,
  errors: 1,
  warnings: 1,
  checkedAt: 20,
  version: FRAME_CHECKS_VERSION,
  htmlHash: htmlFingerprint(frame.html),
  viewports: [
    { width: 375, overflowPx: 120, issues: 2 },
    { width: 768, overflowPx: 0, issues: 0 },
    { width: 1440, overflowPx: 0, issues: 0 },
  ],
  focus: { focusables: 4, reached: 4, withoutVisibleFocus: 1 },
  issues: [
    {
      ruleId: 'FC-OVERFLOW',
      severity: 'error',
      message: 'div runs 120px past the screen edge',
      widths: [375],
      elementId: 'grid',
      selector: '[data-doop-id="grid"]',
    },
    { ruleId: 'FC-FOCUS-VISIBLE', severity: 'warning', message: 'button "Pay" shows no visible change', widths: [] },
  ],
}

let root: Root
let container: HTMLDivElement

function mount(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>))
}

beforeEach(() => {
  useStore.getState().setCanvas({ id: 'c', name: 'Canvas', frames: [frame], createdAt: 1, updatedAt: 10 })
  useStore.setState({ selectedElement: null, selectedElements: [], elementPanelOpen: false })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('shows no badge before a first check', () => {
  mount(<FrameChecksBadge frame={frame} />)
  expect(container.textContent).toBe('')
})

it('shows the issue count, or a check when clean', () => {
  mount(<FrameChecksBadge frame={{ ...frame, checks }} />)
  expect(container.textContent).toBe('A11y 2')
  act(() =>
    root.render(
      <TooltipProvider>
        <FrameChecksBadge frame={{ ...frame, checks: { ...checks, issues: [] } }} />
      </TooltipProvider>,
    ),
  )
  expect(container.textContent).toBe('A11y ✓')
})

it('summarises each width, the keyboard walk and the issues in the Inspector', () => {
  mount(<Inspector frame={{ ...frame, checks }} />)
  const text = container.textContent ?? ''
  expect(text).toContain('Responsive and accessibility')
  expect(text).toContain('375px')
  expect(text).toContain('scrolls 120px sideways')
  expect(text).toContain('Keyboard: 4/4 reached, 1 without visible focus')
  expect(text).toContain('FC-OVERFLOW')
  expect(text).toContain('(keyboard)')
  expect(text).not.toContain('The design changed since this result')
})

it('flags a result measured on an older document', () => {
  mount(<Inspector frame={{ ...frame, html: '<h1>Changed</h1>', checks }} />)
  expect(container.textContent).toContain('The design changed since this result')
})

it('says the frame has not been checked yet', () => {
  mount(<Inspector frame={frame} />)
  expect(container.textContent).toContain('Not checked yet')
})

it('selects the blamed element when an issue is clicked', () => {
  mount(<Inspector frame={{ ...frame, checks }} />)
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('120px past'))
  act(() => button!.click())
  expect(useStore.getState().selectedElement).toEqual({ frameId: 'f', selector: '[data-doop-id="grid"]' })
})
