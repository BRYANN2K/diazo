import { expect, it } from 'vitest'
import { applyEditOps, replaceValues, splitDecls, tokenCoverage } from '../server/scriptDom.ts'
import type { DesignToken } from '../shared/designTokens.ts'

const token = (name: string, type: DesignToken['type'], value: string): DesignToken =>
  ({ name, type, value }) as DesignToken

it('a style op on a self-closing svg element splices before the slash', () => {
  const html = '<html><body><svg width="10" height="10"><path data-doop-id="p" d="M0 0h10"/></svg></body></html>'
  const out = applyEditOps(html, [{ op: 'style', element: 'p', property: 'fill', value: 'red' }])
  expect(out.applied).toBe(1)
  expect(out.html).toContain('fill: red')
  /* the slash survived, and nothing was spliced between / and > */
  expect(out.html).toMatch(/<path[^>]*\/>/)
  expect(out.html).not.toContain('/ style')
})

it('a semicolon inside a data URL does not split style declarations', () => {
  const decls = splitDecls('background: url(data:image/svg+xml;base64,PHN2Zz4=); color: red')
  expect(decls).toEqual(['background: url(data:image/svg+xml;base64,PHN2Zz4=)', 'color: red'])
  const html =
    '<html><body><div data-doop-id="d" style="background: url(data:image/svg+xml;base64,PHN2Zz4=); color: red"></div></body></html>'
  const out = applyEditOps(html, [{ op: 'style', element: 'd', property: 'color', value: 'blue' }])
  expect(out.applied).toBe(1)
  expect(out.html).toContain('url(data:image/svg+xml;base64,PHN2Zz4=)')
  expect(out.html).toContain('color: blue')
})

it('replaceValues maps literals only to tokens of their own type', () => {
  const html = '<html><body><div style="font-size: 16px; border-radius: 16px; color: #112233"></div></body></html>'
  const tokens = [
    token('--radius-md', 'radius', '16px'),
    token('--ink', 'color', '#112233'),
    /* no fontSize token — the 16px font-size must stay put */
  ]
  const out = replaceValues(html, tokens, { kinds: ['fontSize', 'color', 'radius'] })
  expect(out.html).toContain('border-radius: var(--radius-md)')
  expect(out.html).toContain('color: var(--ink)')
  expect(out.html).toContain('font-size: 16px')
  expect(out.unmapped).toEqual([{ value: '16px', kind: 'fontSize' }])
})

it('replaceValues never rewrites inside url()', () => {
  /* a raw # inside the data URL is exactly what the color matcher would eat */
  const dataUrl = "data:image/svg+xml,<svg fill='#112233' xmlns='http://www.w3.org/2000/svg'/>"
  const html = `<html><body><div style="background: url(${dataUrl}); color: #112233"></div></body></html>`
  const out = replaceValues(html, [token('--ink', 'color', '#112233')], { kinds: ['color'] })
  expect(out.html).toContain(`url(${dataUrl})`)
  expect(out.html).toContain('color: var(--ink)')
})

it('a style op keeps a data URL inside url() intact', () => {
  const html = '<html><body><div data-doop-id="d"></div></body></html>'
  const out = applyEditOps(html, [
    { op: 'style', element: 'd', property: 'background', value: 'url("data:image/png;base64,AAAA")' },
  ])
  expect(out.applied).toBe(1)
  expect(out.failed).toHaveLength(0)
  /* the ;base64 is the data — quotes may be entity-escaped, the semicolon
     must not be eaten as a declaration split */
  expect(out.html).toContain('data:image/png;base64,AAAA')
})

it('a style op refuses a second declaration smuggled into the value', () => {
  const html = '<html><body><div data-doop-id="d" style="display: block"></div></body></html>'
  const out = applyEditOps(html, [{ op: 'style', element: 'd', property: 'color', value: 'red; position: fixed' }])
  expect(out.applied).toBe(0)
  expect(out.failed).toHaveLength(1)
  expect(out.html).toBe(html)
  /* the same refusal for a brace — it would end the declaration early */
  const braced = applyEditOps(html, [{ op: 'style', element: 'd', property: 'color', value: 'red } * {' }])
  expect(braced.applied).toBe(0)
  expect(braced.html).toBe(html)
})

it('replaceValues never rewrites a custom property declaration', () => {
  const html =
    '<html><head><style>:root{--text-color: #111111}</style></head>' +
    '<body><div style="--card-background: #111111; color: #111111"></div></body></html>'
  const out = replaceValues(
    html,
    [token('--text-color', 'color', '#111111'), token('--card-background', 'color', '#111111')],
    { kinds: ['color'] },
  )
  /* a custom property holds a value, not a declaration to tokenise —
     rewriting it as var(--itself) or var(--other) corrupts the theme */
  expect(out.html).toContain('--text-color: #111111')
  expect(out.html).toContain('--card-background: #111111')
  expect(out.html).toContain('color: var(--text-color)')
  expect(out.count).toBe(1)
})

it('replaceValues reaches the *-color and spacing longhands', () => {
  const html =
    '<html><body><div style="background-color: #111111; border-color: #111111; ' +
    'border-bottom: 1px solid #111111; outline-color: #111111; padding-left: 16px; ' +
    'margin-top: 16px; inset-block-start: 16px"></div></body></html>'
  const out = replaceValues(html, [token('--ink', 'color', '#111111'), token('--s4', 'spacing', '16px')], {
    kinds: ['color', 'spacing'],
  })
  expect(out.html).toContain('background-color: var(--ink)')
  expect(out.html).toContain('border-color: var(--ink)')
  expect(out.html).toContain('border-bottom: 1px solid var(--ink)')
  expect(out.html).toContain('outline-color: var(--ink)')
  expect(out.html).toContain('padding-left: var(--s4)')
  expect(out.html).toContain('margin-top: var(--s4)')
  expect(out.html).toContain('inset-block-start: var(--s4)')
  expect(out.count).toBe(7)
})

it('tokenCoverage agrees with replaceValues on the longhands', () => {
  const html =
    '<html><body><div style="background-color: #111111; outline-color: #111111; ' +
    'margin-top: 16px; padding-left: 16px"></div></body></html>'
  /* coverage counts these literals — replaceValues must be able to retire
     every one, or a frame can never reach full coverage */
  expect(tokenCoverage(html)).toBe(0)
  const out = replaceValues(html, [token('--ink', 'color', '#111111'), token('--s4', 'spacing', '16px')], {
    kinds: ['color', 'spacing'],
  })
  expect(tokenCoverage(out.html)).toBe(1)
})

it('replaceValues only touches real style declarations, never lookalike text', () => {
  const html =
    '<html><body>' +
    '<div data-doop-id="d" style="color: #112233"></div>' +
    '<div data-style="color: #112233"></div>' +
    '<p>set style="color: #112233" later</p>' +
    `<script>var s = 'style="color: #112233"';</script>` +
    '</body></html>'
  const out = replaceValues(html, [token('--ink', 'color', '#112233')], { kinds: ['color'] })
  expect(out.count).toBe(1)
  expect(out.html).toContain('style="color: var(--ink)"')
  expect(out.html).toContain('data-style="color: #112233"')
  expect(out.html).toContain('<p>set style="color: #112233" later</p>')
  expect(out.html).toContain(`var s = 'style="color: #112233"';`)
})
