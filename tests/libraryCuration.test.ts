import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  editPlan,
  parseAssignments,
  parseTree,
  planView,
  type CurationEntry,
  type CurationPlan,
} from '../shared/libraryCuration'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas, type FrameSpec } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const curation = await import('../server/libraryCuration.ts')

const OWNER = 'u1'

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`

/** Two sources: a hero and a pricing block each, one hero copied across,
 *  a section header and an index frame that are not items. */
function seed() {
  const a = libraryCanvas(
    [
      { id: 'a1', name: '§ 16 — Heroes', html: page('§'), page: 'pa', height: 88 },
      {
        id: 'a2',
        name: 'hero.x-ai — AI hero',
        html: page('<h1>Ship AI agents faster</h1><p>Start free today</p>'),
        page: 'pa',
      },
      {
        id: 'a3',
        name: 'bk.x-pricing — Pricing',
        html: page('<h2>Simple pricing for every team size</h2>'),
        page: 'pb',
      },
      { id: 'a4', name: 'INDEX — all', html: page('index'), page: 'pb' },
    ],
    {
      id: 'srcA',
      name: 'Design Library',
      ownerId: OWNER,
      pages: [
        { id: 'pa', name: '01 Heroes · AI products · A–L' },
        { id: 'pb', name: '16 Marketing sections · Pricing' },
      ],
    },
  )
  const b = libraryCanvas(
    [
      /* the same hero, copied with a stamped id: a duplicate */
      {
        id: 'b1',
        name: 'hero.x-ai — AI hero',
        html: page('<h1 data-doop-id="e1">Ship AI agents faster</h1><p>Start free today</p>'),
        page: 'pc',
      },
      {
        id: 'b2',
        name: 'cp.x-button — Button',
        html: page('<button>Buy now and save more today</button>'),
        page: 'pc',
      },
      /* a card of the button family: it joins its family */
      {
        id: 'b3',
        name: 'cp.x-button-dark — Button dark',
        html: page('<button class="dark">Buy now dark variant here</button>'),
        page: 'pc',
      },
      { id: 'b4', name: 'bk.x-faq — FAQ', html: page('<h2>Frequently asked questions about billing</h2>'), page: 'pc' },
    ],
    {
      id: 'srcB',
      name: 'Design Library · A UI components',
      ownerId: OWNER,
      pages: [{ id: 'pc', name: '02 Components' }],
    },
  )
  for (const f of [...a.frames, ...b.frames]) fakeDb.html.set(f.id, f.html)
  store.init([a, b])
  return { a: store.getCanvas('srcA')!, b: store.getCanvas('srcB')! }
}

const TREE = JSON.stringify({
  categories: [
    { name: '01 Heroes', children: [{ name: 'AI products · A–L' }, { name: 'Fintech' }] },
    { name: 'Sections', children: [{ name: 'Pricing' }, { name: 'FAQ' }] },
    { name: 'Components', children: [{ name: 'Buttons' }] },
  ],
})

/** Files a line by its words, the way a model would. */
function fileLines(user: string, system: string): string {
  const idOf = (path: string) => new RegExp(`^(c\\d+) ${path}$`, 'm').exec(system)?.[1] ?? 'none'
  const a: Record<string, string> = {}
  for (const line of user.split('\n')) {
    const [n, label = ''] = line.split('|')
    const l = label.toLowerCase()
    a[n!] = l.includes('hero')
      ? idOf('Heroes/AI products')
      : l.includes('pricing')
        ? idOf('Sections/Pricing')
        : l.includes('faq')
          ? idOf('Sections/FAQ')
          : l.includes('button')
            ? idOf('Components/Buttons')
            : 'none'
  }
  return JSON.stringify({ a })
}

function stubModels(opts: { tree?: () => string; file?: (user: string, system: string) => string } = {}) {
  const calls = { main: 0, bulk: 0 }
  const usage = { model: 'stub', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
  curation.setCurationModels(async () => ({
    main: {
      label: 'Stub (main)',
      complete: async () => {
        calls.main++
        return { text: (opts.tree ?? (() => TREE))(), usage }
      },
    },
    bulk: {
      label: 'Stub (bulk)',
      complete: async (turn) => {
        calls.bulk++
        return { text: (opts.file ?? fileLines)(turn.user, turn.system), usage }
      },
    },
  }))
  return calls
}

async function finished(id: string) {
  await curation.curationSettled(id)
  return curation.getCuration(id)!
}

beforeEach(() => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  curation.resetCurationsForTest()
  curation.setCurationModels(null)
  fakeDb.reset()
})

describe('reading the model', () => {
  it('reads a tree strictly: clean names, three levels, merged siblings', () => {
    const tree = parseTree(
      'Sure! ```json\n' +
        JSON.stringify({
          categories: [
            { name: '16 Pricing' },
            { name: 'pricing', children: [{ name: 'Tiers' }] },
            { name: 'A/B', children: [{ name: 'X', children: [{ name: 'Y', children: [{ name: 'Too deep' }] }] }] },
            { name: '' },
            { name: 42 },
          ],
        }) +
        '\n```',
    )
    expect(tree.map((n) => n.name)).toEqual(['Pricing', 'A B'])
    expect(tree[0]!.children.map((n) => n.name)).toEqual(['Tiers'])
    expect(tree[1]!.children[0]!.children[0]!.children).toEqual([])
    expect(new Set(JSON.stringify(tree).match(/c\d+/g)).size).toBe(5)
  })

  it('refuses an answer with no usable tree', () => {
    expect(() => parseTree('no idea')).toThrow()
    expect(() => parseTree('{"categories":[{"name":"Only"}]}')).toThrow()
    expect(() => parseTree('{"categories":"x"}')).toThrow()
  })

  it('keeps only line numbers of the batch and ids of the tree', () => {
    const ids = new Set(['c1', 'c2'])
    expect([...parseAssignments('{"a":{"1":"c1","2":"none","3":"c9","4":"c2","9":"c1"}}', 4, ids)]).toEqual([
      [1, 'c1'],
      [4, 'c2'],
    ])
    expect([...parseAssignments('{"a":[[1,"c2"],{"n":2,"c":"c1"}]}', 2, ids)]).toEqual([
      [1, 'c2'],
      [2, 'c1'],
    ])
    expect(() => parseAssignments('nope', 2, ids)).toThrow()
  })
})

describe('gathering', () => {
  it('drops scripts and styles from the text', () => {
    expect(
      curation.visibleText('<style>a{}</style><script>x()</script><p>Hi &amp; bye</p><svg><text>no</text></svg>'),
    ).toBe('Hi & bye')
  })

  it('folds duplicates across sources and keeps a family together', () => {
    const frames: Parameters<typeof curation.buildEntries>[0] = [
      {
        canvasId: 'A',
        frame: { id: 'a', name: 'hero.x — Hero', width: 1, height: 1 },
        pageName: 'P',
        html: '<h1>Big hero title for testing</h1>',
      },
      {
        canvasId: 'B',
        frame: { id: 'b', name: 'hero.x — Hero', width: 1, height: 1 },
        pageName: 'Q',
        html: '<h1  data-doop-id="z">Big hero title for testing</h1>',
      },
      {
        canvasId: 'B',
        frame: { id: 'c', name: 'Hero copy', width: 1, height: 1 },
        pageName: 'Q',
        html: '<div><h1>Big hero title for testing</h1></div>',
      },
      {
        canvasId: 'C',
        frame: { id: 'd', name: 'Hero', width: 1, height: 1 },
        pageName: 'Q',
        html: '<section><h1>Big hero title for testing</h1></section>',
      },
      { canvasId: 'B', frame: { id: 'e', name: 'cp.y — Y', width: 1, height: 1 }, pageName: 'Q', html: '<p>y</p>' },
      {
        canvasId: 'B',
        frame: { id: 'f', name: 'cp.y-dark — Y dark', width: 1, height: 1 },
        pageName: 'Q',
        html: '<p>y dark</p>',
      },
    ]
    const { entries, duplicates } = curation.buildEntries(frames)
    expect(entries.map((e) => e.key)).toEqual(['A:a', 'B:c', 'B:e'])
    expect(duplicates).toEqual([
      { keep: 'A:a', dropped: { canvasId: 'B', frameId: 'b', name: 'hero.x — Hero' }, reason: 'same-html' },
      { keep: 'A:a', dropped: { canvasId: 'C', frameId: 'd', name: 'Hero' }, reason: 'same-content' },
    ])
    const family = entries.find((e) => e.key === 'B:e')!
    expect(family.frames.map((f) => f.frameId)).toEqual(['e', 'f'])
    expect(family.variants).toBe(1)
  })

  it('reads a source library index for families and cards', () => {
    const base = {
      canvasId: 'L',
      pageId: 'p',
      position: 0,
      description: '',
      kind: '',
      source: '',
      category: '',
      tags: [],
      mode: 'snapshot' as const,
      locator: { whole: true as const },
      box: null,
      scripted: false,
      status: 'active' as const,
      findings: [],
      hash: '',
      rev: 1,
      searchText: '',
      sourceUrl: null,
      license: null,
      indexedAt: 0,
    }
    const map = curation.indexedFrames([
      { ...base, itemId: 'cp.a', parentId: null, frameId: 'f1', label: 'A' },
      { ...base, itemId: 'cp.a-1', parentId: 'cp.a', frameId: 'f1', label: 'A1' },
      { ...base, itemId: 'cp.a-dark', parentId: 'cp.a', frameId: 'f2', label: 'A dark' },
    ])
    expect(map.get('f1')).toMatchObject({ itemId: 'cp.a', parentId: null, variants: 2 })
    expect(map.get('f2')).toMatchObject({ itemId: 'cp.a-dark', parentId: 'cp.a', variants: 0 })
  })

  it('samples every source page for the tree', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, sourcePage: `p${i % 4}` }) as CurationEntry)
    const sample = curation.treeSample(entries, 20)
    expect(sample).toHaveLength(20)
    expect(new Set(sample.map((e) => e.sourcePage)).size).toBe(4)
  })
})

describe('a curation job', () => {
  it('proposes a tree, files every item, records the duplicates and writes no source', async () => {
    const { a, b } = seed()
    const before = [...a.frames, ...b.frames].map((f) => [f.id, f.updatedAt, f.pageId, f.name])
    const calls = stubModels()
    const job = await curation.startCuration({ ownerId: OWNER, sourceIds: ['srcA', 'srcB'] })
    expect(job.name).toBe('Design Library (curated)')
    const done = await finished(job.id)
    expect(done.status).toBe('ready')
    expect(done.error).toBeNull()
    expect(calls).toEqual({ main: 1, bulk: 1 })
    expect(done.calls).toBe(2)
    expect(done.usage).toEqual([
      { model: 'stub', inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ])
    const plan = done.plan!
    /* the header and the index are not items; the copied hero is folded */
    expect(plan.entries.map((e) => e.key)).toEqual(['srcA:a2', 'srcA:a3', 'srcB:b2', 'srcB:b4'])
    expect(plan.duplicates).toEqual([
      {
        keep: 'srcA:a2',
        dropped: { canvasId: 'srcB', frameId: 'b1', name: 'hero.x-ai — AI hero' },
        reason: 'same-html',
      },
    ])
    expect(plan.entries.find((e) => e.key === 'srcB:b2')!.frames.map((f) => f.frameId)).toEqual(['b2', 'b3'])
    const view = planView(plan)
    expect(view.tree.map((n) => n.name)).toEqual(['Heroes', 'Sections', 'Components'])
    expect(view.tree[0]!.children.map((n) => n.name)).toEqual(['AI products', 'Fintech'])
    expect(view.totals).toMatchObject({ entries: 4, frames: 5, duplicates: 1, unclassified: 0, pages: 4 })
    expect(view.tree[1]).toMatchObject({ count: 2, own: 0 })
    expect([...a.frames, ...b.frames].map((f) => [f.id, f.updatedAt, f.pageId, f.name])).toEqual(before)
    expect(fakeDb.curations.get(job.id)?.status).toBe('ready')
  })

  it('retries a bad answer, splits a batch that keeps failing, then leaves the rest unclassified', async () => {
    seed()
    let bad = 1
    const calls = stubModels({
      file: (user, system) => {
        if (bad-- > 0) return 'not json'
        /* the FAQ line is never filed */
        return fileLines(user, system).replace(/"(\d+)":"(c\d+)"/g, (m, n: string) =>
          user.split('\n')[Number(n) - 1]?.toLowerCase().includes('faq') ? `"${n}":"none"` : m,
        )
      },
    })
    const job = await curation.startCuration({ ownerId: OWNER, sourceIds: ['srcA', 'srcB'] })
    const done = await finished(job.id)
    expect(done.status).toBe('ready')
    /* the first try failed, its retry filed three; the second pass asked again for the FAQ */
    expect(calls.bulk).toBe(3)
    expect(planView(done.plan!).unclassified.map((u) => u.key)).toEqual(['srcB:b4'])
  })

  it('falls back to the page names when the model cannot give a tree', async () => {
    seed()
    const calls = stubModels({ tree: () => 'I cannot' })
    const job = await curation.startCuration({ ownerId: OWNER, sourceIds: ['srcA', 'srcB'] })
    const done = await finished(job.id)
    expect(done.status).toBe('ready')
    expect(calls).toEqual({ main: 2, bulk: 0 })
    const view = planView(done.plan!)
    expect(view.fallback).toBe(true)
    expect(view.tree.map((n) => n.name)).toEqual(['Heroes', 'Marketing sections', 'Components'])
    expect(view.tree[0]!.children.map((n) => n.name)).toEqual(['AI products'])
    expect(view.totals.unclassified).toBe(0)
  })

  it('fails on an account error and resumes from the items still unfiled', async () => {
    seed()
    const { ModelAuthError } = await import('../server/agentModel.ts')
    let first = true
    stubModels({
      file: (user, system) => {
        if (first) {
          first = false
          throw new ModelAuthError('Reconnect your Claude API key in Settings.')
        }
        return fileLines(user, system)
      },
    })
    const job = await curation.startCuration({ ownerId: OWNER, sourceIds: ['srcA', 'srcB'] })
    const failed = await finished(job.id)
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('Reconnect')
    expect(failed.plan!.tree.length).toBeGreaterThan(0)
    const calls = stubModels()
    await curation.retryCuration(job.id)
    const done = await finished(job.id)
    expect(done.status).toBe('ready')
    expect(calls).toEqual({ main: 0, bulk: 1 })
  })

  it('resumes a job a restart cut off', async () => {
    seed()
    stubModels()
    const job = await curation.startCuration({ ownerId: OWNER, sourceIds: ['srcA', 'srcB'] })
    await finished(job.id)
    /* as saved mid-run: two items filed, two to go */
    const saved = fakeDb.curations.get(job.id)!
    const keys = Object.keys(saved.plan!.assignments)
    for (const key of keys.slice(2)) delete saved.plan!.assignments[key]
    saved.status = 'classifying'
    curation.resetCurationsForTest()
    const calls = stubModels()
    await curation.hydrateCurations()
    curation.resumeCurations()
    const done = await finished(job.id)
    expect(done.status).toBe('ready')
    expect(calls).toEqual({ main: 0, bulk: 1 })
    expect(planView(done.plan!).totals.unclassified).toBe(0)
  })

  it('refuses without a model account, a source the person does not manage, or a second running job', async () => {
    seed()
    curation.setCurationModels(async () => null)
    await expect(curation.startCuration({ ownerId: OWNER, sourceIds: ['srcA'] })).rejects.toMatchObject({ status: 409 })
    stubModels()
    await expect(curation.startCuration({ ownerId: 'someone', sourceIds: ['srcA'] })).rejects.toMatchObject({
      status: 404,
    })
    await expect(curation.startCuration({ ownerId: OWNER, sourceIds: [] })).rejects.toMatchObject({ status: 400 })
    const job = await curation.startCuration({ ownerId: OWNER, sourceIds: ['srcA'] })
    await expect(curation.startCuration({ ownerId: OWNER, sourceIds: ['srcB'] })).rejects.toMatchObject({ status: 409 })
    await finished(job.id)
  })

  it('asks twice, then leaves what the model never files for the person', async () => {
    const specs: FrameSpec[] = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      name: `bk.m-item${i} — Item ${i}`,
      html: page(`<p>Distinct item number ${i} with its own words</p>`),
    }))
    const canvas = libraryCanvas(specs, { id: 'srcM', ownerId: OWNER })
    for (const f of canvas.frames) fakeDb.html.set(f.id, f.html)
    store.init([canvas])
    stubModels({ file: () => '{"a":{}}' })
    const job = await curation.startCuration({ ownerId: OWNER, sourceIds: ['srcM'] })
    const done = await finished(job.id)
    expect(done.status).toBe('ready')
    expect(done.calls).toBe(3)
    expect(planView(done.plan!).totals.unclassified).toBe(30)
  })
})

describe('editing a plan', () => {
  const plan = (): CurationPlan => ({
    tree: [
      { id: 'c1', name: 'Heroes', children: [{ id: 'c2', name: 'AI products', children: [] }] },
      { id: 'c3', name: 'Sections', children: [{ id: 'c4', name: 'Pricing', children: [] }] },
      {
        id: 'c5',
        name: 'Marketing',
        children: [{ id: 'c6', name: 'pricing', children: [{ id: 'c7', name: 'Tiers', children: [] }] }],
      },
    ],
    entries: ['e1', 'e2', 'e3', 'e4'].map(
      (key) => ({ key, label: key, frames: [{ canvasId: 'x', frameId: key }] }) as CurationEntry,
    ),
    assignments: { e1: 'c2', e2: 'c4', e3: 'c6', e4: 'c7' },
    duplicates: [],
  })
  const ok = (r: ReturnType<typeof editPlan>) => {
    if (!r.ok) throw new Error(r.error)
    return r.plan
  }

  it('renames with a clean name, and refuses a sibling clash', () => {
    expect(ok(editPlan(plan(), { op: 'rename', id: 'c2', name: '01 AI · A–L' })).tree[0]!.children[0]!.name).toBe('AI')
    expect(editPlan(plan(), { op: 'rename', id: 'c3', name: 'heroes' })).toMatchObject({ ok: false })
  })

  it('merges a category, its items and its sub-categories into another', () => {
    const next = ok(editPlan(plan(), { op: 'merge', from: 'c5', into: 'c3' }))
    expect(next.tree.map((n) => n.id)).toEqual(['c1', 'c3'])
    /* "pricing" met "Pricing": one category, with Tiers under it */
    expect(next.tree[1]!.children.map((n) => n.name)).toEqual(['Pricing'])
    expect(next.tree[1]!.children[0]!.children.map((n) => n.name)).toEqual(['Tiers'])
    expect(next.assignments).toEqual({ e1: 'c2', e2: 'c4', e3: 'c4', e4: 'c7' })
    expect(editPlan(plan(), { op: 'merge', from: 'c1', into: 'c2' })).toMatchObject({ ok: false })
  })

  it('deletes a category, leaving its items unclassified', () => {
    const next = ok(editPlan(plan(), { op: 'delete', id: 'c5' }))
    expect(next.assignments).toEqual({ e1: 'c2', e2: 'c4' })
    expect(planView(next).totals.unclassified).toBe(2)
  })

  it('moves within three levels, adds, and files items', () => {
    expect(editPlan(plan(), { op: 'move', id: 'c5', parentId: 'c2' })).toMatchObject({ ok: false })
    const moved = ok(editPlan(plan(), { op: 'move', id: 'c4', parentId: 'c1', index: 0 }))
    expect(moved.tree[0]!.children.map((n) => n.id)).toEqual(['c4', 'c2'])
    const added = ok(editPlan(plan(), { op: 'add', parentId: 'c1', name: 'Fintech' }))
    expect(added.tree[0]!.children.map((n) => [n.id, n.name])).toContainEqual(['c8', 'Fintech'])
    expect(editPlan(plan(), { op: 'add', parentId: 'c7', name: 'Deeper' })).toMatchObject({ ok: false })
    const filed = ok(editPlan(plan(), { op: 'assign', keys: ['e1', 'nope'], to: 'c4' }))
    expect(filed.assignments.e1).toBe('c4')
    expect(ok(editPlan(plan(), { op: 'assign', keys: ['e1'], to: null })).assignments.e1).toBeUndefined()
  })

  it('never changes the plan it was given', () => {
    const p = plan()
    editPlan(p, { op: 'delete', id: 'c1' })
    expect(p.tree).toHaveLength(3)
  })
})
