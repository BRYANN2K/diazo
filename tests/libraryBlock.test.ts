// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { libraryBlock, refId, REF_LIB_ATTR, REF_REV_ATTR } from '../shared/libraryBlock'
import { takeLibrarySnapshot, type LibrarySnapshot } from '../shared/librarySnapshot'
import { fixture } from './libraryFixtures'

const snap = (over: Partial<LibrarySnapshot> = {}): LibrarySnapshot => ({
  html: '<button class="btn" data-doop-id="abc123" data-doop-on="click" id="go"><span>Buy</span></button>',
  ancestors: [{ tag: 'div', attrs: [['class', 'ex']] }],
  rootClasses: ['dark'],
  rootAttrs: [['data-theme', 'dark']],
  rules: ['.ex .btn { color: var(--brand); }', '@media (min-width: 600px) { .btn { padding: 8px; } }'],
  keyframes: ['@keyframes pulse { from { opacity: 0 } }'],
  fontFaces: [],
  vars: [['--brand', '#0177d3']],
  inherited: [['font-family', 'Inter']],
  found: true,
  scripted: false,
  ...over,
})

describe('libraryBlock', () => {
  it('wraps the item in its ancestors and scopes its CSS to the reference', () => {
    const block = libraryBlock(snap(), 'cp.vui-button-primary')
    expect(block).toMatch(
      /^<div data-doop-ref="cp.vui-button-primary" data-doop-name="cp.vui-button-primary" class="dark" data-theme="dark">/,
    )
    expect(block).toContain('@scope ([data-doop-ref="cp.vui-button-primary"]) {')
    expect(block).toContain(':scope { --brand: #0177d3; font-family: Inter; }')
    expect(block).toContain('@keyframes pulse')
    expect(block).toContain('<div class="ex" style="display: contents"><button')
  })

  it('keeps reference ids attribute-safe', () => {
    expect(refId('cp.vui"button <x>')).toBe('cp.vui-button--x-')
  })
})

describe('provenance and definitions', () => {
  it('carries the reference, the library and the revision on the wrapper', () => {
    const block = libraryBlock(snap(), { ref: 'cp.btn', libraryId: 'lib1', rev: 3 })
    const el = new DOMParser().parseFromString(block, 'text/html').body.firstElementChild!
    expect(el.getAttribute('data-doop-ref')).toBe('cp.btn')
    expect(el.getAttribute(REF_LIB_ATTR)).toBe('lib1')
    expect(el.getAttribute(REF_REV_ATTR)).toBe('3')
  })

  it('ships the definitions with ids prefixed per insert', () => {
    const withDefs = snap({
      html: '<span class="b">Sign in<svg class="ic"><use href="#key"></use></svg></span>',
      rules: ['.ic { fill: url(#grad) }'],
      defs: [
        '<symbol id="key" viewBox="0 0 24 24"><path d="M2 12h20"></path></symbol>',
        '<linearGradient id="grad"></linearGradient>',
      ],
    })
    const one = libraryBlock(withDefs, { ref: 'bk.x', prefix: 'a1-' })
    const two = libraryBlock(withDefs, { ref: 'bk.x', prefix: 'b2-' })
    expect(one).toContain('<symbol id="a1-key"')
    expect(one).toContain('href="#a1-key"')
    expect(one).toContain('url(#a1-grad)')
    expect(two).toContain('<symbol id="b2-key"')
    expect(one).toMatch(/<svg width="0" height="0" aria-hidden="true"/)
  })

  it('leaves an old block shape alone: no library, no revision', () => {
    const block = libraryBlock(snap(), 'cp.old')
    expect(block).not.toContain(REF_LIB_ATTR)
    expect(block).not.toContain(REF_REV_ATTR)
  })
})

describe('takeLibrarySnapshot', () => {
  it('copies the defs a variant uses, and nothing that runs', () => {
    document.open()
    document.write(fixture('sheet-static'))
    document.close()
    const v = document.querySelectorAll('.v')
    const first = takeLibrarySnapshot(v[0]!)
    expect(first.defs?.join('')).toContain('id="key"')
    const second = takeLibrarySnapshot(v[1]!)
    expect(second.html).not.toContain('onclick')
    expect(second.rules.join('\n')).not.toContain('.unused')
  })
})
