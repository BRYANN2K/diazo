import { beforeEach, expect, it, vi } from 'vitest'

/* The resident agent's side of canvas skills: get_skill reads one (the chat
   may too), set_skill saves one, and a chat run cannot write. */

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  saveSkill: () => {},
  deleteSkill: () => {},
}))
vi.mock('../server/resident.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/resident.ts')>()
  return { ...mod, onFeedback: () => {} }
})

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { execTool, execChatTool } = await import('../server/resident.ts')

const actor = () => actions.resolveActor({ name: 'Doop', kind: 'agent' })
const run = () =>
  ({
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
  }) as unknown as Parameters<typeof execTool>[3]
const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })
const text = (r: { content?: unknown }) => String(r.content)

let canvasId: string
beforeEach(() => {
  canvasId = store.createCanvas('skills', 'owner').id
})

it('saves a skill and reads it back, a /name included', async () => {
  const saved = await execTool(
    call('set_skill', { name: 'pricing-page', description: 'Pricing pages', markdown: 'Three tiers.' }),
    canvasId,
    actor(),
    run(),
  )
  expect(saved.is_error).toBeFalsy()
  const read = await execTool(call('get_skill', { name: '/pricing-page' }), canvasId, actor(), run())
  expect(text(read)).toContain('Three tiers.')
  const missing = await execTool(call('get_skill', { name: 'nope' }), canvasId, actor(), run())
  expect(missing.is_error).toBe(true)
  expect(text(missing)).toContain('pricing-page')
})

it('lets a chat run read a skill but not write one', async () => {
  actions.setSkill(canvasId, { name: 'house-style', description: 'Any design', markdown: 'Inter only.' }, actor())
  const read = await execChatTool(call('get_skill', { name: 'house-style' }), canvasId, actor(), run())
  expect(text(read)).toContain('Inter only.')
  const write = await execChatTool(
    call('set_skill', { name: 'x', description: 'd', markdown: 'b' }),
    canvasId,
    actor(),
    run(),
  )
  expect(write.is_error).toBe(true)
  expect(store.getSkills(canvasId).map((s) => s.name)).toEqual(['house-style'])
})
