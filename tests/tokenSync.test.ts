import { describe, expect, it } from 'vitest'
import {
  diffTokens,
  inferTokenType,
  mergeRepoTokens,
  parseCssTokens,
  parseTailwindTokens,
  themeOfSelector,
} from '../shared/tokenSync.ts'
import type { DesignToken } from '../shared/designTokens.ts'

const token = (name: string, value: string, extra: Partial<DesignToken> = {}): DesignToken => ({
  name,
  type: 'color',
  value,
  order: 0,
  updatedAt: 0,
  updatedBy: 'test',
  ...extra,
})

describe('inferTokenType', () => {
  it('reads Tailwind v4 namespaces first', () => {
    expect(inferTokenType('--color-brand', 'red')).toBe('color')
    expect(inferTokenType('--font-weight-bold', '700')).toBe('fontWeight')
    expect(inferTokenType('--font-sans', 'Inter')).toBe('fontFamily')
    expect(inferTokenType('--text-lg', '1.125rem')).toBe('fontSize')
    expect(inferTokenType('--radius-md', '8px')).toBe('radius')
  })

  it('falls back on common prefixes and the value', () => {
    expect(inferTokenType('--primary', '222.2 47.4% 11.2%')).toBe('color')
    expect(inferTokenType('--radius', '0.5rem')).toBe('radius')
    expect(inferTokenType('--brand-blue', '#0af')).toBe('color')
    expect(inferTokenType('--header-height', '64px')).toBe('spacing')
    expect(inferTokenType('--transition', 'all 0.2s ease')).toBeNull()
  })
})

describe('themeOfSelector', () => {
  it('maps roots, theme switches and dark media queries', () => {
    expect(themeOfSelector([':root'])).toBe('')
    expect(themeOfSelector(['@theme'])).toBe('')
    expect(themeOfSelector(['@layer base', ':root'])).toBe('')
    expect(themeOfSelector(['.dark'])).toBe('dark')
    expect(themeOfSelector(['[data-theme="dim"]'])).toBe('dim')
    expect(themeOfSelector(['html[data-doop-theme=dark]'])).toBe('dark')
    expect(themeOfSelector(['@media (prefers-color-scheme: dark)', ':root'])).toBe('dark')
    expect(themeOfSelector(['.theme-ocean'])).toBe('ocean')
    expect(themeOfSelector(['html.sepia'])).toBe('sepia')
  })

  it('ignores component scopes and other at-rules', () => {
    expect(themeOfSelector(['.card'])).toBeNull()
    expect(themeOfSelector(['.card .title'])).toBeNull()
    expect(themeOfSelector(['@media (min-width: 640px)', ':root'])).toBeNull()
    expect(themeOfSelector(['@keyframes spin'])).toBeNull()
    expect(themeOfSelector([':root, .card'])).toBeNull()
  })
})

describe('parseCssTokens', () => {
  const css = `/* tokens */
:root {
  --color-brand: #0a7cff;
  --radius: 0.5rem;
  --transition: all 0.2s; /* not a design value */
}
.dark {
  --color-brand: #66b2ff;
}
.card { --card-pad: 12px; }
@theme {
  --font-sans: "Inter", sans-serif;
}
`
  it('reads defaults, theme values and their lines', () => {
    const tokens = parseCssTokens(css, 'src/app.css')
    const brand = tokens.find((t) => t.name === '--color-brand')!
    expect(brand).toMatchObject({
      type: 'color',
      value: '#0a7cff',
      themes: { dark: '#66b2ff' },
      file: 'src/app.css',
      line: 3,
      themeLines: { dark: 8 },
      origin: 'css',
    })
    expect(tokens.find((t) => t.name === '--radius')).toMatchObject({ type: 'radius', value: '0.5rem', line: 4 })
    expect(tokens.find((t) => t.name === '--font-sans')).toMatchObject({
      type: 'fontFamily',
      value: '"Inter", sans-serif',
    })
    expect(tokens.some((t) => t.name === '--transition')).toBe(false)
    expect(tokens.some((t) => t.name === '--card-pad')).toBe(false)
  })
})

describe('parseTailwindTokens', () => {
  it('flattens a v3 theme without evaluating it', () => {
    const config = `
const colors = require('tailwindcss/colors')
module.exports = {
  content: ['./src/**/*.tsx'],
  theme: {
    colors: { brand: { DEFAULT: '#0a7cff', 500: "#0a7cff", 'soft-blue': '#e6f0ff' }, gray: colors.gray },
    extend: {
      borderRadius: { xl: '1rem' },
      fontFamily: { sans: ['Inter var', 'sans-serif'] },
      fontSize: { hero: ['3rem', { lineHeight: '1' }] },
      spacing: { 18: '4.5rem', gutter: \`\${1 + 1}rem\` },
      // a comment
      screens: { tablet: '768px', ...other },
    },
  },
  plugins: [require('@tailwindcss/forms')],
}`
    const tokens = parseTailwindTokens(config, 'tailwind.config.js')
    const byName = Object.fromEntries(tokens.map((t) => [t.name, t.value]))
    expect(byName).toEqual({
      '--color-brand': '#0a7cff',
      '--color-brand-500': '#0a7cff',
      '--color-brand-soft-blue': '#e6f0ff',
      '--radius-xl': '1rem',
      '--font-sans': '"Inter var", sans-serif',
      '--text-hero': '3rem',
      '--spacing-18': '4.5rem',
      '--breakpoint-tablet': '768px',
    })
    expect(tokens.every((t) => t.origin === 'tailwind')).toBe(true)
  })

  it('answers nothing without a theme literal', () => {
    expect(parseTailwindTokens('export default config', 'tailwind.config.ts')).toEqual([])
  })
})

describe('diffTokens', () => {
  it('sorts changes, additions and doop-only tokens', () => {
    const repo = mergeRepoTokens([
      parseCssTokens(':root { --color-brand: #111; --color-ink: #222; --radius-md: 8px; }', 'a.css'),
      parseTailwindTokens("module.exports = { theme: { colors: { brand: '#999' } } }", 'tailwind.config.js'),
    ])
    expect(repo.get('--color-brand')?.value).toBe('#111') // the CSS wins over the config
    const diff = diffTokens(
      repo,
      [token('--color-brand', '#000'), token('--color-ink', '#222'), token('--color-extra', '#333')],
      ['a.css'],
    )
    expect(diff.same).toBe(1)
    expect(diff.entries.map((e) => [e.kind, e.name])).toEqual([
      ['change', '--color-brand'],
      ['add', '--radius-md'],
      ['doop-only', '--color-extra'],
    ])
    expect(diff.entries[0]).toMatchObject({ repo: { value: '#111', file: 'a.css', line: 1 }, doop: { value: '#000' } })
  })

  it('counts a theme-only difference as a change', () => {
    const repo = mergeRepoTokens([parseCssTokens(':root{--color-a:#fff}\n.dark{--color-a:#000}', 'a.css')])
    const diff = diffTokens(repo, [token('--color-a', '#fff')], ['a.css'])
    expect(diff.entries).toEqual([expect.objectContaining({ kind: 'change', name: '--color-a' })])
  })
})
