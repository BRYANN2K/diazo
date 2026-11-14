import { describe, expect, it } from 'vitest'
import { planTokenPatch, type RepoTokenRead } from '../server/tokenSync.ts'
import { mergeRepoTokens, parseCssTokens, parseTailwindTokens } from '../shared/tokenSync.ts'
import { applyPatch, summarizePatch } from '../shared/patch.ts'
import type { DesignToken } from '../shared/designTokens.ts'

const CSS = `:root {
  --color-brand: #111;
  --radius-md: 8px;
}

.dark {
  --color-brand: #eee;
}
`
const CONFIG = "module.exports = { theme: { extend: { spacing: { gutter: '24px' } } } }"

function read(): RepoTokenRead {
  const sources = new Map([
    ['src/app.css', CSS],
    ['tailwind.config.js', CONFIG],
  ])
  return {
    repo: 'site',
    sources,
    files: [...sources.keys()],
    truncated: false,
    tokens: mergeRepoTokens([parseTailwindTokens(CONFIG, 'tailwind.config.js'), parseCssTokens(CSS, 'src/app.css')]),
  }
}

const token = (name: string, value: string, themes?: Record<string, string>): DesignToken => ({
  name,
  type: 'color',
  value,
  ...(themes ? { themes } : {}),
  order: 0,
  updatedAt: 0,
  updatedBy: 't',
})

describe('planTokenPatch', () => {
  it('edits changed declarations in place, theme lines too, and adds doop-only tokens to :root', () => {
    const doop = [token('--color-brand', '#0a7cff', { dark: '#66b2ff' }), token('--color-new', '#123456')]
    const plan = planTokenPatch(read(), doop, ['--color-brand', '--color-new'])
    expect(plan.names).toEqual(['--color-brand', '--color-new'])
    expect(plan.skipped).toEqual([])
    expect(summarizePatch(plan.patch).files).toEqual([{ path: 'src/app.css', create: false, added: 3, removed: 2 }])
    const out = applyPatch(plan.patch, (p) => (p === 'src/app.css' ? CSS : null)).get('src/app.css')!
    expect(out).toBe(
      ':root {\n  --color-brand: #0a7cff;\n  --radius-md: 8px;\n  --color-new: #123456;\n}\n\n.dark {\n  --color-brand: #66b2ff;\n}\n',
    )
  })

  it('skips Tailwind config tokens and unknown names, and answers no patch when nothing differs', () => {
    const doop = [token('--spacing-gutter', '32px'), token('--radius-md', '8px')]
    const plan = planTokenPatch(read(), doop, ['--spacing-gutter', '--radius-md', '--nope'])
    expect(plan.patch).toBe('')
    expect(plan.skipped.map((s) => s.name)).toEqual(['--spacing-gutter', '--nope'])
    expect(plan.skipped[0]!.reason).toMatch(/Tailwind config/)
    expect(plan.names).toEqual(['--radius-md'])
  })
})
