// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { useStore } = await import('../src/lib/store')
const { footerHint, insertTarget, isLibraryItem, rowAction } = await import('../src/lib/findInsert')

const frame = (id: string, name: string, extra: Partial<Frame> = {}): Frame =>
  ({
    id,
    canvasId: 'c1',
    name,
    html: '<html><body><p>x</p></body></html>',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    ...extra,
  }) as Frame

const lib = { id: 'cp.vui-button-primary', canvasName: 'Design Library', frameId: 'lib1' }

function open(frames: Frame[], name = 'Client portal') {
  useStore.setState({
    canvas: { id: 'c1', name, frames, pages: [{ id: 'p1', name: 'Page' }] } as unknown as Canvas,
    selectedId: null,
    selectedIds: [],
    selectedElement: null,
    selectedElements: [],
  })
}

describe('isLibraryItem', () => {
  it('knows library ids and the Design Library canvas', () => {
    expect(isLibraryItem('cp.scb-otp', null)).toBe(true)
    expect(isLibraryItem('ui.card', null)).toBe(true)
    expect(isLibraryItem(null, 'Design Library')).toBe(true)
    expect(isLibraryItem('auth.otp-6', 'Client portal')).toBe(false)
    expect(isLibraryItem(null, null)).toBe(false)
  })
})

describe('rowAction', () => {
  beforeEach(() => open([frame('login', 'Login'), frame('locked', 'Locked', { locked: true })]))

  it('goes when nothing is selected', () => {
    expect(rowAction(useStore.getState(), lib, false)).toEqual({ kind: 'go' })
    expect(footerHint(useStore.getState(), lib)).toEqual({ kind: 'select' })
  })

  it('inserts a library item into the selected frame, after the picked element', () => {
    useStore.setState({ selectedId: 'login' })
    expect(rowAction(useStore.getState(), lib, false)).toMatchObject({ kind: 'insert', target: { after: null } })
    expect(footerHint(useStore.getState(), lib)).toEqual({ kind: 'insert', frameName: 'Login' })
    useStore.setState({ selectedElement: { frameId: 'login', selector: 'body > p' }, selectedElements: ['body > p'] })
    expect(insertTarget(useStore.getState())?.after).toBe('body > p')
  })

  it('goes on ⇧, for a text hit, into a locked frame, or into the item’s own frame', () => {
    useStore.setState({ selectedId: 'login' })
    expect(rowAction(useStore.getState(), lib, true)).toEqual({ kind: 'go' })
    expect(rowAction(useStore.getState(), { id: null, canvasName: 'Client portal', frameId: 'x' }, false)).toEqual({
      kind: 'go',
    })
    expect(footerHint(useStore.getState(), { id: null, frameId: 'x' })).toEqual({ kind: 'go' })
    useStore.setState({ selectedId: 'locked' })
    expect(rowAction(useStore.getState(), lib, false)).toEqual({ kind: 'go' })
    useStore.setState({ selectedId: 'login' })
    expect(rowAction(useStore.getState(), { ...lib, frameId: 'login' }, false)).toEqual({ kind: 'go' })
  })

  it('goes when the canvas is read-only', () => {
    open([frame('login', 'Login')])
    useStore.setState((s) => ({ canvas: { ...s.canvas!, role: 'view' } as Canvas, selectedId: 'login' }))
    expect(rowAction(useStore.getState(), lib, false)).toEqual({ kind: 'go' })
  })
})
