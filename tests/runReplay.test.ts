import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, FrameVersionInfo } from '../shared/types.ts'

vi.mock('../server/db/persist.ts', () => ({
  saveFrame: () => {},
  saveCanvas: () => {},
  saveActivity: () => {},
  saveTask: () => {},
  saveFrameVersion: () => {},
  listRunActivity: async () => [],
  listRunFrameIds: async () => [],
  listFrameVersions: async () => [],
  deleteFrame: () => {},
}))
vi.mock('../server/db/index.ts', () => ({ db: {} }))
vi.mock('../server/resident.ts', () => ({ onFeedback: () => {} }))
vi.mock('../server/distill.ts', () => ({ onDecision: () => {} }))

const { frameChange } = await import('../shared/runReplay.ts')
const { replayDeps, runTimeline } = await import('../server/runReplay.ts')
const { store } = await import('../server/store.ts')

const version = (id: string, savedAt: number, runId?: string): FrameVersionInfo => ({
  id,
  frameId: 'f1',
  canvasId: 'c1',
  width: 400,
  height: 300,
  savedBy: 'x',
  savedAt,
  htmlBytes: 10,
  ...(runId ? { runId } : {}),
})

afterEach(() => vi.restoreAllMocks())

describe('frameChange', () => {
  const frame = { id: 'f1', name: 'Hero', exists: true }

  it('finds the state before the run and sees the live frame as its result', () => {
    const change = frameChange('r1', frame, [version('v0', 10), version('v1', 20, 'r1'), version('v2', 30, 'r1')], 25)
    expect(change).toMatchObject({ created: false, beforeVersionId: 'v1', editedSince: false })
    expect(change.afterVersionId).toBeUndefined()
  })

  it('marks a frame written over since, with the version holding the run’s result', () => {
    const change = frameChange('r1', frame, [version('v1', 20, 'r1'), version('v2', 40, 'r2')], 25)
    expect(change).toMatchObject({ beforeVersionId: 'v1', afterVersionId: 'v2', editedSince: true })
  })

  it('treats a frame with no row of the run’s own as created by it', () => {
    expect(frameChange('r1', frame, [], 25)).toMatchObject({ created: true, editedSince: false })
    expect(frameChange('r1', frame, [version('v9', 30)], 25)).toMatchObject({
      created: true,
      afterVersionId: 'v9',
      editedSince: true,
    })
  })
})

describe('runTimeline', () => {
  const canvas: Canvas = {
    id: 'c1',
    name: 'Replay',
    ownerId: 'o',
    createdAt: 0,
    updatedAt: 0,
    frames: [
      { id: 'f1', canvasId: 'c1', name: 'Hero', html: '<p>now</p>', x: 0, y: 0, width: 400, height: 300 } as never,
      { id: 'f2', canvasId: 'c1', name: 'Pricing', html: '<p>new</p>', x: 0, y: 0, width: 400, height: 300 } as never,
    ],
  }

  it('joins the run’s activity, its versioned frames and the frames it created', async () => {
    store.init([structuredClone(canvas)])
    vi.spyOn(replayDeps, 'run').mockResolvedValue(undefined)
    vi.spyOn(replayDeps, 'activity').mockResolvedValue([
      {
        id: 'a1',
        canvasId: 'c1',
        actorName: 'Doop',
        actorKind: 'agent',
        actorColor: '#000',
        message: 'created frame “Pricing”',
        frameId: 'f2',
        at: 5,
        runId: 'r1',
      },
    ])
    vi.spyOn(replayDeps, 'versionedFrames').mockResolvedValue([{ frameId: 'f1', canvasId: 'c1' }])
    vi.spyOn(replayDeps, 'versions').mockImplementation(async (frameId) =>
      frameId === 'f1' ? [version('v1', 3, 'r1')] : [],
    )
    const timeline = await runTimeline('c1', 'r1')
    expect(timeline?.events.map((e) => e.message)).toEqual(['created frame “Pricing”'])
    expect(timeline?.frames).toEqual([
      expect.objectContaining({ frameId: 'f1', name: 'Hero', created: false, beforeVersionId: 'v1' }),
      expect.objectContaining({ frameId: 'f2', name: 'Pricing', created: true }),
    ])
    /* another canvas never sees it */
    expect(await runTimeline('c2', 'r1')).toBeUndefined()
  })

  it('is undefined for a run that left nothing', async () => {
    vi.spyOn(replayDeps, 'run').mockResolvedValue(undefined)
    expect(await runTimeline('c1', 'nope')).toBeUndefined()
  })
})
