import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The resident side of Animate storyboard: execTool runs the real
   animate_storyboard and set_composition against the in-memory store —
   persist is stubbed, so a committed stamp resolves like any save. */

const mocks = vi.hoisted(() => ({ saveFrameNow: vi.fn(async () => {}) }))

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveFrameNow: mocks.saveFrameNow,
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
const { MOTION, DIRECTOR } = await import('../server/guide.ts')
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
  mocks.saveFrameNow.mockReset().mockResolvedValue(undefined)
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
  shots: {
    frameId: string
    notes: { text: string; id?: string }[]
    targets: { id: string; tag: string }[]
    panelId?: string
  }[]
  storyboard?: { noted: number; animated: number; pending: { frameId: string }[]; pass: number; message: string }
}

async function toolJson(name: string, input: unknown) {
  const result = await execTool(call(name, input), canvasId, actor(), run())
  expect(result.is_error, String(result.content)).toBeUndefined()
  return JSON.parse(String(result.content)) as StoryResult
}

const elementTrack = (frame: string, elementId: string, extra: Record<string, unknown> = {}) => ({
  op: 'add_track',
  track: {
    id: `t-${elementId}`,
    kind: 'element',
    frameId: frame,
    elementId,
    keyframes: [{ id: 'k1', property: 'opacity', t: 0, value: 0 }],
    ...extra,
  },
})

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
    const created = await toolJson('animate_storyboard', { page_id: pageId })
    const target = created.shots.find((s) => s.frameId === frameId)!.targets[0]!.id

    const first = await toolJson('set_composition', {
      page_id: pageId,
      ops: [{ op: 'set_meta', duration: 6 }],
    })
    expect(first.storyboard?.pending.map((p) => p.frameId)).toEqual([frameId])
    expect(first.storyboard?.message).toContain('element track')

    const animated = await toolJson('set_composition', {
      page_id: pageId,
      ops: [elementTrack(frameId, target)],
    })
    expect(animated.storyboard?.pending).toEqual([])
    expect(animated.storyboard?.animated).toBe(1)
  })

  it('never clears a shot on an elementId the frame does not carry', async () => {
    await toolJson('animate_storyboard', { page_id: pageId })
    const data = await toolJson('set_composition', {
      page_id: pageId,
      ops: [elementTrack(frameId, 'el_notreal')],
    })
    expect(data.storyboard?.pending.map((p) => p.frameId)).toEqual([frameId])
  })

  it('never clears a shot on the track that only hides the notes block', async () => {
    const created = await toolJson('animate_storyboard', { page_id: pageId })
    const noteId = created.shots.find((s) => s.frameId === frameId)!.notes.find((n) => n.id)!.id!
    const data = await toolJson('set_composition', {
      page_id: pageId,
      ops: [elementTrack(frameId, noteId)],
    })
    /* hiding the notes is needed, but it is not the shot's animation */
    expect(data.storyboard?.pending.map((p) => p.frameId)).toEqual([frameId])
  })

  it('counts no-progress rounds, not writes: progress resets the counter', async () => {
    const created = await toolJson('animate_storyboard', { page_id: pageId })
    const target = created.shots.find((s) => s.frameId === frameId)!.targets[0]!.id

    /* two rounds reporting the same pending set: pass 0 then pass 1 */
    const r1 = await toolJson('set_composition', { page_id: pageId, ops: [{ op: 'set_meta', duration: 6 }] })
    const r2 = await toolJson('set_composition', { page_id: pageId, ops: [{ op: 'set_meta', duration: 7 }] })
    expect(r1.storyboard?.pass).toBe(0)
    expect(r2.storyboard?.pass).toBe(1)

    /* a write that fixes the shot resets — the next pending set is empty */
    const r3 = await toolJson('set_composition', { page_id: pageId, ops: [elementTrack(frameId, target)] })
    expect(r3.storyboard?.pending).toEqual([])
  })

  it('stops asking after two no-progress passes and tells the agent to name what is left', async () => {
    await toolJson('animate_storyboard', { page_id: pageId })
    for (let i = 0; i < 3; i++) {
      const data = await toolJson('set_composition', { page_id: pageId, ops: [{ op: 'set_meta', duration: 6 }] })
      if (i < 2) expect(data.storyboard?.message).toContain(`fix pass ${i + 1} of 2`)
      else expect(data.storyboard?.message).toContain('finish')
    }
  })

  it('scopes the check to the run: a noted frame outside frame_ids never pends', async () => {
    const otherId = actions.createFrame(
      canvasId,
      { name: 'Shot 3', width: 1000, height: 600, html: SHOT_HTML('Séquence 03'), x: 2400, y: 0 },
      actor(),
      { reveal: false },
    )!.id
    await toolJson('animate_storyboard', { page_id: pageId, frame_ids: [frameId] })
    const data = await toolJson('set_composition', { page_id: pageId, ops: [{ op: 'set_meta', duration: 6 }] })
    expect(data.storyboard?.pending.map((p) => p.frameId)).toEqual([frameId])
    expect(data.storyboard?.pending.map((p) => p.frameId)).not.toContain(otherId)
  })

  it('never narrows the film to the frames a track already names — one of three animated is not animated', async () => {
    const shot2 = actions.createFrame(
      canvasId,
      { name: 'Shot 3', width: 1000, height: 600, html: SHOT_HTML('Séquence 03'), x: 2400, y: 0 },
      actor(),
      { reveal: false },
    )!.id
    const shot3 = actions.createFrame(
      canvasId,
      { name: 'Shot 4', width: 1000, height: 600, html: SHOT_HTML('Séquence 04'), x: 3600, y: 0 },
      actor(),
      { reveal: false },
    )!.id
    const created = await toolJson('animate_storyboard', { page_id: pageId })
    const target = created.shots.find((s) => s.frameId === frameId)!.targets[0]!.id

    /* one element track on one of the three noted shots: the other two pend */
    const partial = await toolJson('set_composition', {
      page_id: pageId,
      ops: [elementTrack(frameId, target)],
    })
    expect(partial.storyboard?.noted).toBe(3)
    expect(partial.storyboard?.animated).toBe(1)
    expect(partial.storyboard?.pending.map((p) => p.frameId).sort()).toEqual([shot2, shot3].sort())

    /* a whole-body write drops the run's shot memory — the map lives in
       memory, so a server restart is the same — and the scope must not
       shrink to the one frame the track names */
    const rewritten = await toolJson('set_composition', {
      page_id: pageId,
      composition: partial.composition,
    })
    expect(rewritten.storyboard?.pending.map((p) => p.frameId).sort()).toEqual([shot2, shot3].sort())
    expect(rewritten.storyboard?.message).not.toContain('the storyboard is animated')

    const after = await toolJson('set_composition', {
      page_id: pageId,
      ops: [{ op: 'set_meta', duration: 9 }],
    })
    expect(after.storyboard?.pending.map((p) => p.frameId).sort()).toEqual([shot2, shot3].sort())
  })

  it('refuses to hand out ids for a frame still streaming', async () => {
    const streaming = actions.createFrame(
      canvasId,
      { name: 'Live', width: 1000, height: 600, html: SHOT_HTML('En direct'), x: 2400, y: 0 },
      actor(),
      { reveal: true },
    )!
    expect(actions.isFrameStreaming(streaming.id)).toBe(true)
    const data = await toolJson('animate_storyboard', { page_id: pageId, frame_ids: [streaming.id] })
    const shot = data.shots.find((s) => s.frameId === streaming.id)!
    /* the notes are reported, but no fresh id leaves the server before the
       frame carrying it is on disk */
    expect(shot.notes.length).toBeGreaterThan(0)
    expect(shot.notes.every((n) => n.id === undefined)).toBe(true)
    expect(shot.targets).toEqual([])
    expect(store.getFrame(streaming.id)!.html).not.toContain('data-doop-id')
  })

  it('keeps fresh ids to itself when the stamp write fails', async () => {
    mocks.saveFrameNow.mockRejectedValue(new Error('disk full'))
    const data = await toolJson('animate_storyboard', { page_id: pageId, frame_ids: [frameId] })
    const shot = data.shots.find((s) => s.frameId === frameId)!
    expect(shot.notes.every((n) => n.id === undefined)).toBe(true)
    expect(shot.targets).toEqual([])
  })

  it('keeps a frame’s sign-off while stamping ids into it', async () => {
    actions.setFrameApproval(frameId, true, { id: 'u1', name: 'kevin' })
    expect(store.getFrame(frameId)!.approval?.status).toBe('ready_for_dev')
    await toolJson('animate_storyboard', { page_id: pageId, frame_ids: [frameId] })
    expect(store.getFrame(frameId)!.approval?.status).toBe('ready_for_dev')
  })

  it('is idempotent: a second call stamps nothing and writes nothing', async () => {
    const first = await toolJson('animate_storyboard', { page_id: pageId })
    const html = store.getFrame(frameId)!.html
    const writes = mocks.saveFrameNow.mock.calls.length

    const second = await toolJson('animate_storyboard', { page_id: pageId })
    expect(store.getFrame(frameId)!.html).toBe(html)
    expect(mocks.saveFrameNow.mock.calls.length).toBe(writes)
    /* and the agent gets the same ids back, still addressable */
    const before = first.shots.find((s) => s.frameId === frameId)!
    const after = second.shots.find((s) => s.frameId === frameId)!
    expect(after.targets.map((t) => t.id).sort()).toEqual(before.targets.map((t) => t.id).sort())
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

  it('only names mechanisms the motion model really has', () => {
    for (const words of [
      MOTION,
      TOOLS.find((t) => t.name === 'animate_storyboard')!.description,
      en.animatePrompt,
      pt.animatePrompt,
    ]) {
      /* no invented clip kinds: a transition is keyframes across a cut,
         a TODO note lives on a muted caption lane */
      expect(words).not.toMatch(/transition clip/i)
      expect(words).not.toMatch(/TODO marker clip/i)
      expect(words).not.toMatch(/clipes marcadores/i)
    }
  })

  it('the animate kind drives the director tools, not the text on the card', () => {
    /* end_stage and wait_for_job are resident tools; the DIRECTOR briefs
       name the stages the server walks */
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['end_stage', 'wait_for_job']))
    for (const stage of ['plan', 'build', 'refine', 'finish'] as const) {
      expect(DIRECTOR[stage]).toBeTruthy()
    }
    /* and the button's own prompt is still the catalog key — the kind is
       passed by the client, never inferred from card text */
    expect(en.animatePrompt).not.toMatch(/director/i)
  })

  it('frames the notes as intent and a minimum, not a script to execute', () => {
    expect(MOTION).toMatch(/intent and the minimum/i)
    expect(en.animatePrompt).toMatch(/intent and the minimum/i)
    expect(pt.animatePrompt).toMatch(/intenção e o mínimo/i)
    /* and every voice asks the agent to say where it went further */
    expect(en.animatePrompt).toMatch(/went beyond the notes/i)
    expect(pt.animatePrompt).toMatch(/além das notas/i)
  })
})
