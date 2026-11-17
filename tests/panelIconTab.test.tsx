// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PanelIconTab, PanelTabPanel, PanelTabs, PanelTabsRoot } from '../src/components/ui/panel'
import { TooltipProvider } from '../src/components/ui/tooltip'

/**
 * The side panel's tab strip: every tab is an icon and its label over a
 * gliding surface indicator; a `compact` tab folds its label away when the
 * strip runs out of room, keeping it as the accessible name and a tooltip.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function Strip({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <PanelTabsRoot value={value} onValueChange={onChange}>
      <PanelTabs>
        <PanelIconTab value="tasks" icon={<svg data-testid="spark" />}>
          Agents
        </PanelIconTab>
        <PanelIconTab value="comments" icon={<svg />} badge={<span data-testid="badge">3</span>}>
          Comments
        </PanelIconTab>
      </PanelTabs>
      <PanelTabPanel value="tasks">agents here</PanelTabPanel>
      <PanelTabPanel value="comments">comments here</PanelTabPanel>
    </PanelTabsRoot>
  )
}

function render(value: string, onChange: (next: string) => void = () => {}) {
  act(() => root.render(<Strip value={value} onChange={onChange} />))
}

const tab = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent?.includes(name))!

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PanelIconTab', () => {
  it('shows the icon on every tab and keeps the label in the DOM for the inactive ones', () => {
    render('tasks')
    expect(tab('Agents').dataset.state).toBe('active')
    expect(tab('Comments').dataset.state).toBe('inactive')
    expect(tab('Agents').querySelector('[data-testid="spark"]')).not.toBeNull()
    /* the inactive tab keeps its label: it is still "Comments" */
    expect(tab('Comments').textContent).toContain('Comments')
  })

  it('labels every tab beside its icon, active or not', () => {
    render('tasks')
    for (const name of ['Agents', 'Comments']) {
      const label = [...tab(name).querySelectorAll('span')].find((el) => el.textContent === name)
      expect(label).toBeDefined()
      expect(label?.closest('.overflow-hidden')).toBeNull()
    }
    expect(container.querySelector('[data-slot="glide-indicator"]')).not.toBeNull()
  })

  it('pins the badge to the tab, outside the label', () => {
    render('tasks')
    const badge = tab('Comments').querySelector('[data-testid="badge"]')!
    expect(badge.closest('.overflow-hidden')).toBeNull()
  })

  it('switches tabs on click', () => {
    let current = 'tasks'
    render('tasks', (next) => {
      current = next
      render(next, () => {})
    })
    act(() => tab('Comments').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    expect(current).toBe('comments')
    expect(container.textContent).toContain('comments here')
    expect(container.textContent).not.toContain('agents here')
  })
})

describe('PanelIconTab compact', () => {
  function renderCompact() {
    act(() =>
      root.render(
        <TooltipProvider delayDuration={0}>
          <PanelTabsRoot value="layers">
            <PanelTabs>
              <PanelIconTab value="layers" icon={<svg data-testid="layers" />}>
                Layers
              </PanelIconTab>
              <PanelIconTab
                value="assets"
                compact
                title="Assets"
                icon={<svg data-testid="assets" />}
                badge={<span data-testid="count">2</span>}
              >
                Assets
              </PanelIconTab>
            </PanelTabs>
          </PanelTabsRoot>
        </TooltipProvider>,
      ),
    )
  }

  it('keeps the label as the accessible name and the icon in view', () => {
    renderCompact()
    const folded = tab('Assets')
    const label = [...folded.querySelectorAll('span')].find((el) => el.textContent === 'Assets')
    expect(label?.className).toContain('sr-only')
    expect(folded.querySelector('[data-testid="assets"]')).not.toBeNull()
    expect(folded.hasAttribute('data-compact')).toBe(true)
    /* the open tab is untouched */
    expect(tab('Layers').hasAttribute('data-compact')).toBe(false)
  })

  it('keeps the badge on a folded tab', () => {
    renderCompact()
    expect(tab('Assets').querySelector('[data-testid="count"]')?.textContent).toBe('2')
  })

  it('names the folded tab in a design system tooltip, not a native title', async () => {
    renderCompact()
    const folded = tab('Assets')
    expect(folded.getAttribute('title')).toBeNull()
    await act(async () => {
      folded.focus()
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const tip = document.querySelector('[data-slot="tooltip"]')
    expect(tip?.textContent).toContain('Assets')
  })
})

describe('PanelIconTab folding under the keyboard', () => {
  /* the strip unfolds the open tab and folds the others (the Layers strip
     at its default width), so an arrow key moves onto a folded tab that
     unfolds as it opens */
  function FoldingStrip() {
    const [value, setValue] = useState('a')
    return (
      <TooltipProvider delayDuration={0}>
        <PanelTabsRoot value={value} onValueChange={setValue}>
          <PanelTabs>
            <PanelIconTab value="a" compact={value !== 'a'} icon={<svg />}>
              Alpha
            </PanelIconTab>
            <PanelIconTab value="b" compact={value !== 'b'} icon={<svg />}>
              Beta
            </PanelIconTab>
            <PanelIconTab value="c" compact icon={<svg />}>
              Gamma
            </PanelIconTab>
          </PanelTabs>
          <PanelTabPanel value="a">a</PanelTabPanel>
          <PanelTabPanel value="b">b</PanelTabPanel>
          <PanelTabPanel value="c">c</PanelTabPanel>
        </PanelTabsRoot>
      </TooltipProvider>
    )
  }

  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]

  async function arrowRight() {
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  it('keeps the same element and the focus when an arrow key unfolds a tab', async () => {
    act(() => root.render(<FoldingStrip />))
    const [alpha, beta, gamma] = tabs()
    act(() => alpha!.focus())
    await arrowRight()
    expect(tabs()[1]).toBe(beta)
    expect(beta!.dataset.state).toBe('active')
    expect(document.activeElement).toBe(beta)
    /* and the walk goes on: a second step lands on the next tab */
    await arrowRight()
    expect(document.activeElement).toBe(gamma)
  })

  it('keeps the active state on an open tab that is folded', async () => {
    act(() => root.render(<FoldingStrip />))
    const gamma = tabs()[2]!
    act(() => gamma.focus())
    await act(async () => {
      gamma.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(gamma.getAttribute('aria-selected')).toBe('true')
    expect(gamma.hasAttribute('data-compact')).toBe(true)
    expect(gamma.dataset.state).toBe('active')
  })
})
