import { describe, expect, it, vi } from 'vitest'
import type { DesignToken } from '../shared/designTokens'
import type { FrameLint } from '../shared/slopRules'
import { EMPTY_TAXONOMY } from '../shared/library'
import { RULE_PRESETS, type LibraryRules } from '../shared/libraryRules'
import { applyTokenMatches, tokenMatches } from '../shared/libraryTokens'
import { planImport, stageLint } from '../server/libraryImportPlan'

const token = (name: string, type: DesignToken['type'], value: string): DesignToken => ({
  name,
  type,
  value,
  order: 0,
  updatedAt: 1,
  updatedBy: 't',
})
const TOKENS = [
  token('--color-ink', 'color', '#09090b'),
  token('--radius-md', 'radius', '8px'),
  token('--font-ui', 'fontFamily', "'Inter', sans-serif"),
]

describe('token matches', () => {
  it('matches a colour written as hex or rgb', () => {
    const css = '<style>.a{color:#09090b}.b{background: rgb(9, 9, 11)}</style>'
    expect(tokenMatches(css, TOKENS)).toEqual([
      { value: '#09090b', token: '--color-ink', count: 1 },
      { value: 'rgb(9, 9, 11)', token: '--color-ink', count: 1 },
    ])
  })

  it('matches radii and font families, in style attributes too', () => {
    const html = '<p style="border-radius: 8px; font-family: Inter, sans-serif">x</p>'
    expect(applyTokenMatches(html, TOKENS)).toBe(
      '<p style="border-radius: var(--radius-md); font-family: var(--font-ui)">x</p>',
    )
  })

  it('leaves url() and gradient stops with a position alone, takes a whole stop', () => {
    const css =
      '<style>.a{background:url(#09090b)}.b{background:linear-gradient(#09090b, #fff 50%)}.c{background:linear-gradient(red, #09090b 40%)}</style>'
    const out = applyTokenMatches(css, TOKENS)
    expect(out).toContain('url(#09090b)')
    expect(out).toContain('linear-gradient(var(--color-ink), #fff 50%)')
    expect(out).toContain('linear-gradient(red, #09090b 40%)')
  })

  it('never touches markup or text', () => {
    const html = '<p data-color="#09090b">#09090b</p><style>.a{color:#09090b}</style>'
    expect(applyTokenMatches(html, TOKENS)).toBe(
      '<p data-color="#09090b">#09090b</p><style>.a{color:var(--color-ink)}</style>',
    )
  })
})

const rules = (patch: (r: LibraryRules) => void): LibraryRules => {
  const r = structuredClone(RULE_PRESETS.sheets)
  patch(r)
  return r
}
const frame = {
  frameId: 'a',
  name: 'cp.x-card — Card',
  html: '<!doctype html><html><body><style>.c{color:#09090b}</style><p class="c">x</p></body></html>',
  width: 400,
  height: 300,
}
const library = (r: LibraryRules) => ({
  canvasId: 'lib',
  rules: r,
  taxonomy: EMPTY_TAXONOMY,
  pages: [{ id: 'p1', name: 'P' }],
  frames: [],
})

describe('the token stage', () => {
  it('suggests without changing anything, applies when asked', () => {
    const suggested = planImport({
      library: library(rules((x) => (x.tokens.map = 'suggest'))),
      frames: [frame],
      existing: [],
      tokens: TOKENS,
    })
    expect(suggested.frames[0]!.findings.map((f) => f.kind)).toContain('token-match')
    expect(suggested.frames[0]!.changes.html ?? '').not.toContain('var(--color-ink)')
    const applied = planImport({
      library: library(rules((x) => (x.tokens.map = 'apply'))),
      frames: [frame],
      existing: [],
      tokens: TOKENS,
    })
    expect(applied.frames[0]!.changes.html).toContain('.c{color:var(--color-ink)}')
  })
})

const lintResult = (score: number, ruleIds: string[]): FrameLint => ({
  score,
  errors: ruleIds.length,
  warnings: 0,
  issues: ruleIds.map((ruleId) => ({ ruleId, severity: 'error', message: ruleId })),
  checkedAt: 1,
  version: 1,
  engine: 'static',
})

describe('the lint gate', () => {
  const plan = (r: LibraryRules) => planImport({ library: library(r), frames: [frame], existing: [] })

  it('records the score under warn', async () => {
    const r = rules((x) => ((x.lint.gate = 'warn'), (x.lint.minScore = 70)))
    const out = await stageLint(
      plan(r),
      () => frame.html,
      r,
      async () => lintResult(40, ['AS-COL-02']),
    )
    expect(out.frames[0]!.findings).toContainEqual(expect.objectContaining({ kind: 'lint', score: 40 }))
    expect(out.frames[0]!.item?.status).toBe('active')
  })

  it('keeps the item a draft under draft', async () => {
    const r = rules((x) => ((x.lint.gate = 'draft'), (x.lint.minScore = 70)))
    const out = await stageLint(
      plan(r),
      () => frame.html,
      r,
      async () => lintResult(40, ['AS-COL-02']),
    )
    expect(out.frames[0]!.item?.status).toBe('draft')
    expect(out.totals.drafts).toBe(1)
  })

  it('never calls the linter when off', async () => {
    const r = rules((x) => (x.lint.gate = 'off'))
    const lint = vi.fn(async () => lintResult(0, ['X']))
    await stageLint(plan(r), () => frame.html, r, lint)
    expect(lint).not.toHaveBeenCalled()
  })

  it('filters the ignored rules', async () => {
    const r = rules((x) => ((x.lint.gate = 'draft'), (x.lint.minScore = 70), (x.lint.ignoreRules = ['AS-COL-02'])))
    const out = await stageLint(
      plan(r),
      () => frame.html,
      r,
      async () => lintResult(40, ['AS-COL-02']),
    )
    expect(out.frames[0]!.item?.status).toBe('active')
  })
})
