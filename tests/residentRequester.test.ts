import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The resident run's requester rule: speech jobs, voices and Blender ops
 * act as the person who asked — never as the account that pays, and never
 * as one of several people a batched run happens to serve. */

vi.mock('../server/db/persist.ts', () => ({
  saveCanvas: () => {},
  saveFrame: () => {},
  saveActivity: () => {},
  saveTask: () => {},
}))
const speechCalls = vi.hoisted(() => [] as { name: string; userId: string }[])
vi.mock('../server/speechTools.ts', () => ({
  SPEECH_TOOLS: [
    'list_speech_engines',
    'estimate_speech',
    'transcribe_clip',
    'generate_voiceover',
    'get_transcript',
    'list_voices',
  ].map((name) => ({ name, description: name, shape: {} })),
  runSpeechTool: vi.fn(async (name: string, _canvas: unknown, userId: string) => {
    speechCalls.push({ name, userId })
    return { ok: true }
  }),
}))
const blenderCalls = vi.hoisted(() => [] as { name: string; userId: string }[])
vi.mock('../server/blenderTools.ts', () => ({
  BLENDER_TOOLS: [
    'blender_get_scene',
    'blender_get_object',
    'blender_set_material',
    'blender_add_light',
    'blender_render_frame',
    'get_blender_result',
  ].map((name) => ({ name, description: name, shape: {} })),
  runBlenderTool: vi.fn(async (name: string, _canvas: unknown, userId: string) => {
    blenderCalls.push({ name, userId })
    return { ok: true }
  }),
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { execTool } = await import('../server/resident.ts')
type RunState = Parameters<typeof execTool>[3]

const actor = () => actions.resolveActor({ name: 'Diazo', kind: 'agent' })
const run = (over: Partial<RunState> = {}): RunState =>
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
    ...over,
  }) as RunState
const call = (name: string, input: unknown = {}) => ({ type: 'tool_use' as const, id: 't1', name, input })
const text = (r: { content?: unknown }) => String(r.content)

let canvasId: string
beforeEach(() => {
  speechCalls.length = 0
  blenderCalls.length = 0
  canvasId = store.createCanvas('requester', 'owner').id
})

describe('requester-scoped tools', () => {
  it('acts as the asker, not the payer', async () => {
    const state = run({ payerId: 'payer', askerId: 'asker' })
    const out = await execTool(call('list_voices'), canvasId, actor(), state)
    expect(out.is_error).toBeFalsy()
    expect(speechCalls).toEqual([{ name: 'list_voices', userId: 'asker' }])

    const out2 = await execTool(call('blender_get_scene'), canvasId, actor(), state)
    expect(out2.is_error).toBeFalsy()
    expect(blenderCalls).toEqual([{ name: 'blender_get_scene', userId: 'asker' }])
  })

  it('refuses the tools when the run serves several people', async () => {
    /* two askers in one batch: neither speech nor blender may pick one
       account at random — a clear refusal, and nothing is dispatched */
    const state = run({ payerId: 'payer', mixedRequesters: true })
    const speech = await execTool(call('generate_voiceover'), canvasId, actor(), state)
    expect(speech.is_error).toBe(true)
    expect(text(speech)).toMatch(/several people/)
    const blender = await execTool(call('blender_render_frame'), canvasId, actor(), state)
    expect(blender.is_error).toBe(true)
    expect(text(blender)).toMatch(/several people/)
    expect(speechCalls).toHaveLength(0)
    expect(blenderCalls).toHaveLength(0)
  })

  it('asks the person to sign in when there is no requester at all', async () => {
    const out = await execTool(call('list_voices'), canvasId, actor(), run({ payerId: 'payer' }))
    expect(out.is_error).toBe(true)
    expect(text(out)).toMatch(/sign in/)
    expect(speechCalls).toHaveLength(0)
  })
})
