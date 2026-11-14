// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ previewFrameCode: vi.fn(), writeFrameCode: vi.fn() }))

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, api: calls }
})

const { FrameCodeModal } = await import('../src/components/FrameCodeModal')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const PATCH = '--- /dev/null\n+++ b/src/components/Pricing.tsx\n@@ -0,0 +1,1 @@\n+export function Pricing() {}\n'
const preview = (framework: 'react' | 'astro') => ({
  repo: 'site',
  patch: PATCH,
  summary: { files: [{ path: 'src/components/Pricing.tsx', create: true, added: 1, removed: 0 }], bytes: 90 },
  code: {
    framework,
    name: 'Pricing',
    files: [{ path: `src/components/Pricing.${framework === 'react' ? 'tsx' : 'astro'}`, text: 'x' }],
    imports: [{ component: 'Button', name: 'Button', from: './ui/Button' }],
    unmapped: ['Card'],
    tokens: ['--color-brand'],
    droppedScripts: 0,
  },
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
  calls.previewFrameCode.mockImplementation(async (_id: string, input: { framework: 'react' | 'astro' }) =>
    preview(input.framework),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('shows the diff and what the export imported, inlined and tokenized', async () => {
  await act(async () => root.render(<FrameCodeModal frameId="f1" onClose={() => {}} />))
  expect(calls.previewFrameCode).toHaveBeenCalledWith('f1', { framework: 'react' })
  expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(PATCH)
  const text = document.body.textContent ?? ''
  expect(text).toContain('src/components/Pricing.tsx (new) +1 −0')
  expect(text).toContain('Button ← ./ui/Button')
  expect(text).toContain('inlined as markup: Card')
  expect(text).toContain('--color-brand')
})

it('writes the previewed patch and reports the new mapping', async () => {
  calls.writeFrameCode.mockResolvedValue({
    ok: true,
    result: { written: ['src/components/Pricing.tsx'], repo: 'site' },
    link: { path: 'src/components/Pricing.tsx' },
  })
  await act(async () => root.render(<FrameCodeModal frameId="f1" onClose={() => {}} />))
  const write = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Write to repo')!
  await act(async () => write.click())
  expect(calls.writeFrameCode).toHaveBeenCalledWith('f1', { framework: 'react' }, PATCH)
  expect(document.body.textContent).toContain('The frame now maps to src/components/Pricing.tsx.')
})
