import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame } from '../shared/types.ts'
import type { Composition } from '../shared/motion.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveCanvas: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  saveFrameVersion: () => {},
  saveDecision: () => {},
  deleteFrame: () => {},
  listFrameRunIds: async () => [],
  saveRenderJob: () => {},
  deleteRenderJob: () => {},
  savePageCopy: async () => {},
}))
vi.mock('../server/db/index.ts', () => ({ db: {} }))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const { createRenderJob, getRenderJob } = await import('../server/motionJobs.ts')
const { zipStore } = await import('../server/motionRender.ts')
const { compositionToHyperframes, compositionToLottie, hyperframesToTracks, lottieToTracks, HYPERFRAMES_FORMAT } =
  await import('../shared/motionInterchange.ts')
const { DuelInputError, duelDeps, pickDuel, startMotionDuel } = await import('../server/duels.ts')
const { store } = await import('../server/store.ts')
const actions = await import('../server/actions.ts')

afterEach(() => vi.restoreAllMocks())

const COMP: Composition = {
  id: 'comp1',
  canvasId: 'c1',
  pageId: 'p1',
  duration: 10,
  fps: 30,
  width: 1280,
  height: 720,
  tracks: [
    {
      id: 't1',
      kind: 'element',
      frameId: 'f1',
      elementId: 'el-hero',
      keyframes: [
        { id: 'k1', property: 'x', t: 0, value: 0, easing: { type: 'linear' } },
        { id: 'k2', property: 'x', t: 2, value: 400, easing: { type: 'linear' } },
        { id: 'k3', property: 'y', t: 0, value: 10, easing: { type: 'linear' } },
        { id: 'k4', property: 'y', t: 2, value: 90, easing: { type: 'linear' } },
        { id: 'k5', property: 'scale', t: 0, value: 1, easing: { type: 'linear' } },
        { id: 'k6', property: 'scale', t: 2, value: 2, easing: { type: 'linear' } },
        { id: 'k7', property: 'rotate', t: 0, value: 0, easing: { type: 'linear' } },
        { id: 'k8', property: 'rotate', t: 2, value: 45, easing: { type: 'linear' } },
        { id: 'k9', property: 'opacity', t: 0, value: 1, easing: { type: 'linear' } },
        { id: 'k10', property: 'opacity', t: 2, value: 0.5, easing: { type: 'linear' } },
      ],
    },
  ],
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'test',
}

const by = { id: 'u1', name: 'Owner' }

describe('server render caps', () => {
  /* render jobs live in module state: each call gets its own canvas+account */
  let seq = 0
  const job = (extra: Record<string, unknown> = {}) => {
    const n = ++seq
    return createRenderJob({
      composition: { ...COMP, id: `comp-${n}`, canvasId: `c-cap-${n}` },
      format: 'webm',
      target: 'server',
      by: { id: `u-cap-${n}`, name: 'Capped' },
      ...extra,
    })
  }

  it('keeps mp4 and gif off the server target', () => {
    for (const format of ['mp4', 'gif']) {
      const bad = job({ format })
      expect(bad.ok).toBe(false)
      if (!bad.ok) expect(bad.error).toMatch(/webm or pngseq/)
    }
    expect(job({ format: 'pngseq' }).ok).toBe(true)
  })

  it('caps the range at 60 seconds, the raster at 1080p and the rate at 30 fps', () => {
    const long = job({ range: { start: 0, end: 61 } })
    expect(long.ok).toBe(false)
    const wide = job({ width: 2560 })
    expect(wide.ok).toBe(false)
    const tall = job({ height: 1440 })
    expect(tall.ok).toBe(false)
    const fast = job({ fps: 60 })
    expect(fast.ok).toBe(false)
    const fine = job({ width: 1920, height: 1080, fps: 30, range: { start: 0, end: 60 } })
    expect(fine.ok).toBe(true)
  })

  it('allows one open server render per account, then 429s', () => {
    const n = ++seq
    const account = { id: `u-cap-${n}`, name: 'Capped' }
    const comp = { ...COMP, id: `comp-${n}`, canvasId: `c-cap-${n}` }
    const mine = (extra: Record<string, unknown> = {}) =>
      createRenderJob({ composition: comp, format: 'webm', target: 'server', by: account, ...extra })
    const first = mine()
    expect(first.ok).toBe(true)
    const second = mine()
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.status).toBe(429)
      expect(second.error).toMatch(/one server render/)
    }
    /* another account is unaffected */
    expect(job().ok).toBe(true)
    /* a finished job frees the slot */
    const done = getRenderJob(first.ok ? first.job.id : '')!
    done.status = 'done'
    expect(mine().ok).toBe(true)
  })

  it('takes an engine only on the blender target', () => {
    const comp = { ...COMP, id: 'comp-blender', canvasId: 'c-blender' }
    const noEngine = createRenderJob({ composition: comp, format: 'webm', target: 'server', engine: 'eevee', by })
    expect(noEngine.ok).toBe(false)
    const bad = createRenderJob({ composition: comp, format: 'webm', target: 'blender', engine: 'vray', by })
    expect(bad.ok).toBe(false)
    const ok = createRenderJob({ composition: comp, format: 'pngseq', target: 'blender', engine: 'cycles', by })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.job.engine).toBe('cycles')
    const defaulted = createRenderJob({ composition: comp, format: 'pngseq', target: 'blender', by })
    expect(defaulted.ok && defaulted.job.engine === 'eevee').toBe(true)
  })
})

describe('zipStore', () => {
  it('writes a stored zip a reader can open', async () => {
    const buf = zipStore([
      { name: 'frame-0.png', data: Buffer.from('png-one') },
      { name: 'frame-1.png', data: Buffer.from('png-two') },
    ])
    expect(buf.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04')
    /* end-of-central-directory record closes the archive */
    expect(buf.subarray(-22, -18).toString('latin1')).toBe('PK\x05\x06')
    expect(buf.includes(Buffer.from('frame-0.png'))).toBe(true)
    expect(buf.includes(Buffer.from('png-two'))).toBe(true)
  })
})

describe('lottie interchange', () => {
  it('round-trips the transform subset', () => {
    const doc = compositionToLottie(COMP)
    expect(doc.fr).toBe(30)
    expect(doc.w).toBe(1280)
    const layers = doc.layers as { nm: string; ks: Record<string, { k: { t: number; s: unknown }[] }> }[]
    expect(layers).toHaveLength(1)
    expect(layers[0]!.nm).toBe('f1/el-hero')
    /* lottie times are frames, opacity is percent */
    const pos = layers[0]!.ks.p!
    expect(pos.k).toHaveLength(2)
    expect(pos.k[1]!.t).toBe(60)
    expect(pos.k[1]!.s).toEqual([400, 90, 0])
    expect(layers[0]!.ks.o!.k[1]!.s).toEqual([50])

    const back = lottieToTracks(doc, 30)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    const track = back.tracks[0]!
    expect(track.frameId).toBe('f1')
    expect(track.elementId).toBe('el-hero')
    const byProp = (p: string) => track.keyframes!.filter((k) => k.property === p)
    expect(byProp('x').map((k) => k.value)).toEqual([0, 400])
    expect(byProp('scaleX').map((k) => k.value)).toEqual([1, 2])
    expect(byProp('rotate').map((k) => k.value)).toEqual([0, 45])
    expect(byProp('opacity').map((k) => k.value)).toEqual([1, 0.5])
    expect(byProp('x')[1]!.t).toBe(2)
  })

  it('rejects what is not a lottie document', () => {
    expect(lottieToTracks(null, 30).ok).toBe(false)
    expect(lottieToTracks({ v: '5.9.0' }, 30).ok).toBe(false)
  })
})

describe('hyperframes interchange', () => {
  it('round-trips tracks, keyframes and clips', () => {
    const doc = compositionToHyperframes(COMP)
    expect(doc.format).toBe(HYPERFRAMES_FORMAT)
    const back = hyperframesToTracks(doc)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.tracks).toHaveLength(1)
    const track = back.tracks[0]!
    expect(track.frameId).toBe('f1')
    expect(track.elementId).toBe('el-hero')
    expect(track.keyframes).toHaveLength(10)
    expect(track.keyframes!.find((k) => k.property === 'rotate' && k.t === 2)!.value).toBe(45)
  })

  it('rejects a wrong format and a malformed keyframe', () => {
    expect(hyperframesToTracks({ format: 'other' }).ok).toBe(false)
    expect(
      hyperframesToTracks({
        format: HYPERFRAMES_FORMAT,
        scene: { layers: [{ keyframes: [{ t: 'later', prop: 'x', v: 1 }] }] },
      }).ok,
    ).toBe(false)
  })
})

describe('motion duel', () => {
  const FRAME: Frame = {
    id: 'f1',
    canvasId: 'c-duel',
    pageId: 'p1',
    name: 'Storyboard',
    html: '<div>story</div>',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  } as Frame
  const CANVAS: Canvas = {
    id: 'c-duel',
    name: 'Duel',
    ownerId: 'o',
    createdAt: 0,
    updatedAt: 0,
    pages: [{ id: 'p1', name: 'Storyboard' }],
    frames: [FRAME, { ...FRAME, id: 'f2', name: 'Beat 2', x: 900 }],
  }
  const human = actions.resolveActor({ name: 'Vera', kind: 'user' })
  const picks = [
    { provider: 'openai-key' as const, model: 'gpt-5' },
    { provider: 'claude-local' as const, model: 'opus' },
  ]

  it('copies the storyboard once per pick and scopes each card to its copy', async () => {
    store.init([structuredClone(CANVAS)])
    vi.spyOn(duelDeps, 'insert').mockResolvedValue()
    const duel = await startMotionDuel({
      canvasId: 'c-duel',
      pageId: 'p1',
      brief: 'Animate it',
      picks,
      actor: human,
      userId: 'u1',
    })
    expect(duel.kind).toBe('motion')
    expect(duel.entries).toHaveLength(2)
    const pages = store.getCanvas('c-duel')!.pages!
    /* the source plus one copy per pick */
    expect(pages).toHaveLength(3)
    const cards = actions.getTasks('c-duel')
    for (const entry of duel.entries) {
      expect(entry.pageId).not.toBe('p1')
      const card = cards.find((c) => c.id === entry.cardId)!
      expect(card.scope).toEqual({ frameId: entry.frameId })
      expect(store.getFrame(entry.frameId)!.pageId).toBe(entry.pageId)
      expect(card.status).toMatch(/entry [AB]/)
      /* each copy's frames are the copy's own */
      const copyFrames = store.getCanvas('c-duel')!.frames.filter((f) => f.pageId === entry.pageId)
      expect(copyFrames).toHaveLength(2)
    }
    expect(duel.entries[0]!.pageId).not.toBe(duel.entries[1]!.pageId)
  })

  it('needs a page on the canvas', async () => {
    store.init([structuredClone(CANVAS)])
    await expect(
      startMotionDuel({ canvasId: 'c-duel', pageId: 'nope', brief: 'x', picks, actor: human, userId: 'u1' }),
    ).rejects.toBeInstanceOf(DuelInputError)
  })

  it('picking a winner archives every frame of the losing pages', async () => {
    store.init([structuredClone(CANVAS)])
    vi.spyOn(duelDeps, 'insert').mockResolvedValue()
    vi.spyOn(duelDeps, 'update').mockResolvedValue()
    vi.spyOn(duelDeps, 'get').mockImplementation(((_c: string, id: string) => Promise.resolve([duelRow(id)])) as never)
    vi.spyOn(duelDeps, 'frameRuns').mockResolvedValue([])
    const duel = await startMotionDuel({
      canvasId: 'c-duel',
      pageId: 'p1',
      brief: 'Animate it',
      picks,
      actor: human,
      userId: 'u1',
    })
    const [winner, loser] = duel.entries
    const view = await pickDuel('c-duel', duel.id, winner!.frameId, human)
    expect(view!.pickedFrameId).toBe(winner!.frameId)
    const frames = store.getCanvas('c-duel')!.frames
    expect(frames.filter((f) => f.pageId === winner!.pageId).every((f) => !f.hidden)).toBe(true)
    expect(frames.filter((f) => f.pageId === loser!.pageId).every((f) => f.hidden)).toBe(true)
    expect(frames.filter((f) => f.pageId === 'p1').every((f) => !f.hidden)).toBe(true)

    function duelRow(id: string) {
      return {
        id,
        canvasId: 'c-duel',
        brief: 'Animate it',
        kind: 'motion',
        createdBy: 'Vera',
        createdAt: Date.now(),
        entries: duel.entries,
        pickedFrameId: null,
        decidedAt: null,
      }
    }
  })
})
