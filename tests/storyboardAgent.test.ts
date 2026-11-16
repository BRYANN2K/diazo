import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The resident side of Animate storyboard: execTool runs the real
   animate_storyboard and set_composition against the in-memory store —
   persist is stubbed, so a committed stamp resolves like any save. */

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: async () => {},
  saveCanvas: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveComposition: () => {},
  saveCompositionVersion: () => {},
  deleteComposition: () => {},
  loadFrameHtml: async () => [],
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { execTool, TOOLS } = await import('../server/resident.ts')
const { canvasPages } = await import('../shared/pages.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')
const { MOTION } = await import('../server/guide.ts')
const { motion: en } = await import('../src/lib/i18n/en/motion.ts')
const { motion: pt } = await import('../src/lib/i18n/pt-BR/motion.ts')

const actor = () => actions.resolveActor({ name: roleName(DEFAULT_ROLE_ID), kind: 'agent' })
const run = () => ({
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
})
const call = (name: string, input: unknown) => ({ type: 'tool_use' as const, id: 't1', name, input })

const SHOT_HTML = (title: string) => `<!doctype html><html><body>
  <div class="shot">
    <h1>${title}</h1>
    <img src="hero.png" alt="Hero"/>
    <p>MOUVEMENT / TRANSITION / SON : travelling avant lent ; mots en apparition</p>
    <p>VOIX OFF : il était une fois</p>
    <button class="cta">Commencer</button>
  </div>
</body></html>`

let canvasId: string
let pageId: string
let frameId: string

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  canvasId = store.createCanvas('storyboard', 'kevin').id
  pageId = canvasPages(store.getCanvas(canvasId)!)[0]!.id
  /* reveal: false — the storyboard's frames are finished designs; a frame
     still streaming is the one case stamping is refused */
  frameId = actions.createFrame(
    canvasId,
    { name: 'Shot 1', width: 1000, height: 600, html: SHOT_HTML('Séquence 01'), x: 0, y: 0 },
    actor(),
    { reveal: false },
  )!.id
  actions.createFrame(
    canvasId,
    { name: 'Shot 2', width: 1000, height: 600, html: '<body><h1>Plano 2</h1></body>', x: 1200, y: 0 },
    actor(),
    { reveal: false },
  )
})

interface StoryResult {
  composition: { tracks: { kind: string }[] }
  shots: { frameId: string; notes: { text: string; id?: string }[]; targets: { id: string; tag: string }[] }[]
  storyboard?: { noted: number; animated: number; pending: { frameId: string }[]; pass: number; message: string }
}

async function toolJson(name: string, input: unknown) {
  const result = await execTool(call(name, input), canvasId, actor(), run())
  expect(result.is_error, String(result.content)).toBeUndefined()
  return JSON.parse(String(result.content)) as StoryResult
}

describe('animate_storyboard — notes, targets and coverage', () => {
  it('returns each shot’s notes and animatable elements, and stamps their ids', async () => {
    const data = await toolJson('animate_storyboard', { page_id: pageId })
    expect(data.shots).toHaveLength(2)
    const shot = data.shots.find((s) => s.frameId === frameId)!
    const texts = shot.notes.map((n) => n.text)
    expect(texts.some((t) => t.includes('MOUVEMENT'))).toBe(true)
    expect(texts.some((t) => t.includes('VOIX OFF'))).toBe(true)
    expect(shot.targets.map((t) => t.tag)).toEqual(expect.arrayContaining(['h1', 'img', 'button']))

    /* the stamped ids are in the frame's stored html — an element track can
       target them at once */
    const html = store.getFrame(frameId)!.html
    for (const target of shot.targets) expect(html).toContain(`data-doop-id="${target.id}"`)
  })

  it('reports noted shots without an element track, then clears them as ops land', async () => {
    await toolJson('animate_storyboard', { page_id: pageId })

    const first = await toolJson('set_composition', {
      page_id: pageId,
      ops: [{ op: 'set_meta', duration: 6 }],
    })
    expect(first.storyboard?.pending.map((p) => p.frameId)).toEqual([frameId])
    expect(first.storyboard?.message).toContain('element track')

    const animated = await toolJson('set_composition', {
      page_id: pageId,
      ops: [
        {
          op: 'add_track',
          track: {
            id: 'headline-in',
            kind: 'element',
            frameId,
            elementId: 'el_any',
            keyframes: [{ id: 'k1', property: 'opacity', t: 0, value: 0 }],
          },
        },
      ],
    })
    expect(animated.storyboard?.pending).toEqual([])
    expect(animated.storyboard?.animated).toBe(1)
  })

  it('stops asking after two fix passes and tells the agent to name what is left', async () => {
    await toolJson('animate_storyboard', { page_id: pageId })
    for (let i = 0; i < 3; i++) {
      const data = await toolJson('set_composition', { page_id: pageId, ops: [{ op: 'set_meta', duration: 6 }] })
      if (i < 2) expect(data.storyboard?.message).toContain(`fix pass ${i + 1} of 2`)
      else expect(data.storyboard?.message).toContain('finish')
    }
  })
})

describe('the words the agent sees', () => {
  it('sends it to read notes and animate elements — guide, tools and button', () => {
    for (const words of [
      MOTION,
      TOOLS.find((t) => t.name === 'animate_storyboard')!.description,
      TOOLS.find((t) => t.name === 'set_composition')!.description,
      en.animatePrompt,
      pt.animatePrompt,
    ]) {
      expect(words).toMatch(/not[ae]/i)
      expect(words).toMatch(/element|elemento/i)
    }
    /* and the run prompt names the shot notes, not only camera moves */
    expect(en.animatePrompt).toMatch(/data-doop-id/)
    expect(MOTION).toMatch(/data-doop-id/)
  })
})
