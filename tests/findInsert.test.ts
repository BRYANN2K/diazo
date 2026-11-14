// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { LibraryItemSummary } from '../shared/library'

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

const summary = (id: string, kind: string, frameId = 'lib1'): LibraryItemSummary => ({
  id,
  parentId: null,
  label: id,
  kind,
  source: '',
  category: 'Unsorted',
  tags: [],
  status: 'active',
  mode: 'snapshot',
  frameId,
  pageId: 'p1',
  locator: { whole: true },
  box: null,
  scripted: false,
  rev: 1,
  thumb: '',
})

const lib = { item: summary('cp.vui-button-primary', 'cp'), frameId: 'lib1' }

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
  it('is a row the library index answered, of an insertable kind', () => {
    expect(isLibraryItem(lib)).toBe(true)
    expect(isLibraryItem({ item: summary('auth.otp-6', 'auth'), frameId: 'x' })).toBe(true)
    expect(isLibraryItem({ item: summary('rs.shadcnblocks', 'rs'), frameId: 'x' })).toBe(false)
    expect(isLibraryItem({ item: null, frameId: 'x' })).toBe(false)
    expect(isLibraryItem(null)).toBe(false)
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
    expect(rowAction(useStore.getState(), lib, false)).toMatchObject({ kind: 'insert', target: { at: null } })
    expect(footerHint(useStore.getState(), lib)).toEqual({ kind: 'insert', frameName: 'Login' })
    useStore.setState({ selectedElement: { frameId: 'login', selector: 'body > p' }, selectedElements: ['body > p'] })
    expect(insertTarget(useStore.getState())?.at).toBe('body > p')
  })

  it('goes on ⇧, for a text hit, into a locked frame, or into the item’s own frame', () => {
    useStore.setState({ selectedId: 'login' })
    expect(rowAction(useStore.getState(), lib, true)).toEqual({ kind: 'go' })
    expect(rowAction(useStore.getState(), { item: null, frameId: 'x' }, false)).toEqual({
      kind: 'go',
    })
    expect(footerHint(useStore.getState(), { item: null, frameId: 'x' })).toEqual({ kind: 'go' })
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
