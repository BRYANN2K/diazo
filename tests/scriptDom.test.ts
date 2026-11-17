import { expect, it } from 'vitest'
import { applyEditOps, replaceValues, splitDecls } from '../server/scriptDom.ts'
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
