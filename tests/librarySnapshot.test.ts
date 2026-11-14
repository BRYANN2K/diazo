import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types'
import type { LibrarySnapshot } from '../shared/librarySnapshot'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas, type FrameSpec } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const snapshots = await import('../server/librarySnapshot.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }
const FIXTURES: FrameSpec[] = [{ fixture: 'sheet-static' }, { fixture: 'sheet-scripted' }, { fixture: 'card-exploded' }]

/* what the browser took of the dark login variant (recorded) */
const RECORDED: LibrarySnapshot = {
  html: '<div class="v dk"><span class="b">Log in</span></div>',
  ancestors: [],
  rootClasses: [],
  rootAttrs: [],
  rules: ['.v { width: 490px; height: 300px; }', '.v.dk { background: rgb(9, 9, 11); }'],
  keyframes: [],
  fontFaces: [],
  vars: [],
  inherited: [['color', 'rgb(0, 0, 0)']],
  defs: [],
  found: true,
  scripted: true,
}

const TARGET =
  '<!doctype html><html><head></head><body><main data-doop-id="mmmmmm"><h1 data-doop-id="hhhhhh">Hi</h1></main><footer data-doop-id="ffffff">f</footer></body></html>'

let project: Canvas

async function seed() {
  const lib = libraryCanvas(FIXTURES, { id: 'lib1', ownerId: 'owner' })
  for (const f of lib.frames) fakeDb.html.set(f.id, f.html)
  project = {
    id: 'proj',
    name: 'Project',
    ownerId: 'owner',
    createdAt: 1,
    updatedAt: 1,
    pages: [{ id: 'p1', name: 'Page 1' }],
    frames: [
      {
        id: 'target',
        canvasId: 'proj',
        pageId: 'p1',
        name: 'Login',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        html: TARGET,
        createdAt: 1,
        updatedAt: 1,
        updatedBy: 'x',
      } as Frame,
    ],
  }
  store.init([lib, project])
  libraries.createLibrary('lib1', { preset: 'sheets' }, actor)
  await indexer.reindexLibrary('lib1')
}

const item = async (id: string) => (await indexer.libraryItems('lib1')).find((i) => i.itemId === id)!

beforeEach(async () => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
  snapshots.setSnapshotRenderer({ available: () => true, snapshot: async () => RECORDED })
  await seed()
})

describe('the server insert', () => {
  it('lands after the named element, with provenance and fresh ids', async () => {
    const done = await snapshots.insertItem({
      item: await item('bk.scb-login-social-with-email-option'),
      frameId: 'target',
      afterElementId: 'mmmmmm',
      actor,
    })
    expect(done.fidelity).toBe('rendered')
    const html = store.getFrame('target')!.html
    const at = html.indexOf('data-doop-ref="bk.scb-login-social-with-email-option"')
    expect(at).toBeGreaterThan(html.indexOf('</main>'))
    expect(at).toBeLessThan(html.indexOf('<footer'))
    expect(html).toContain('data-doop-ref-lib="lib1"')
    expect(html).toContain('data-doop-ref-rev="1"')
    expect(html).toContain(`data-doop-id="${done.elementId}"`)
    const ids = [...html.matchAll(/data-doop-id="(\w+)"/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('lands before </body> without an element, and counts a use', async () => {
    const it0 = await item('bk.scb-login-minimal-email-password')
    await snapshots.insertItem({ item: it0, frameId: 'target', actor })
    const html = store.getFrame('target')!.html
    expect(html.indexOf('data-doop-ref=')).toBeGreaterThan(html.indexOf('<footer'))
    expect(html.indexOf('data-doop-ref=')).toBeLessThan(html.indexOf('</body>'))
    expect((await indexer.itemMeta('lib1', it0.itemId))?.useCount).toBe(1)
  })

  it('refuses a locked frame and a reference kind', async () => {
    store.getFrame('target')!.locked = true
    await expect(snapshots.insertItem({ item: await item('bk.scb-login'), frameId: 'target', actor })).rejects.toThrow(
      /locked/,
    )
    store.getFrame('target')!.locked = false
    const ref = { ...(await item('bk.scb-login')), kind: 'rs' }
    await expect(snapshots.insertItem({ item: ref, frameId: 'target', actor })).rejects.toThrow(/reference/)
  })

  it('withdraws sign-off and files a version, as any design write', async () => {
    store.getFrame('target')!.approval = { status: 'ready_for_dev', by: 'x', at: 1 } as unknown as Frame['approval']
    const done = await snapshots.insertItem({ item: await item('bk.scb-login'), frameId: 'target', actor })
    expect(done.approvalWithdrawn).toBe(true)
    expect(store.getFrame('target')!.approval?.status).toBe('needs_review')
    expect(fakeDb.versions.some((v) => v.frameId === 'target' && v.html === TARGET)).toBe(true)
  })

  it('falls back to the static copy without a renderer, and says so', async () => {
    snapshots.setSnapshotRenderer({ available: () => false, snapshot: async () => null })
    const done = await snapshots.insertItem({
      item: await item('bk.scb-login-minimal-email-password'),
      frameId: 'target',
      actor,
    })
    expect(done.fidelity).toBe('static')
    const html = store.getFrame('target')!.html
    /* the design, not its caption; its symbol along; nothing that runs */
    expect(html).toContain('class="v"')
    expect(html).not.toContain('420px column, focus ring 4px')
    expect(html).toContain('id="bk.scb-login-minimal-email-password-')
    expect(html).not.toContain('onclick')
    expect(html).toContain('@scope ([data-doop-ref="bk.scb-login-minimal-email-password"])')
  })
})

describe('static pieces', () => {
  it('splits a stylesheet into rules, keyframes and font faces', () => {
    expect(
      snapshots.splitCss(
        '.a{x:1} @keyframes pu { 50% { opacity: .4 } } @font-face { font-family: X } @media (x) { .b { y: 2 } }',
      ),
    ).toEqual({
      rules: ['.a{x:1}', '@media (x) { .b { y: 2 } }'],
      keyframes: ['@keyframes pu { 50% { opacity: .4 } }'],
      fontFaces: ['@font-face { font-family: X }'],
    })
  })

  it('places a block by source offsets, leaving the rest byte for byte', () => {
    const out = snapshots.placeBlock(TARGET, '<div>X</div>', 'hhhhhh')!
    expect(out).toBe(TARGET.replace('Hi</h1>', 'Hi</h1><div>X</div>'))
    expect(() => snapshots.placeBlock(TARGET, '<div>X</div>', 'nope')).toThrow(/no element/)
  })
})
