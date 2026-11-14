import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RULE_PRESETS } from '../shared/libraryRules'
import { normalizeSourceUrl, originOf, similarity, wordsOf, withOrigin } from '../shared/libraryProvenance'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas } from './libraryFixtures'

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())

const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const { runImport } = await import('../server/libraryImport.ts')
const { findDuplicates } = await import('../server/libraryDuplicates.ts')
const tools = await import('../server/libraryTools.ts')

const actor = { name: 'Owner', kind: 'user' as const, color: '#000' }
const AI_SDK = 'https://ai-sdk.dev/docs/ai-sdk-ui'
const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const captured = (url: string) => `<meta name="doop-import-source" content="${encodeURIComponent(url)}">`
const CHAT =
  '<h1>AI SDK UI</h1><p>Build chat interfaces and generative user interfaces with streaming hooks for React</p>'

describe('provenance', () => {
  it('normalises a page address to host and path, without tracking', () => {
    expect(normalizeSourceUrl('https://www.AI-SDK.dev/docs/ai-sdk-ui/?utm_source=x&gclid=1#top')).toBe(
      'ai-sdk.dev/docs/ai-sdk-ui',
    )
    expect(normalizeSourceUrl('http://ai-sdk.dev/docs/ai-sdk-ui')).toBe('ai-sdk.dev/docs/ai-sdk-ui')
    expect(normalizeSourceUrl('https://x.dev/search?q=chat&utm_medium=y&a=1')).toBe('x.dev/search?a=1&q=chat')
    expect(normalizeSourceUrl('https://x.dev:8443/a')).toBe('x.dev:8443/a')
    expect(normalizeSourceUrl('mailto:a@b.c')).toBeNull()
    expect(normalizeSourceUrl('not a url')).toBeNull()
  })

  it('marks a copy with its first origin only', () => {
    const once = withOrigin(page('<p>x</p>'), 'c1:f1')
    expect(originOf(once)).toBe('c1:f1')
    expect(originOf(withOrigin(once, 'c2:f2'))).toBe('c1:f1')
  })

  it('scores near copies by their shared words', () => {
    const a = wordsOf('Pricing table', 'Simple pricing for every team size, billed monthly or yearly')
    const b = wordsOf('Pricing table', 'Simple pricing for every team size billed monthly or yearly!')
    expect(similarity(a, b)).toBe(1)
    expect(similarity(a, wordsOf('Login', 'Sign in with your email and password to continue'))).toBeLessThan(0.2)
    expect(similarity(wordsOf('a', 'b'), wordsOf('a', 'b'))).toBe(0)
  })
})

/** L1 is the target, L2 another library of the person; W is a work canvas. */
async function seed() {
  const l1 = libraryCanvas(
    [
      { id: 'l1a', name: 'Pricing table', html: withOrigin(page('<h2>Old pricing</h2>'), 'W:w2') },
      {
        id: 'l1b',
        name: 'Testimonials wall',
        html: page(
          '<h2>Loved by thousands of product teams</h2><p>Quotes from founders designers and engineers worldwide</p>',
        ),
      },
    ],
    { id: 'L1', name: 'Library one', ownerId: 'u1' },
  )
  const l2 = libraryCanvas([{ id: 'l2a', name: 'AI SDK UI', html: page(CHAT, captured(AI_SDK)) }], {
    id: 'L2',
    name: 'Vercel things',
    ownerId: 'u1',
  })
  const w = libraryCanvas(
    [
      /* the same page, imported again later, with tracking on the address */
      { id: 'w1', name: 'AI SDK UI (again)', html: page('<h1>Changed</h1>', captured(`${AI_SDK}/?utm_source=x`)) },
      /* the frame L1's pricing table was copied from */
      { id: 'w2', name: 'Pricing', html: page('<h2>New pricing</h2>') },
      /* nearly the same words as L1's testimonials */
      {
        id: 'w3',
        name: 'Testimonials wall',
        html: page(
          '<h2>Loved by thousands of product teams!</h2><p>Quotes from founders, designers and engineers worldwide.</p>',
        ),
      },
      {
        id: 'w4',
        name: 'Something new',
        html: page('<p>A footer nobody has seen before with four columns of links</p>'),
      },
    ],
    { id: 'W', name: 'Work', ownerId: 'u1' },
  )
  for (const f of [...l1.frames, ...l2.frames, ...w.frames]) fakeDb.html.set(f.id, f.html)
  store.init([l1, l2, w])
  for (const id of ['L1', 'L2']) {
    libraries.createLibrary(id, { rules: RULE_PRESETS.blank }, actor)
    await indexer.reindexLibrary(id)
  }
}

const others = () => [store.getCanvas('L2')!]

beforeEach(async () => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
  actions.wire(
    () => {},
    () => {},
  )
  await seed()
})

describe('checking before an import', () => {
  it('finds the same page, the same origin and a near copy, across libraries', async () => {
    const all = [store.getCanvas('L1')!, store.getCanvas('L2')!]
    const html = (id: string) => fakeDb.html.get(id)!
    const [w1, w2, w3, w4] = await findDuplicates(
      ['w1', 'w2', 'w3', 'w4'].map((id) => ({ name: store.getFrame(id)!.name, html: html(id), ref: `W:${id}` })),
      all,
    )
    expect(w1).toMatchObject([
      { libraryId: 'L2', libraryName: 'Vercel things', name: 'AI SDK UI', reason: 'same-url', score: 1 },
    ])
    expect(w1![0]!.url).toMatch(/^\/l\/L2\/i\//)
    expect(w2).toMatchObject([{ libraryId: 'L1', name: 'Pricing table', reason: 'same-content' }])
    expect(w3![0]).toMatchObject({ libraryId: 'L1', name: 'Testimonials wall', reason: 'similar' })
    expect(w3![0]!.score).toBeGreaterThanOrEqual(0.8)
    expect(w4).toEqual([])
    const [byUrl] = await findDuplicates([{ name: '', url: 'http://www.ai-sdk.dev/docs/ai-sdk-ui#hooks' }], all)
    expect(byUrl!.map((m) => m.reason)).toEqual(['same-url'])
  })

  it('leaves out what a library holds, imports the rest with its origin, and imports all when forced', async () => {
    const dry = await runImport({
      libraryId: 'L1',
      frameIds: ['w1', 'w2', 'w3', 'w4'],
      dryRun: true,
      actor,
      libraries: others(),
    })
    expect(dry.report.duplicates!.map((d) => d.frameId)).toEqual(['w1', 'w2', 'w3'])
    expect(dry.report.frames.map((f) => f.frameId)).toEqual(['w4'])
    const done = await runImport({ libraryId: 'L1', frameIds: ['w1', 'w2', 'w3', 'w4'], actor, libraries: others() })
    expect(done.applied.filter((a) => a.duplicate).map((a) => a.frameId)).toEqual(['w1', 'w2', 'w3'])
    expect(done.applied.find((a) => a.frameId === 'w1')!.error).toContain('already in "Vercel things"')
    const copy = done.applied.find((a) => a.frameId === 'w4')!.libraryFrameId!
    expect(originOf(store.getFrame(copy)!.html)).toBe('W:w4')
    /* a second import of the same frame is now a duplicate of that copy */
    const again = await runImport({ libraryId: 'L1', frameIds: ['w4'], dryRun: true, actor })
    await indexer.reindexLibrary('L1')
    const after = await runImport({ libraryId: 'L1', frameIds: ['w4'], dryRun: true, actor })
    expect(again.report.duplicates ?? []).toEqual([])
    expect(after.report.duplicates![0]!.matches[0]).toMatchObject({ reason: 'same-content' })
    const forced = await runImport({ libraryId: 'L1', frameIds: ['w1', 'w2'], actor, libraries: others(), force: true })
    expect(forced.applied.every((a) => a.libraryFrameId && !a.error)).toBe(true)
  })

  it('adds a frame as a variant of the item it duplicates', async () => {
    const family = (await indexer.libraryItems('L1')).find((i) => i.label === 'Testimonials wall')!
    const done = await runImport({ libraryId: 'L1', frameIds: ['w3'], actor, asVariantOf: family.itemId })
    const copy = store.getFrame(done.applied[0]!.libraryFrameId!)!
    expect(copy.name.startsWith(`${family.itemId}-`)).toBe(true)
    await indexer.reindexLibrary('L1')
    const variant = (await indexer.libraryItems('L1')).find((i) => i.frameId === copy.id)!
    expect(variant.parentId).toBe(family.itemId)
    await expect(runImport({ libraryId: 'L1', frameIds: ['w3'], actor, asVariantOf: 'nope' })).rejects.toThrow(
      'no family "nope"',
    )
  })
})

describe('agents', () => {
  const context = {
    userId: 'u1',
    actor,
    libraries: async () => [store.getCanvas('L1')!, store.getCanvas('L2')!],
    canEdit: () => true,
    canRead: () => true,
  }

  it('import_to_library says it already exists and imports nothing, unless forced', async () => {
    const out = await tools.runLibraryTool('import_to_library', { library_id: 'L1', frame_ids: ['w1'] }, context)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.note).toContain('already in "Vercel things"')
    expect(out.note).toContain('Tell the human it already exists')
    expect(out.data).toMatchObject({
      duplicates: [
        { frame_id: 'w1', already_in: [{ library: 'Vercel things', name: 'AI SDK UI', reason: 'same-url' }] },
      ],
    })
    expect(out.frames).toEqual([])
    const forced = await tools.runLibraryTool(
      'import_to_library',
      { library_id: 'L1', frame_ids: ['w1'], force: true },
      context,
    )
    expect(forced.ok && forced.frames).toHaveLength(1)
    const tool = tools.DESIGN_LIBRARY_TOOLS.find((t) => t.name === 'import_to_library')!
    expect(tool.description).toContain('tell the human it already exists')
    expect(Object.keys(tool.shape)).toEqual(expect.arrayContaining(['force', 'as_variant_of']))
  })

  it('check_library answers "do we have it?" without writing', async () => {
    const out = await tools.runLibraryTool('check_library', { url: `${AI_SDK}?utm_campaign=z` }, context)
    expect(out).toMatchObject({ ok: true, data: { duplicates: [{ library_id: 'L2', reason: 'same-url' }] } })
    const none = await tools.runLibraryTool('check_library', { frame_id: 'w4' }, context)
    expect(none).toMatchObject({ ok: true, data: { duplicates: [] }, note: 'Nothing like it in your libraries.' })
    expect(tools.DESIGN_LIBRARY_TOOLS.find((t) => t.name === 'check_library')!.readOnly).toBe(true)
    expect(await tools.runLibraryTool('check_library', {}, context)).toMatchObject({ ok: false })
  })
})
