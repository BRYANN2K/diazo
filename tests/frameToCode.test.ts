import { describe, expect, it, vi } from 'vitest'

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveFrameVersion: () => {},
  saveTask: () => {},
  saveComponent: () => {},
  deleteComponent: () => {},
  saveTokens: () => {},
}))

const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const { blankComponent } = await import('../server/components.ts')
const { COMPONENT_ATTR } = await import('../shared/components.ts')
const { frameToCode, relativeImport, componentNameFor, substituteTokens, FrameCodeError } =
  await import('../server/frameToCode.ts')
import type { Actor } from '../shared/types.ts'
import type { CodeLink } from '../shared/codeLinks.ts'
import type { DesignToken } from '../shared/designTokens.ts'

const actor = { name: 'Tester', kind: 'user', color: '#000', clientId: 'x' } as unknown as Actor
const doc = (body: string, css = '') =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`

const tokens: DesignToken[] = [
  { name: '--color-brand', type: 'color', value: '#0A7CFF', order: 0, updatedAt: 0, updatedBy: 't' },
  { name: '--spacing-4', type: 'spacing', value: '16px', order: 1, updatedAt: 0, updatedBy: 't' },
]

function setup() {
  const canvas = store.createCanvas('frame to code')
  const def = blankComponent({ name: 'Button', by: 'Tester', props: [] })
  store.saveComponent(canvas.id, def)
  const main = actions.createFrame(canvas.id, { name: 'Main', html: '' }, actor)!
  actions.updateFrame(
    main.id,
    {
      html: doc(
        `<button class="btn" ${COMPONENT_ATTR}="${def.id}"><span data-doop-prop="label">Buy</span></button>`,
        '.btn { padding: 8px }',
      ),
    },
    actor,
  )
  const frame = actions.createFrame(canvas.id, { name: 'Pricing page', html: '' }, actor)!
  actions.updateFrame(
    frame.id,
    {
      html: doc(
        `<main class="hero" style="padding: 16px"><h1 data-doop-id="h1">Plans {for} you &amp; me</h1><img src="/a.png" alt=""><doop-use component="Button" label="Start"></doop-use><script>alert(1)</script></main>`,
        '.hero { color: #0a7cff; margin: 16px !important } .hero h1 { --local: 16px }',
      ),
    },
    actor,
  )
  return { canvas: store.getCanvas(canvas.id)!, def, frame: store.getFrame(frame.id)! }
}

const link = (over: Partial<CodeLink>): CodeLink => ({
  id: 'l',
  canvasId: 'c',
  targetKind: 'component',
  targetId: 'x',
  path: 'src/components/ui/Button.tsx',
  exportName: 'Button',
  source: 'manual',
  updatedBy: 't',
  updatedAt: 0,
  ...over,
})

describe('helpers', () => {
  it('names and imports', () => {
    expect(componentNameFor('Pricing page — v2')).toBe('PricingPageV2')
    expect(componentNameFor('404')).toBe('Screen')
    expect(relativeImport('src/components/Pricing.tsx', 'src/components/ui/Button.tsx')).toBe('./ui/Button')
    expect(relativeImport('src/pages/pricing.astro', 'src/components/Button.astro')).toBe('../components/Button.astro')
    expect(relativeImport('src/a/b/X.tsx', 'lib/ui/index.ts')).toBe('../../../lib/ui')
  })

  it('substitutes exact token values only', () => {
    const used = new Set<string>()
    const idx = new Map([['#0a7cff', '--color-brand']])
    expect(substituteTokens('a { color: #0A7CFF; border-color: #0a7cff80 }', idx, used)).toBe(
      'a { color: var(--color-brand); border-color: #0a7cff80 }',
    )
    expect([...used]).toEqual(['--color-brand'])
  })
})

describe('frameToCode', () => {
  it('writes a React component with tokens and the mapped component imported', () => {
    const { canvas, def, frame } = setup()
    const out = frameToCode(canvas, frame, tokens, [link({ targetId: def.id })], { framework: 'react' })
    expect(out.name).toBe('PricingPage')
    expect(out.files.map((f) => f.path)).toEqual(['src/components/PricingPage.tsx', 'src/components/PricingPage.css'])
    const [tsx, css] = out.files.map((f) => f.text)
    expect(tsx).toContain("import { Button } from './ui/Button'")
    expect(tsx).toContain("import './PricingPage.css'")
    expect(tsx).toContain('export function PricingPage() {')
    expect(tsx).toContain('<Button label="Start" />')
    expect(tsx).toContain('className="hero"')
    expect(tsx).toContain('style={{ padding: "var(--spacing-4)" }}')
    expect(tsx).toContain("Plans {'{'}for{'}'} you &amp; me")
    expect(tsx).toContain('<img src="/a.png" alt="" />')
    expect(tsx).not.toContain('data-doop')
    expect(tsx).not.toContain('alert(1)')
    expect(css).toContain('color: var(--color-brand)')
    expect(css).toContain('margin: var(--spacing-4) !important')
    expect(css).toContain('--local: 16px') // custom properties are left alone
    expect(css).not.toContain('.btn') // the mapped component brings its own CSS
    expect(out.tokens).toEqual(['--color-brand', '--spacing-4'])
    expect(out.unmapped).toEqual([])
    expect(out.droppedScripts).toBe(1)
  })

  it('writes Astro, inlining a component that has no mapping', () => {
    const { canvas, frame } = setup()
    const out = frameToCode(canvas, frame, tokens, [], { framework: 'astro', path: 'src/pages/pricing.astro' })
    expect(out.files).toHaveLength(1)
    const astro = out.files[0]!.text
    expect(astro.startsWith('---\n')).toBe(true)
    expect(astro).toContain('class="hero"')
    expect(astro).toContain('<button class="btn"')
    expect(astro).toContain('<style is:global>')
    expect(astro).toContain("Plans {'{'}for{'}'} you")
    expect(out.unmapped).toEqual(['Button'])
  })

  it('defaults to the frame mapping and refuses a bad path', () => {
    const { canvas, frame } = setup()
    const mapped = frameToCode(
      canvas,
      frame,
      tokens,
      [link({ targetKind: 'frame', targetId: frame.id, path: 'src/routes/Pricing.tsx' })],
      { framework: 'react' },
    )
    expect(mapped.files[0]!.path).toBe('src/routes/Pricing.tsx')
    expect(() => frameToCode(canvas, frame, tokens, [], { framework: 'react', path: '../x.tsx' })).toThrow(
      FrameCodeError,
    )
    expect(() => frameToCode(canvas, frame, tokens, [], { framework: 'astro', path: 'src/x.tsx' })).toThrow(/\.astro/)
  })
})
