// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ previewTokenSync: vi.fn(), applyTokenSync: vi.fn() }))

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: calls }
})

const { TokenSyncModal } = await import('../src/components/TokenSyncModal')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
  calls.previewTokenSync.mockResolvedValue({
    repo: 'site',
    files: ['src/app.css'],
    same: 2,
    truncated: false,
    entries: [
      {
        name: '--color-brand',
        type: 'color',
        kind: 'change',
        repo: { value: '#0a7cff', file: 'src/app.css', line: 2, origin: 'css' },
        doop: { value: '#000' },
      },
      {
        name: '--radius-md',
        type: 'radius',
        kind: 'add',
        repo: { value: '8px', file: 'src/app.css', line: 3, origin: 'css' },
      },
      { name: '--color-extra', type: 'color', kind: 'doop-only', doop: { value: '#333' } },
    ],
  })
  calls.applyTokenSync.mockResolvedValue({ results: [{ name: '--color-brand', result: 'updated' }] })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('lists the diff, applies only the ticked repo values', async () => {
  await act(async () => root.render(<TokenSyncModal canvasId="c1" onClose={() => {}} />))
  const text = document.body.textContent ?? ''
  expect(text).toContain('--color-brand')
  expect(text).toContain('Only on this canvas:')
  const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
  expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual(['--color-brand', '--radius-md'])
  await act(async () => boxes[1]!.click())
  const apply = [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Apply 1'))!
  await act(async () => apply.click())
  expect(calls.applyTokenSync).toHaveBeenCalledWith('c1', [
    { name: '--color-brand', type: 'color', value: '#0a7cff', themes: undefined },
  ])
  expect(document.body.textContent).toContain('1 token updated in doop.')
})
