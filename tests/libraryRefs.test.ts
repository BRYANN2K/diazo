// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { refsIn, replaceBlock, revKey, staleRefs } from '../src/lib/libraryRefs'

const HTML = `<!doctype html><html><body>
  <div data-doop-ref="bk.a" data-doop-ref-lib="lib1" data-doop-ref-rev="2" data-doop-id="aaaaaa">
    <p>A</p>
    <div data-doop-ref="cp.b" data-doop-ref-lib="lib1" data-doop-ref-rev="1" data-doop-id="bbbbbb"><span>B</span></div>
  </div>
  <div data-doop-ref="cp.old" data-doop-id="cccccc">old, no library</div>
  <div data-doop-ref="cp.norev" data-doop-ref-lib="lib1" data-doop-id="dddddd">no rev</div>
  <footer data-doop-id="ffffff">end</footer>
</body></html>`

describe('library refs', () => {
  it('reads nested blocks', () => {
    expect(refsIn(HTML)).toEqual([
      { elementId: 'aaaaaa', ref: 'bk.a', libraryId: 'lib1', rev: 2 },
      { elementId: 'bbbbbb', ref: 'cp.b', libraryId: 'lib1', rev: 1 },
      { elementId: 'dddddd', ref: 'cp.norev', libraryId: 'lib1', rev: null },
    ])
  })

  it('never calls a block without a revision stale', () => {
    const revs = new Map([
      [revKey('lib1', 'bk.a'), 2],
      [revKey('lib1', 'cp.b'), 3],
      [revKey('lib1', 'cp.norev'), 9],
    ])
    expect(staleRefs(refsIn(HTML), revs).map((r) => r.ref)).toEqual(['cp.b'])
  })

  it('replaces a block in place, keeping its id', () => {
    const out = replaceBlock(HTML, 'bbbbbb', '<div data-doop-ref="cp.b" data-doop-ref-rev="3"><em>new</em></div>')!
    expect(out).toContain('<div data-doop-ref="cp.b" data-doop-ref-rev="3" data-doop-id="bbbbbb"><em>new</em></div>')
    expect(out.indexOf('bbbbbb')).toBeLessThan(out.indexOf('cccccc'))
    expect(replaceBlock(HTML, 'nope', '<div></div>')).toBeNull()
  })
})
