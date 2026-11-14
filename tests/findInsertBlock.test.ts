// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { LibrarySnapshot } from '../src/lib/findPreviewRuntime'

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

const { insertLibraryBlock, libraryBlock, refId } = await import('../src/lib/findInsert')

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

const FRAME =
  '<!doctype html><html><head></head><body><p data-doop-id="aaaaaa">Hello <span>you</span></p><main data-doop-id="bbbbbb"><h1>Login</h1></main></body></html>'

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

describe('insertLibraryBlock', () => {
  it('lands after the picked element with fresh ids and no library editor state', () => {
    const done = insertLibraryBlock(FRAME, 'body > main', libraryBlock(snap(), 'cp.btn'))!
    const doc = new DOMParser().parseFromString(done.html, 'text/html')
    const block = doc.querySelector(done.selector)!
    expect(block.previousElementSibling?.tagName).toBe('MAIN')
    const ids = [...doc.querySelectorAll('[data-doop-id]')].map((el) => el.getAttribute('data-doop-id'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain('abc123')
    expect(block.querySelector('button')!.hasAttribute('data-doop-on')).toBe(false)
    expect(block.querySelector('style')!.hasAttribute('data-doop-id')).toBe(false)
    expect([block, ...block.querySelectorAll(':not(style)')].every((el) => el.hasAttribute('data-doop-id'))).toBe(true)
  })

  it('appends to the body when nothing is picked, or when the anchor cannot hold a block', () => {
    const atEnd = insertLibraryBlock(FRAME, null, libraryBlock(snap(), 'cp.btn'))!
    const doc = new DOMParser().parseFromString(atEnd.html, 'text/html')
    expect(doc.body.lastElementChild?.getAttribute('data-doop-ref')).toBe('cp.btn')
    /* inside a <p> a div would split the paragraph: the body takes it */
    const inP = insertLibraryBlock(FRAME, 'body > p > span', libraryBlock(snap(), 'cp.btn'))!
    const after = new DOMParser().parseFromString(inP.html, 'text/html')
    expect(after.querySelector('p')!.outerHTML).toBe('<p data-doop-id="aaaaaa">Hello <span>you</span></p>')
    expect(after.body.lastElementChild?.getAttribute('data-doop-ref')).toBe('cp.btn')
  })
})
