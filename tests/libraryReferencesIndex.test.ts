import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatPlanReference } from '../shared/types'
import { fakeDb } from './libraryFakeDb'
import { libraryCanvas } from './libraryFixtures'

/* find_references and plan references on a real design library: answered
   by the index, items named and checked. */

vi.mock('../server/db/persist.ts', async () => (await import('./libraryFakeDb')).fakePersist())
vi.mock('../server/resident.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/resident.ts')>()
  return { ...mod, onFeedback: () => {} }
})

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const libraries = await import('../server/libraries.ts')
const indexer = await import('../server/libraryIndex.ts')
const { execChatTool } = await import('../server/resident.ts')
const { LIBRARY_MAX_CANVASES } = await import('../server/referenceLibrary.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
const actor = () => actions.resolveActor({ name: AGENT, kind: 'agent' })
const run = (extra: Record<string, unknown> = {}) => ({
  mutatedFrames: new Set<string>(),
  sourceFrames: new Set<string>(),
  verificationFrames: new Set<string>(),
  verifiedFrames: new Set<string>(),
  rewriteDrafts: new Map<string, string>(),
  vision: false,
  imagesGenerated: 0,
  repliedThreads: new Set<string>(),
  awaitingThreads: new Set<string>(),
  tokenWrites: 0,
  arrangeWrites: 0,
  chatDone: false,
  libraryCanvases: [{ id: 'lib1', name: 'Design Library' }],
  ...extra,
})
const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })

let chatId: string

beforeEach(async () => {
  libraries.resetLibrariesForTest()
  indexer.resetIndexerForTest()
  fakeDb.reset()
  actions.wire(
    () => {},
    () => {},
  )
  const lib = libraryCanvas([{ fixture: 'sheet-static' }], { id: 'lib1', ownerId: 'alice' })
  for (const f of lib.frames) fakeDb.html.set(f.id, f.html)
  store.init([lib])
  libraries.createLibrary('lib1', { preset: 'sheets' }, actor())
  await indexer.reindexLibrary('lib1')
  chatId = store.createCanvas('chat', 'alice').id
})

const ref = (over: Partial<ChatPlanReference> = {}) => ({
  canvas_id: 'lib1',
  frame_id: 'f1',
  label: 'Login',
  why: 'the login screen builds on it',
  ...over,
})

async function propose(references: unknown[]) {
  const message = actions.postChatMessage(chatId, { from: 'alice', fromUserId: 'alice', text: '@Doop login' })!
  actions.takeChatAsksFor(chatId, AGENT, 'alice', '')
  return execChatTool(
    call('propose_plan', {
      summary: 'Login',
      screens: [{ name: 'Login', width: 390, height: 844, outline: 'log in', references }],
    }),
    chatId,
    actor(),
    run({ chatAsks: [message] }),
  )
}

describe('references on a design library', () => {
  it('answers find_references from the index, with item ids', async () => {
    const result = await execChatTool(call('find_references', { query: 'login' }), chatId, actor(), run())
    const found = JSON.parse(String(result.content))
    expect(found.hits[0]).toMatchObject({
      canvas_id: 'lib1',
      frame_id: 'f1',
      item_id: 'bk.scb-login',
      variant_count: 2,
      where: 'item',
      url: '/l/lib1/i/bk.scb-login',
    })
  })

  it('accepts a plan naming a real item and refuses an unknown one', async () => {
    expect((await propose([ref({ itemId: 'bk.scb-login' })])).is_error).toBeUndefined()
    const bad = await propose([ref({ itemId: 'bk.scb-nope' })])
    expect(bad.is_error).toBe(true)
    expect(String(bad.content)).toContain('is not in library lib1')
  })

  it('caps the reference library at twenty canvases', () => {
    expect(LIBRARY_MAX_CANVASES).toBe(20)
  })
})
