import { describe, expect, it } from 'vitest'
import {
  buildGate,
  compositionOutline,
  DIRECTOR_LIMITS,
  directorRunView,
  filmSignature,
  parseAnimateRequest,
  refineStop,
  stageBudgets,
  targetSignature,
  verdict,
  type DirectorRun,
} from '../shared/director.ts'
import { EFFECT_COST_CAP } from '../shared/motionFx.ts'
import type { Composition, MotionKeyframe, MotionTrack } from '../shared/motion.ts'
import type { Canvas, Frame } from '../shared/types.ts'

const kf = (property: string, t: number, value: number | string, id = 'k1'): MotionKeyframe => ({
  id,
  property,
  t,
  value,
  easing: { type: 'linear' },
})

const elementTrack = (id: string, frameId: string, elementId: string, keyframes = [kf('x', 0, 10)]): MotionTrack => ({
  id,
  kind: 'element',
  frameId,
  elementId,
  keyframes,
})

const frameClipTrack = (id: string, frameId: string, start = 0, duration = 3): MotionTrack => ({
  id,
  kind: 'clip',
  clips: [
    {
      id: `${id}-c1`,
      start,
      duration,
      source: { type: 'frame', frameId },
    },
  ],
})

function comp(over: Partial<Composition> = {}): Composition {
  return {
    id: 'c1',
    canvasId: 'cv1',
    pageId: 'p1',
    duration: 6,
    fps: 30,
    width: 1920,
    height: 1080,
    tracks: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    updatedBy: 'kevin',
    ...over,
  }
}

function frame(over: Partial<Frame> = {}): Frame {
  return {
    id: 'f1',
    name: 'Shot 1',
    x: 0,
    y: 0,
    width: 1000,
    height: 600,
    html: '<h1>hello</h1>',
    ...over,
  } as Frame
}

describe('stageBudgets', () => {
  it('grows linearly with shots and stays inside each cap', () => {
    expect(stageBudgets(1, 3)).toEqual({ plan: 9, build: 20, refine: 14, run: 9 + 20 + 14 * 3 })
    expect(stageBudgets(5, 3)).toEqual({ plan: 13, build: 52, refine: 30, run: 13 + 52 + 30 * 3 })
    /* many shots cap each stage */
    const b = stageBudgets(30, 5)
    expect(b.plan).toBe(DIRECTOR_LIMITS.PLAN_CAP)
    expect(b.build).toBe(DIRECTOR_LIMITS.BUILD_CAP)
    expect(b.refine).toBe(DIRECTOR_LIMITS.REFINE_CAP)
    expect(b.run).toBeLessThanOrEqual(DIRECTOR_LIMITS.RUN_CAP)
  })

  it('freedom free multiplies the stage budgets by 1.5 under the caps', () => {
    const base = stageBudgets(5, 3)
    const free = stageBudgets(5, 3, 'free')
    expect(free.plan).toBe(Math.min(Math.ceil(13 * 1.5), DIRECTOR_LIMITS.PLAN_CAP))
    expect(free.build).toBe(Math.min(Math.ceil(52 * 1.5), DIRECTOR_LIMITS.BUILD_CAP))
    expect(free.refine).toBe(Math.min(Math.ceil(30 * 1.5), DIRECTOR_LIMITS.REFINE_CAP))
    expect(free.run).toBeLessThanOrEqual(DIRECTOR_LIMITS.RUN_CAP)
    void base
  })

  it('the run ceiling is plan + build + refine × passes, capped at 300', () => {
    const b = stageBudgets(2, 1)
    expect(b.run).toBe(b.plan + b.build + b.refine)
    expect(stageBudgets(30, 5, 'free').run).toBe(DIRECTOR_LIMITS.RUN_CAP)
  })
})

describe('filmSignature', () => {
  const base = () =>
    comp({
      tracks: [
        frameClipTrack('t-clip', 'f1'),
        elementTrack('t-el', 'f1', 'el-1', [kf('x', 0, 10, 'k-1'), kf('x', 1, 40, 'k-2'), kf('opacity', 0, 0, 'k-3')]),
      ],
    })

  it('is equal for two builds that differ only in regenerated ids (AC-3)', () => {
    const a = base()
    const b = {
      ...base(),
      id: 'c-OTHER',
      tracks: [
        { ...base().tracks[0]!, id: 't-clip-2', clips: [{ ...base().tracks[0]!.clips![0]!, id: 'clip-NEW' }] },
        {
          ...base().tracks[1]!,
          id: 't-el-2',
          keyframes: base().tracks[1]!.keyframes!.map((k, i) => ({ ...k, id: `new-${i}` })),
        },
      ],
    }
    const f = frame()
    expect(filmSignature(a, [f])).toBe(filmSignature(b, [f]))
  })

  it('ignores revision, timestamps, updatedBy and composition id', () => {
    const f = frame()
    const a = base()
    const b = { ...base(), id: 'zzz', revision: 99, createdAt: 5, updatedAt: 9, updatedBy: 'sam' }
    expect(filmSignature(a, [f])).toBe(filmSignature(b, [f]))
  })

  it('changes when a keyframe value, time or easing changes (AC-14)', () => {
    const f = frame()
    const sig = filmSignature(base(), [f])
    const byValue = base()
    byValue.tracks[1]!.keyframes![0] = { ...byValue.tracks[1]!.keyframes![0]!, value: 11 }
    expect(filmSignature(byValue, [f])).not.toBe(sig)
    const byTime = base()
    byTime.tracks[1]!.keyframes![0] = { ...byTime.tracks[1]!.keyframes![0]!, t: 0.5 }
    expect(filmSignature(byTime, [f])).not.toBe(sig)
    const byEasing = base()
    byEasing.tracks[1]!.keyframes![0] = { ...byEasing.tracks[1]!.keyframes![0]!, easing: { type: 'hold' } }
    expect(filmSignature(byEasing, [f])).not.toBe(sig)
  })

  it('changes when an effect param, direction or motionBlur changes (AC-14)', () => {
    const f = frame()
    const withFx = () =>
      comp({
        tracks: [
          {
            ...elementTrack('t-el', 'f1', 'el-1'),
            effects: [{ id: 'fx-1', fx: 'glow', params: { radius: 8 } }],
          },
        ],
      })
    const sig = filmSignature(withFx(), [f])
    const param = withFx()
    param.tracks[0]!.effects![0] = { ...param.tracks[0]!.effects![0]!, params: { radius: 12 } }
    expect(filmSignature(param, [f])).not.toBe(sig)
    /* the same stack under regenerated effect ids keeps the signature —
       fx: lanes rewrite to the effect's index */
    const newIds = withFx()
    newIds.tracks[0]!.effects![0] = { ...newIds.tracks[0]!.effects![0]!, id: 'fx-OTHER' }
    newIds.tracks[0]!.keyframes = [
      { id: 'kf-x', property: 'fx:fx-OTHER.radius', t: 0, value: 8, easing: { type: 'linear' } },
    ]
    const origIds = withFx()
    origIds.tracks[0]!.keyframes = [
      { id: 'kf-x', property: 'fx:fx-1.radius', t: 0, value: 8, easing: { type: 'linear' } },
    ]
    expect(filmSignature(newIds, [f])).toBe(filmSignature(origIds, [f]))

    const dir = { ...withFx(), direction: { treatment: 'slow push', beats: [] } }
    expect(filmSignature(dir, [f])).not.toBe(sig)
    const blur = { ...withFx(), motionBlur: { shutter: 0.5 } }
    expect(filmSignature(blur, [f])).not.toBe(sig)
  })

  it('changes when a shot frame’s html changes (AC-14)', () => {
    const c = comp({ tracks: [frameClipTrack('t-clip', 'f1')] })
    const a = frame({ html: '<h1>hello</h1>' })
    const b = frame({ html: '<h1>goodbye</h1>' })
    expect(filmSignature(c, [a])).not.toBe(filmSignature(c, [b]))
    /* a frame the film does not shoot is not part of the signature */
    const other = frame({ id: 'f2' })
    expect(filmSignature(c, [a, other])).toBe(filmSignature(c, [a]))
  })

  it('keyframe order does not matter; track identity follows kind+frame+element', () => {
    const f = frame()
    const a = comp({
      tracks: [elementTrack('t1', 'f1', 'el-1', [kf('x', 0, 1, 'ka'), kf('y', 2, 3, 'kb')])],
    })
    const b = comp({
      tracks: [elementTrack('t2', 'f1', 'el-1', [kf('y', 2, 3, 'kc'), kf('x', 0, 1, 'kd')])],
    })
    expect(filmSignature(a, [f])).toBe(filmSignature(b, [f]))
  })

  it('is "none" without a composition', () => {
    expect(filmSignature(undefined, [])).toBe('none')
    expect(filmSignature(null, [])).toBe('none')
  })
})

describe('targetSignature', () => {
  const canvas = {
    id: 'cv1',
    pages: [{ id: 'p1', name: 'P', order: 0 }],
    frames: [{ ...frame(), pageId: 'p1' }],
    compositions: [comp({ tracks: [frameClipTrack('t-clip', 'f1')] })],
  } as unknown as Canvas

  it('is the film signature for timeline tools and the frame hash for frame tools', () => {
    const film = targetSignature('set_composition', { page_id: 'p1' }, canvas)
    expect(film).toBe(filmSignature(canvas.compositions?.[0] ?? null, canvas.frames))
    const frameSig = targetSignature('edit_frame_html', { frame_id: 'f1' }, canvas)
    expect(frameSig).not.toBe('')
    expect(frameSig).not.toBe(film)
  })

  it('is empty for reads and fire-and-forget tools', () => {
    expect(targetSignature('get_scene_snapshot', { page_id: 'p1' }, canvas)).toBe('')
    expect(targetSignature('render_composition', { page_id: 'p1' }, canvas)).toBe('')
    expect(targetSignature('blender_render_frame', { page_id: 'p1' }, canvas)).toBe('')
  })
})

describe('buildGate', () => {
  const covered = { frameId: 'f1', animated: true }
  it('passes a covered film with hidden notes and effects in budget', () => {
    expect(
      buildGate({ lintErrors: 0, shots: [covered], notesHidden: true, effectCost: 10, effectCostCap: EFFECT_COST_CAP })
        .pass,
    ).toBe(true)
  })
  it('fails on lint errors, unanimated shots, visible notes and over-budget effects', () => {
    const g = buildGate({
      lintErrors: 2,
      shots: [{ frameId: 'f1', animated: false }],
      notesHidden: false,
      effectCost: EFFECT_COST_CAP + 1,
      effectCostCap: EFFECT_COST_CAP,
    })
    expect(g.pass).toBe(false)
    expect(g.unmet.join('\n')).toContain('lint')
    expect(g.unmet.join('\n')).toContain('f1')
    expect(g.unmet.join('\n')).toContain('notes')
    expect(g.unmet.join('\n')).toContain('effect cost')
  })
  it('a shot skipped with a reason does not block the gate', () => {
    const g = buildGate({
      lintErrors: 0,
      shots: [{ frameId: 'f1', animated: false, skipped: 'intentionally still' }],
      notesHidden: true,
      effectCost: 0,
      effectCostCap: EFFECT_COST_CAP,
    })
    expect(g.pass).toBe(true)
  })
})

describe('refineStop', () => {
  const base = {
    blockers: 1,
    majors: 1,
    meanScore: 3,
    passCount: 1,
    maxPasses: 3,
    signature: 's-new',
    boundaries: ['s-old'],
  }
  it('stops on a repeated film signature — unchanged or A/B/A', () => {
    expect(refineStop({ ...base, signature: 's-old' })).toEqual({ stop: true, reason: 'the pass changed nothing' })
    expect(refineStop({ ...base, signature: 'x', boundaries: ['a', 'x', 'b'] })).toEqual({
      stop: true,
      reason: 'the pass changed nothing',
    })
  })
  it('stops on a clean pass at the threshold', () => {
    expect(refineStop({ ...base, blockers: 0, majors: 0, meanScore: 3.5 })).toEqual({
      stop: true,
      reason: 'clean pass',
    })
    expect(refineStop({ ...base, blockers: 0, majors: 0, meanScore: 3.4 }).stop).toBe(false)
  })
  it('stops when the pass budget is used', () => {
    expect(refineStop({ ...base, passCount: 3 })).toEqual({ stop: true, reason: 'passes used' })
  })
  it('keeps going otherwise', () => {
    expect(refineStop(base).stop).toBe(false)
  })
})

describe('verdict', () => {
  it('stopped first, then failed on no effective write, then lint, then issues', () => {
    expect(verdict({ effectiveWrites: 3, lintErrors: 0, openIssues: [], stopped: true }).status).toBe('stopped')
    expect(verdict({ effectiveWrites: 0, lintErrors: 0, openIssues: [] })).toEqual({
      status: 'failed',
      reason: 'the run made no effective write to the film',
    })
    expect(verdict({ effectiveWrites: 4, lintErrors: 2, openIssues: [] }).status).toBe('failed')
    expect(
      verdict({
        effectiveWrites: 4,
        lintErrors: 0,
        openIssues: [{ stage: 'build', text: 'shot f1: no element motion' }],
      }).status,
    ).toBe('delivered_with_issues')
    expect(verdict({ effectiveWrites: 4, lintErrors: 0, openIssues: [] }).status).toBe('delivered')
  })
})

describe('parseAnimateRequest', () => {
  it('accepts a minimal request — the run defaults mode/freedom/passes', () => {
    const out = parseAnimateRequest({ pageId: 'p1' })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.value.pageId).toBe('p1')
      expect(out.value.mode).toBeUndefined()
      expect(out.value.freedom).toBeUndefined()
      expect(out.value.passes).toBeUndefined()
    }
  })
  it('rejects a missing or empty pageId, bad mode, out-of-range fields', () => {
    for (const bad of [
      {},
      { pageId: '' },
      { pageId: 'p1', mode: 'rewind' },
      { pageId: 'p1', freedom: 'wild' },
      { pageId: 'p1', passes: 0 },
      { pageId: 'p1', passes: 6 },
      { pageId: 'p1', seconds: 0 },
      { pageId: 'p1', seconds: 900 },
      { pageId: 'p1', width: 4 },
      { pageId: 'p1', fps: 0 },
      { pageId: 'p1', note: 'x'.repeat(1001) },
      'nope',
      null,
    ]) {
      expect(parseAnimateRequest(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })
  it('accepts the full payload', () => {
    const out = parseAnimateRequest({
      pageId: 'p1',
      mode: 'refine',
      seconds: 12,
      width: 1280,
      height: 720,
      fps: 24,
      passes: 5,
      freedom: 'free',
      frameIds: ['f1', 'f2'],
      paid: { enabled: true, maxCalls: 4 },
      note: 'gentle',
      parentRunId: 'dir-1',
    })
    expect(out.ok).toBe(true)
  })
})

describe('compositionOutline', () => {
  it('summarises shots, lanes and effects under 6 KB', () => {
    const c = comp({
      duration: 6,
      tracks: [
        frameClipTrack('t-clip', 'f1', 0, 3),
        frameClipTrack('t-clip2', 'f2', 3, 3),
        elementTrack('t-el', 'f1', 'el-1', [kf('x', 0, 1), kf('x', 1, 2), kf('opacity', 0, 0)]),
        {
          ...elementTrack('t-el2', 'f2', 'el-9'),
          effects: [{ id: 'e1', fx: 'glow', params: {} }],
        },
      ],
    })
    const out = compositionOutline(c)
    expect(out).toContain('film 6s')
    expect(out).toContain('shot 0–3 frame f1')
    expect(out).toContain('shot 3–6 frame f2')
    expect(out).toContain('el-1')
    expect(out).toContain('x×2')
    expect(out).toContain('fx glow')
    expect(out.length).toBeLessThanOrEqual(6_100)
    expect(compositionOutline(null)).toBe('(no film yet)')
  })
})

describe('directorRunView', () => {
  it('drops the ledger and internal write-tracking fields', () => {
    const run = {
      id: 'dir-1',
      canvasId: 'cv',
      pageId: 'p',
      taskId: 't',
      ownerId: 'o',
      agent: 'a',
      mode: 'fresh',
      status: 'running',
      stage: 'build',
      pass: 0,
      maxPasses: 3,
      budgets: { plan: 9, build: 20, refine: 14, run: 71 },
      spent: { calls: 3, inputTokens: 100, activeMs: 5, byStage: { plan: 1, build: 2, refine: [], finish: 0 } },
      passes: [],
      openIssues: [],
      startSig: 'none',
      effectiveWrites: 0,
      startedAt: 1,
      ledger: [{ tool: 'x' }],
      lastWrittenRevision: 7,
      skippedShots: { f1: 'still' },
    } as unknown as DirectorRun
    const view = directorRunView(run)
    expect(view.id).toBe('dir-1')
    expect('ledger' in view).toBe(false)
    expect('lastWrittenRevision' in view).toBe(false)
    expect('skippedShots' in view).toBe(false)
  })
})
