import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CurationEntry } from '../shared/libraryCuration'
import { withOrigin } from '../shared/libraryProvenance'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const curation = await import('../server/libraryCuration.ts')
const apply = await import('../server/libraryCurationApply.ts')

const OWNER = 'u1'
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`

function seed() {
  const a = libraryCanvas(
    [
      { id: 'a1', name: 'hero.x-ai — AI hero', html: page('<h1>Ship AI agents faster</h1>'), width: 1440, height: 900 },
      { id: 'a2', name: 'bk.x-pricing — Pricing', html: page('<h2>Simple pricing for every team</h2>'), width: 2040 },
    ],
    { id: 'srcA', name: 'Design Library', ownerId: OWNER },
  )
  const b = libraryCanvas(
    [
      { id: 'b1', name: 'cp.x-button — Button', html: page('<button>Buy now and save more</button>'), width: 760 },
      {
        id: 'b2',
        name: 'cp.x-button-dark — Button dark',
        html: page('<button>Buy now dark variant</button>'),
        width: 760,
      },
      { id: 'b3', name: 'bk.x-faq — FAQ', html: page('<h2>Frequently asked questions</h2>') },
    ],
    { id: 'srcB', name: 'Design Library · A UI components', ownerId: OWNER },
  )
  for (const f of [...a.frames, ...b.frames]) fakeDb.html.set(f.id, f.html)
  store.init([a, b])
  return [store.getCanvas('srcA')!, store.getCanvas('srcB')!]
}

const TREE = JSON.stringify({
  categories: [
    { name: 'Heroes', children: [{ name: 'AI products' }] },
    { name: 'Sections', children: [{ name: 'Pricing' }, { name: 'FAQ' }] },
    { name: 'Components', children: [{ name: 'Buttons' }] },
  ],
})

function stubModels() {
  const file = (user: string, system: string) => {
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
            : idOf('Components/Buttons')
    }
    return JSON.stringify({ a })
  }
  curation.setCurationModels(async () => ({
    main: { label: 'Stub', complete: async () => ({ text: TREE }) },
    bulk: { label: 'Stub', complete: async (turn) => ({ text: file(turn.user, turn.system) }) },
  }))
}

async function readyJob() {
  stubModels()
  const job = await curation.startCuration({ ownerId: OWNER, sourceIds: ['srcA', 'srcB'] })
  await curation.curationSettled(job.id)
  expect(curation.getCuration(job.id)!.status).toBe('ready')
  return job.id
}

async function applied(id: string, opts?: { includeUnclassified?: boolean }) {
  await apply.applyCuration(id, { id: OWNER, name: 'Owner' }, opts)
  await apply.applySettled(id)
  const job = curation.getCuration(id)!
  expect(job.error).toBeNull()
  return job
}

const snapshot = (canvases: ReturnType<typeof seed>) =>
  canvases.map((c) => ({ pages: structuredClone(c.pages), frames: c.frames.map((f) => ({ ...f })) }))

beforeEach(() => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  curation.resetCurationsForTest()
  fakeDb.reset()
})

describe('laying out a page', () => {
  it('packs frames in rows that wrap, a family side by side', () => {
    const entry = (key: string, widths: number[]) =>
      ({ key, frames: widths.map((_, i) => ({ canvasId: 'x', frameId: `${key}${i}` })) }) as CurationEntry
    const widths = new Map([
      ['a0', 3000],
      ['b0', 2000],
      ['b1', 2000],
      ['c0', 7000],
    ])
    const spots = apply.layoutPage([entry('a', [0]), entry('b', [0, 0]), entry('c', [0])], 'p', (ref) => ({
      width: widths.get(ref.frameId)!,
      height: ref.frameId === 'a0' ? 900 : 500,
    }))
    expect(spots.map((s) => [s.ref.frameId, s.x, s.y])).toEqual([
      ['a0', 0, 0],
      ['b0', 3000 + apply.GAP, 0],
      ['b1', 0, 900 + apply.GAP],
      ['c0', 0, 900 + 500 + 2 * apply.GAP],
    ])
  })
})

describe('applying a plan', () => {
  it('creates a new canvas with a page per category, copies the frames, and turns it into a library', async () => {
    const sources = seed()
    const before = snapshot(sources)
    const id = await readyJob()
    const job = await applied(id)
    expect(job.status).toBe('applied')
    const canvas = store.getCanvas(job.applied!.canvasId!)!
    expect(canvas).toMatchObject({ name: 'Design Library (curated)', ownerId: OWNER })
    expect(canvas.pages!.map((p) => p.name)).toEqual([
      'Heroes/AI products',
      'Sections/Pricing',
      'Sections/FAQ',
      'Components/Buttons',
    ])
    expect(canvas.frames).toHaveLength(5)
    const buttons = canvas.pages![3]!.id
    const onButtons = canvas.frames.filter((f) => f.pageId === buttons)
    expect(onButtons.map((f) => [f.name, f.x, f.y])).toEqual([
      ['cp.x-button — Button', 0, 0],
      ['cp.x-button-dark — Button dark', 760 + apply.GAP, 0],
    ])
    /* the same HTML, marked with the frame it was copied from */
    for (const f of canvas.frames) {
      const source = sources.flatMap((c) => c.frames).find((s) => s.name === f.name)!
      expect(f.html).toBe(withOrigin(fakeDb.html.get(source.id)!, `${source.canvasId}:${source.id}`))
    }
    /* a library whose items land in their categories */
    expect(libraries.getLibrary(canvas.id)?.taxonomy.categories.map((c) => c.path)).toEqual(
      expect.arrayContaining(['Heroes', 'Heroes/AI products', 'Components/Buttons']),
    )
    await indexer.reindexLibrary(canvas.id)
    const items = await indexer.libraryItems(canvas.id)
    const category = (itemId: string) => items.find((i) => i.itemId === itemId)?.category
    expect(category('hero.x-ai')).toBe('Heroes/AI products')
    expect(category('bk.x-pricing')).toBe('Sections/Pricing')
    expect(category('cp.x-button')).toBe('Components/Buttons')
    expect(items.find((i) => i.itemId === 'cp.x-button-dark')?.parentId).toBe('cp.x-button')
    /* the sources are untouched */
    expect(snapshot(sources)).toEqual(before)
    expect(libraries.getLibrary('srcA')).toBeUndefined()
  })

  it('is idempotent and resumes a copy a restart cut short', async () => {
    seed()
    const id = await readyJob()
    const job = await applied(id)
    const canvasId = job.applied!.canvasId!
    /* applying again changes nothing */
    await applied(id)
    expect(store.getCanvas(canvasId)!.frames).toHaveLength(5)
    /* as if a restart lost the record of two copies */
    const keys = Object.keys(job.applied!.copied)
    delete job.applied!.copied[keys[0]!]
    delete job.applied!.copied[keys[3]!]
    job.status = 'applying'
    await applied(id)
    expect(job.status).toBe('applied')
    expect(store.getCanvas(canvasId)!.frames).toHaveLength(5)
    expect(Object.keys(job.applied!.copied)).toHaveLength(5)
  })

  it('keeps unfiled items on an Unsorted page, or leaves them out', async () => {
    seed()
    const id = await readyJob()
    const faq = curation.getCuration(id)!.plan!.entries.find((e) => e.label === 'FAQ')!
    await curation.editCuration(id, [{ op: 'assign', keys: [faq.key], to: null }])
    const kept = await applied(id)
    const canvas = store.getCanvas(kept.applied!.canvasId!)!
    expect(canvas.pages!.map((p) => p.name).at(-1)).toBe('Unsorted')
    expect(canvas.frames).toHaveLength(5)

    curation.resetCurationsForTest()
    const second = await readyJob()
    const faq2 = curation.getCuration(second)!.plan!.entries.find((e) => e.label === 'FAQ')!
    await curation.editCuration(second, [{ op: 'assign', keys: [faq2.key], to: null }])
    const left = await applied(second, { includeUnclassified: false })
    expect(store.getCanvas(left.applied!.canvasId!)!.frames).toHaveLength(4)
  })

  it('refuses a plan that is not ready, someone else, or a source the person lost', async () => {
    const [a] = seed()
    const id = await readyJob()
    await expect(apply.applyCuration(id, { id: 'other', name: 'X' })).rejects.toMatchObject({ status: 404 })
    a!.ownerId = 'someone-else'
    await expect(apply.applyCuration(id, { id: OWNER, name: 'Owner' })).rejects.toMatchObject({ status: 404 })
    a!.ownerId = OWNER
    await curation.cancelCuration(id)
    await expect(apply.applyCuration(id, { id: OWNER, name: 'Owner' })).rejects.toMatchObject({ status: 409 })
  })
})
