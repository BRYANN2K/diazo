import { describe, expect, it } from 'vitest'
import { applyPatch, diffFromEdits, diffReplace, patchPathProblem, summarizePatch } from '../shared/patch.ts'

const css = [
  ':root {',
  '  --a: 1;',
  '  --b: 2;',
  '  --c: 3;',
  '}',
  '',
  '.x {}',
  '',
  '',
  '',
  '',
  '.dark {',
  '  --a: 9;',
  '}',
].join('\n')

describe('diffFromEdits', () => {
  it('writes one hunk per edit cluster with three lines of context', () => {
    const patch = diffFromEdits('src/app.css', `${css}\n`, [
      { start: 2, end: 3, lines: ['  --b: 20;'] },
      { start: 12, end: 13, lines: ['  --a: 90;'] },
    ])
    expect(patch).toBe(
      [
        '--- a/src/app.css',
        '+++ b/src/app.css',
        '@@ -1,6 +1,6 @@',
        ' :root {',
        '   --a: 1;',
        '-  --b: 2;',
        '+  --b: 20;',
        '   --c: 3;',
        ' }',
        ' ',
        '@@ -10,5 +10,5 @@',
        ' ',
        ' ',
        ' .dark {',
        '-  --a: 9;',
        '+  --a: 90;',
        ' }',
        '',
      ].join('\n'),
    )
    expect(summarizePatch(patch).files).toEqual([{ path: 'src/app.css', create: false, added: 2, removed: 2 }])
  })

  it('answers empty when an edit changes nothing', () => {
    expect(diffFromEdits('a.css', 'x\n', [{ start: 0, end: 1, lines: ['x'] }])).toBe('')
  })

  it('refuses overlapping or out-of-range edits', () => {
    expect(() =>
      diffFromEdits('a.css', 'a\nb\n', [
        { start: 0, end: 2, lines: [] },
        { start: 1, end: 2, lines: [] },
      ]),
    ).toThrow(/overlapping/)
    expect(() => diffFromEdits('a.css', 'a\n', [{ start: 0, end: 5, lines: [] }])).toThrow(/range/)
  })
})

describe('applyPatch', () => {
  it('round-trips edits, insertions and new files', () => {
    const before = `${css}\n`
    const patch =
      diffFromEdits('src/app.css', before, [
        { start: 2, end: 3, lines: ['  --b: 20;'] },
        { start: 4, end: 4, lines: ['  --d: 4;'] },
      ]) + diffReplace('src/components/Hero.tsx', null, 'export function Hero() {}\n')
    const out = applyPatch(patch, (p) => (p === 'src/app.css' ? before : null))
    expect(out.get('src/app.css')).toBe(
      before.replace('--b: 2;', '--b: 20;').replace('  --c: 3;\n', '  --c: 3;\n  --d: 4;\n'),
    )
    expect(out.get('src/components/Hero.tsx')).toBe('export function Hero() {}\n')
    expect(summarizePatch(patch).files.map((f) => [f.path, f.create])).toEqual([
      ['src/app.css', false],
      ['src/components/Hero.tsx', true],
    ])
  })

  it('refuses a file that changed since, a creation over an existing file, and a missing target', () => {
    const patch = diffFromEdits('a.css', 'a\nb\n', [{ start: 1, end: 2, lines: ['c'] }])
    expect(() => applyPatch(patch, () => 'a\nX\n')).toThrow(/changed since/)
    expect(() => applyPatch(patch, () => null)).toThrow(/missing/)
    const create = diffReplace('n.ts', null, 'x\n')
    expect(() => applyPatch(create, () => 'already\n')).toThrow(/exists/)
  })

  it('replaces a whole existing file', () => {
    const patch = diffReplace('a.tsx', 'old\nlines\n', 'new\n')
    expect(applyPatch(patch, () => 'old\nlines\n').get('a.tsx')).toBe('new\n')
  })
})

describe('summarizePatch', () => {
  it('rejects malformed and unsafe patches', () => {
    expect(() => summarizePatch('')).toThrow(/empty/)
    expect(() => summarizePatch('garbage\n')).toThrow(/---/)
    expect(() => summarizePatch('--- a/x\n+++ b/y\n@@ -1,1 +1,1 @@\n-a\n+b\n')).toThrow(/differ/)
    expect(() => summarizePatch('--- a/../x\n+++ b/../x\n@@ -1,1 +1,1 @@\n-a\n+b\n')).toThrow(/dot/)
    expect(() => summarizePatch('--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n-a\n')).toThrow(/early/)
    expect(() => summarizePatch('--- a/x\n+++ b/x\n')).toThrow(/no hunks/)
  })

  it('keeps patches out of skipped and absolute paths', () => {
    expect(patchPathProblem('node_modules/x/index.js')).not.toBeNull()
    expect(patchPathProblem('.git/config')).not.toBeNull()
    expect(patchPathProblem('/etc/hosts')).not.toBeNull()
    expect(patchPathProblem('src/app.css')).toBeNull()
  })
})
