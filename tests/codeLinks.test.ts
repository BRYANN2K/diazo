import { describe, expect, it } from 'vitest'
import {
  codeLinkLabel,
  codePathProblem,
  exportNameProblem,
  isCodeLinkKind,
  normalizeCodePath,
} from '../shared/codeLinks.ts'

describe('shared/codeLinks', () => {
  it('normalizes repo-relative paths', () => {
    expect(normalizeCodePath('./src//components\\Button.tsx ')).toBe('src/components/Button.tsx')
    expect(normalizeCodePath('src/./a.ts')).toBe('src/a.ts')
  })

  it('refuses paths that leave the repo or name nothing', () => {
    for (const bad of ['', '   ', '/etc/passwd', 'C:\\x.ts', '../x.ts', 'src/../../x.ts', 'a/b?.ts', '.']) {
      expect(codePathProblem(bad), bad).not.toBeNull()
    }
    for (const good of ['src/Button.tsx', './src/Button.tsx', 'packages/ui/src/index.ts', 'Button.astro']) {
      expect(codePathProblem(good), good).toBeNull()
    }
    expect(codePathProblem(`src/${'a'.repeat(600)}.ts`)).toMatch(/over/)
  })

  it('takes identifiers and default as export names', () => {
    for (const good of ['Button', 'default', '_x', '$store', 'PricingCard2']) expect(exportNameProblem(good)).toBeNull()
    for (const bad of ['2Fast', 'my-button', 'a b', '']) expect(exportNameProblem(bad), bad).not.toBeNull()
  })

  it('labels a mapping path#export', () => {
    expect(codeLinkLabel({ path: 'src/Button.tsx', exportName: 'Button' })).toBe('src/Button.tsx#Button')
    expect(codeLinkLabel({ path: 'src/Hero.astro', exportName: null })).toBe('src/Hero.astro')
  })

  it('knows its target kinds', () => {
    expect(isCodeLinkKind('component')).toBe(true)
    expect(isCodeLinkKind('frame')).toBe(true)
    expect(isCodeLinkKind('page')).toBe(false)
  })
})
