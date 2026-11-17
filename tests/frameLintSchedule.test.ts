// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lintDocKey } from '../shared/lintDocument'
import { SLOP_RULES_VERSION, type FrameLint } from '../shared/slopRules'
import type { Frame } from '../shared/types'

/* When the editor scores a frame: every real change of the document (an own
   save, someone else's edit, a resize) is scored once, and nothing else is
   (opening a current frame, the server's echo of an own save, the verdict
   this tab wrote coming back, another tab's verdict). */

const frames: Frame[] = []
const setFrameLint = vi.fn(async (_frameId: string, _lint: FrameLint | undefined) => ({}))

vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))
vi.mock('../src/lib/frameBridge', () => ({ slopSnapshotOf: vi.fn(async () => ({})) }))
vi.mock('../src/lib/api', () => ({ api: { setFrameLint } }))
vi.mock('../shared/slopRules', async (original) => ({
  ...(await original<typeof import('../shared/slopRules')>()),
  lintSnapshot: () => ({
    score: 40,
    errors: 9,
    warnings: 0,
    issues: [],
    checkedAt: Date.now(),
    version: SLOP_RULES_VERSION,
    engine: 'dom' as const,
  }),
}))
vi.mock('../src/lib/store', () => ({
  useStore: {
    getState: () => ({
      canvas: { frames },
      patchFrameLocal: (id: string, patch: Partial<Frame>) => {
        const i = frames.findIndex((f) => f.id === id)
        if (i >= 0) frames[i] = { ...frames[i]!, ...patch }
      },
    }),
  },
}))

const { scheduleFrameLint } = await import('../src/lib/frameLint')

const verdictOf = (frame: Pick<Frame, 'html' | 'width' | 'height'>): FrameLint => ({
  score: 100,
  errors: 0,
  warnings: 0,
  issues: [],
  checkedAt: 2_000,
  version: SLOP_RULES_VERSION,
  engine: 'dom',
  doc: lintDocKey(frame),
})

let nextId = 0
function addFrame(over: Partial<Frame> = {}): Frame {
  const base = { html: '<p>one</p>', width: 1440, height: 900 }
  const frame = {
    id: `f${nextId++}`,
    canvasId: 'c',
    name: 'Frame',
    x: 0,
    y: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...base,
    lint: verdictOf(base),
    ...over,
  } as Frame
  frames.push(frame)
  return frame
}

/* a store write: the frame object is replaced, as patchFrameLocal does */
function write(frame: Frame, patch: Partial<Frame>): Frame {
  const i = frames.findIndex((f) => f.id === frame.id)
  const next = { ...frames[i]!, ...patch }
  frames[i] = next
  return next
}

const settle = () => vi.advanceTimersByTimeAsync(5_000)

beforeEach(() => {
  vi.useFakeTimers()
  frames.length = 0
  setFrameLint.mockClear()
})

describe('scheduleFrameLint', () => {
  it('does not score a frame whose stored verdict covers it', async () => {
    scheduleFrameLint(addFrame())
    await settle()
    expect(setFrameLint).not.toHaveBeenCalled()
  })

  it('scores an own edit once: the optimistic html, then the server echo', async () => {
    let frame = addFrame()
    scheduleFrameLint(frame)
    /* the save patches { html } only: old updatedAt, old verdict */
    frame = write(frame, { html: '<p style="font-size:6px">two</p>' })
    scheduleFrameLint(frame)
    /* the echo: the server's updatedAt, still the old verdict */
    frame = write(frame, { updatedAt: 5_000 })
    scheduleFrameLint(frame)
    await settle()
    expect(setFrameLint).toHaveBeenCalledTimes(1)
    expect(setFrameLint.mock.calls[0]![1]!.doc).toBe(lintDocKey(frame))
    /* the echo landing after the pass is not scored again either */
    scheduleFrameLint(write(frame, { updatedAt: 6_000 }))
    await settle()
    expect(setFrameLint).toHaveBeenCalledTimes(1)
  })

  it('scores every own edit, not every other one', async () => {
    let frame = addFrame()
    for (const html of ['<p>two</p>', '<p>three</p>', '<p>four</p>']) {
      frame = write(frame, { html })
      scheduleFrameLint(frame)
      await settle()
      frame = write(frame, { updatedAt: frame.updatedAt + 1_000 })
      scheduleFrameLint(frame)
      await settle()
    }
    expect(setFrameLint).toHaveBeenCalledTimes(3)
  })

  it('scores a resize that keeps the html', async () => {
    let frame = addFrame()
    scheduleFrameLint(frame)
    frame = write(frame, { width: 320, updatedAt: 6_000 })
    scheduleFrameLint(frame)
    await settle()
    expect(setFrameLint).toHaveBeenCalledTimes(1)
    expect(setFrameLint.mock.calls[0]![1]!.doc).toBe(lintDocKey({ ...frame, width: 320 }))
  })

  it('scores a remote edit once', async () => {
    let frame = addFrame()
    scheduleFrameLint(frame)
    frame = write(frame, { html: '<p>theirs</p>', updatedAt: 7_000 })
    scheduleFrameLint(frame)
    scheduleFrameLint({ ...frame })
    await settle()
    expect(setFrameLint).toHaveBeenCalledTimes(1)
  })

  it('does not score again the verdict this tab wrote coming back as frame:lint', async () => {
    let frame = addFrame({ lint: undefined })
    scheduleFrameLint(frame)
    await settle()
    expect(setFrameLint).toHaveBeenCalledTimes(1)
    const written = setFrameLint.mock.calls[0]![1]!
    frame = write(frame, { lint: { ...written, checkedAt: written.checkedAt - 1 } })
    scheduleFrameLint(frame)
    await settle()
    expect(setFrameLint).toHaveBeenCalledTimes(1)
  })

  it('takes another tab’s verdict of the same document and stops its own pass', async () => {
    let frame = addFrame()
    frame = write(frame, { html: '<p>shared edit</p>', updatedAt: 8_000 })
    scheduleFrameLint(frame)
    /* the other tab scored it first: its frame:lint lands before our debounce */
    frame = write(frame, { lint: verdictOf(frame) })
    scheduleFrameLint(frame)
    await settle()
    expect(setFrameLint).not.toHaveBeenCalled()
  })

  it('settles with two tabs: each verdict arriving at the other starts nothing', async () => {
    let frame = addFrame({ lint: undefined })
    scheduleFrameLint(frame)
    await settle()
    expect(setFrameLint).toHaveBeenCalledTimes(1)
    /* the other tab's verdict for the same document, a different score */
    for (let i = 0; i < 3; i++) {
      frame = write(frame, { lint: { ...verdictOf(frame), score: 50 + i, checkedAt: 9_000 + i } })
      scheduleFrameLint(frame)
      await settle()
    }
    expect(setFrameLint).toHaveBeenCalledTimes(1)
  })
})
