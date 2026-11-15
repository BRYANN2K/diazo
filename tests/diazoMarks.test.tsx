// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AgentIcon, isDiazoAgent } from '../src/components/AgentIcon'
import { DiazoAgentMark, DiazoMark, Logo } from '../src/components/Logo'
import { RoleMark } from '../src/components/RoleMark'
import { Avatar } from '../src/components/ui/avatar'
import { Wordmark } from '../src/components/ui/wordmark'
import { roleById } from '../shared/agents'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(node: React.ReactNode) {
  act(() => root.render(node))
}

it('draws the two Ds, the print in the signal blue, each mark with its own mask', () => {
  render(
    <>
      <Logo />
      <Logo />
    </>,
  )
  const marks = [...container.querySelectorAll('svg[data-mark="diazo"]')]
  expect(marks).toHaveLength(2)
  const masks = marks.map((svg) => svg.querySelector('mask')!.id)
  expect(new Set(masks).size).toBe(2)
  for (const [i, svg] of marks.entries()) {
    const [original, print] = [...svg.querySelectorAll(':scope > path')]
    expect(original!.getAttribute('mask')).toBe(`url(#${masks[i]})`)
    expect(original!.getAttribute('stroke')).toBe('currentColor')
    expect(print!.getAttribute('fill')).toBe('var(--diazo-signal)')
  }
})

it('paints the inline mark in one colour unless asked for colour', () => {
  render(
    <>
      <DiazoMark size={13} />
      <DiazoMark size={13} color="#fff" />
      <DiazoMark size={13} tone="color" />
    </>,
  )
  const prints = [...container.querySelectorAll('svg[data-mark="diazo"]')].map((svg) =>
    svg.querySelectorAll(':scope > path')[1]!.getAttribute('fill'),
  )
  expect(prints).toEqual(['currentColor', '#fff', 'var(--diazo-signal)'])
})

it('reads the lockup as Diazo', () => {
  render(<Wordmark />)
  expect(container.querySelector('[aria-label="Diazo"]')).not.toBeNull()
  expect(container.textContent).not.toMatch(/doop/i)
})

it('animates the agent face only while it works', () => {
  render(
    <>
      <DiazoAgentMark />
      <DiazoAgentMark working />
    </>,
  )
  const [idle, working] = [...container.querySelectorAll('svg[data-mark="diazo-agent"]')]
  expect(idle!.classList.contains('diazo-agent-working')).toBe(false)
  expect(idle!.querySelector('.diazo-agent-chase')).toBeNull()
  expect(working!.classList.contains('diazo-agent-working')).toBe(true)
  expect(working!.querySelector('.diazo-agent-chase')).not.toBeNull()
})

it('knows the built-in agent under its new and its former name', () => {
  expect(isDiazoAgent('Diazo')).toBe(true)
  expect(isDiazoAgent('Doop')).toBe(true)
  expect(isDiazoAgent('UX Lead')).toBe(true)
  expect(isDiazoAgent('Claude Code')).toBe(false)
  expect(isDiazoAgent('Some MCP client')).toBe(false)
})

it('gives the built-in agent its own face in the presence pill, animated when glazed', () => {
  render(
    <>
      <Avatar name="Diazo" kind="agent" />
      <Avatar name="Diazo" kind="agent" glaze />
      <Avatar name="Claude Code" kind="agent" glaze />
    </>,
  )
  const [idle, busy, claude] = [...container.querySelectorAll('[data-slot="avatar"]')]
  expect(idle!.querySelector('svg[data-mark="diazo-agent"]')).not.toBeNull()
  expect(busy!.querySelector('.diazo-agent-working')).not.toBeNull()
  /* the agent's own animation replaces the silver sweep */
  expect(busy!.classList.contains('glaze-sweep')).toBe(false)
  expect(claude!.classList.contains('glaze-sweep')).toBe(true)
  expect(claude!.querySelector('svg[data-mark="diazo-agent"]')).toBeNull()
})

it('marks an unknown agent with Diazo and a role with its solid face', () => {
  render(
    <>
      <AgentIcon name="Some MCP client" />
      <RoleMark role={roleById('ux')} />
    </>,
  )
  expect(container.querySelector('svg[data-mark="diazo"]')).not.toBeNull()
  const disc = container.querySelector('svg[data-mark="diazo-agent"] circle')
  expect(disc!.getAttribute('fill')).toBe(roleById('ux')!.color)
})
